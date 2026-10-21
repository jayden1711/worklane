// Signed receipts (#717, docs/design.md §5a): each merge decision and merge result an instance's event log records
// becomes a statement in canonical JSON, signed with ed25519 in a DSSE envelope and chained by hash, so anyone holding
// the chain's public key can verify it offline: nothing changed, dropped or reordered, every receipt by the chain's
// key. Not the claims receipts (src/receipts.ts). Pure: no files, no network; src/signed-receipts-store.ts reads the
// log and writes the receipts file.
import { createHash, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { BRAND } from './brand.js';
import { redact } from './events/redact.js';
import { EventSchemas, type EventPayload } from './events/types.js';

/** The statement's schema and version: a verifier refuses any other (a new field is a new version). */
export const RECEIPT_SCHEMA = `${BRAND.cli}.receipt/v1`;
/** The DSSE payload type every receipt is signed under (part of what the signature covers). */
export const PAYLOAD_TYPE = `application/vnd.${BRAND.cli}.receipt+json`;

export class ReceiptError extends Error {}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{7,64}$/);
const positive = z.number().int().positive();
const chainFields = { schema: z.literal(RECEIPT_SCHEMA), seq: z.number().int().min(0), prev: hex64.nullable(), at: z.string().min(1) };
const KeyRef = z.strictObject({ keyid: hex64, spki: z.string().min(1) });
/** The event a receipt stands for: the actor the log names, and the event's id there. */
const eventFields = { instance: z.string(), event: positive };

/**
 * One receipt's statement. INVARIANT: a field the deciding engine didn't record is null, never filled in afterwards
 * from somewhere else: `policy.commit`, `inputs.files`, `inputs.check_runs` and `decision.level` are null until the
 * merge record carries them (#717 step 1), so a receipt never claims more than the log said at the time.
 */
const StatementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...chainFields, kind: z.literal('chain.started'), key: KeyRef }),
  z.strictObject({ ...chainFields, kind: z.literal('key.rotated'), next: KeyRef }),
  z.strictObject({
    ...chainFields,
    ...eventFields,
    kind: z.literal('merge.decided'),
    /** The version the coordinator that wrote the decision announced at its start (coordinator.started). */
    engine: z.strictObject({ version: z.string().nullable() }),
    policy: z.strictObject({ commit: commit.nullable() }),
    inputs: z.strictObject({
      issue: positive,
      pr: positive,
      head: commit,
      files: z.array(z.string()).nullable(),
      check_runs: z.array(z.strictObject({ name: z.string(), id: positive })).nullable(),
    }),
    decision: z.strictObject({ auto: z.boolean(), level: z.string().nullable(), reasons: z.array(z.string()), why: z.array(z.strictObject({ category: z.string(), text: z.string() })) }),
  }),
  z.strictObject({
    ...chainFields,
    ...eventFields,
    kind: z.literal('merge.result'),
    issue: positive,
    pr: positive,
    head: commit,
    merged: z.boolean(),
    /** The merge commit, when it merged. */
    commit: commit.nullable(),
    /** Found merged after the fact (the reconciler), not merged by this decision path. */
    reconciled: z.boolean(),
    /** Why it didn't merge, redacted. */
    why: z.string().nullable(),
    /** The id of the chain's latest merge.decided receipt for this PR head, or null when the chain has none. */
    decision: hex64.nullable(),
  }),
]);
export type Statement = z.infer<typeof StatementSchema>;
type Body = Statement extends infer S ? (S extends Statement ? Omit<S, 'schema' | 'seq' | 'prev'> : never) : never;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** A DSSE envelope (github.com/secure-systems-lab/dsse), with exactly one signature in this version. */
const EnvelopeSchema = z.strictObject({ payloadType: z.string(), payload: base64, signatures: z.array(z.strictObject({ keyid: z.string(), sig: base64 })).length(1) });
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** An event as the log stores it (src/events/log.ts), of the kinds receipts read. */
export interface ReceiptEvent {
  id: number;
  ts: string;
  type: string;
  actor: string;
  payload: unknown;
}
/** The event kinds a receipt is made from, and coordinator.started for the engine version. */
export const RECEIPT_EVENTS = ['coordinator.started', 'merge.decided', 'merge.done', 'merge.failed'] as const;

/** Who signs: the seam a root-owned signer fills (docs/design.md §5a); in this slice, a key file's holder. */
export interface ReceiptSigner {
  readonly publicKey: KeyObject;
  sign(data: Buffer): Buffer;
}

/** A signer over an ed25519 private key held in this process. */
export function keySigner(privateKey: KeyObject): ReceiptSigner {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new ReceiptError('a receipt key is an ed25519 private key');
  return { publicKey: createPublicKey(privateKey), sign: (data) => edSign(null, data, privateKey) };
}

/**
 * Canonical JSON (RFC 8785 for the values receipts hold): keys sorted by UTF-16 code unit, no whitespace, strings as
 * JSON.stringify writes them, integers only. Anything else throws, so the bytes signed are one function of the value.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new ReceiptError(`canonical JSON here holds integers only, not ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new ReceiptError(`canonical JSON can't hold a ${typeof v}`);
}

/** DSSE's pre-authentication encoding: what is signed (the payload type and payload, length-prefixed). */
export function pae(type: string, body: Buffer): Buffer {
  const t = Buffer.from(type, 'utf8');
  return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `, 'utf8'), t, Buffer.from(` ${body.length} `, 'utf8'), body]);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const spkiOf = (k: KeyObject) => k.export({ type: 'spki', format: 'der' });

/** A public key's id: the SHA-256 of its SPKI DER, hex. */
export function keyId(publicKey: KeyObject): string {
  return sha256(spkiOf(publicKey));
}

const keyRef = (k: KeyObject) => ({ keyid: keyId(k), spki: spkiOf(k).toString('base64') });

/** The ed25519 public key a statement names, or null when it is unreadable or its id doesn't match it. */
function keyOfRef(ref: { keyid: string; spki: string }): KeyObject | null {
  try {
    const k = createPublicKey({ key: Buffer.from(ref.spki, 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'ed25519' && keyId(k) === ref.keyid ? k : null;
  } catch {
    return null;
  }
}

/** A receipt's statement, decoded and unchecked: for looking at one, never for trusting it (verifyChain does that). */
export function statementOf(env: Envelope): unknown {
  return JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
}

function seal(st: Statement, signer: ReceiptSigner): { envelope: Envelope; id: string } {
  const bytes = Buffer.from(canonicalJson(StatementSchema.parse(st)), 'utf8');
  const sig = signer.sign(pae(PAYLOAD_TYPE, bytes)).toString('base64');
  return { envelope: { payloadType: PAYLOAD_TYPE, payload: bytes.toString('base64'), signatures: [{ keyid: keyId(signer.publicKey), sig }] }, id: sha256(bytes) };
}

export type ChainResult =
  | {
      ok: true;
      count: number;
      /** The last receipt's id (the SHA-256 of its payload): an auditor keeps it as the next look's anchor. */
      head: string | null;
      ids: string[];
      /** The chain's keys, in order: the one that started it, then each it was rotated to. */
      keys: string[];
      statements: Statement[];
    }
  | { ok: false; index: number; problem: string };

/**
 * Verify a chain of receipts, in order. `keys`: the public keys the auditor trusts to have started the chain (each
 * rotation after that is signed by the key before it), or 'chain' to trust the key the first receipt declares (the
 * signer checking its own file before it extends it). `anchor`: a receipt id the chain must still hold (a head kept
 * from an earlier look), the one way to see a dropped tail. Fails at the first receipt that doesn't hold.
 */
export function verifyChain(envelopes: readonly unknown[], o: { keys: readonly KeyObject[] | 'chain'; anchor?: string }): ChainResult {
  const fail = (index: number, problem: string): ChainResult => ({ ok: false, index, problem });
  let trusted: Map<string, KeyObject> | null = null;
  if (o.keys !== 'chain') {
    if (!o.keys.length) return fail(0, 'no public key given to verify against');
    if (o.keys.some((k) => k.type !== 'public' || k.asymmetricKeyType !== 'ed25519')) return fail(0, 'a key given to verify against is not an ed25519 public key');
    trusted = new Map(o.keys.map((k) => [keyId(k), k]));
    if (!envelopes.length) return fail(0, 'no receipts');
  }
  let current: KeyObject | null = null;
  let prev: string | null = null;
  let lastEvent = 0;
  const ids: string[] = [];
  const keys: string[] = [];
  const statements: Statement[] = [];
  const decided = new Map<string, string>();
  for (const [i, raw] of envelopes.entries()) {
    const env = EnvelopeSchema.safeParse(raw);
    if (!env.success) return fail(i, 'not a receipt envelope');
    const { payloadType, payload, signatures } = env.data;
    if (payloadType !== PAYLOAD_TYPE) return fail(i, `its payload type is ${JSON.stringify(payloadType).slice(0, 80)}, not ${PAYLOAD_TYPE}`);
    const bytes = Buffer.from(payload, 'base64');
    const sig = Buffer.from(signatures[0]!.sig, 'base64');
    if (bytes.toString('base64') !== payload || sig.toString('base64') !== signatures[0]!.sig) return fail(i, 'its payload or signature is not canonical base64');
    let parsed: unknown;
    let canonical = '';
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
      canonical = canonicalJson(parsed);
    } catch {
      return fail(i, 'its payload is not canonical JSON');
    }
    if (!Buffer.from(canonical, 'utf8').equals(bytes)) return fail(i, 'its payload is not canonical JSON');
    const schema = (parsed as { schema?: unknown } | null)?.schema;
    if (schema !== RECEIPT_SCHEMA) return fail(i, `its schema is ${JSON.stringify(schema ?? null).slice(0, 80)}; this verifier reads ${RECEIPT_SCHEMA} only`);
    const st = StatementSchema.safeParse(parsed);
    if (!st.success) return fail(i, `not a valid receipt (${st.error.issues[0]?.path.join('.') || 'its kind'}: ${st.error.issues[0]?.message ?? 'invalid'})`);
    const s = st.data;
    if (i === 0) {
      if (s.kind !== 'chain.started') return fail(0, 'the first receipt does not start the chain: one before it was dropped, or they were reordered');
      const declared = keyOfRef(s.key);
      if (!declared) return fail(0, "the chain's start key is unreadable, or isn't the key its id names");
      if (trusted && !trusted.has(s.key.keyid)) return fail(0, `the chain was started by key ${s.key.keyid}, which is not a key given to verify against`);
      current = declared;
      keys.push(s.key.keyid);
    } else if (s.kind === 'chain.started') return fail(i, 'a second chain start inside the chain');
    if (s.seq !== i) return fail(i, `its sequence number is ${s.seq} where ${i} belongs: a receipt was dropped or moved`);
    if (s.prev !== prev) return fail(i, "it doesn't follow the receipt before it: one was dropped, moved or changed");
    const signing = keyId(current!);
    if (signatures[0]!.keyid !== signing) return fail(i, `signed by key ${signatures[0]!.keyid.slice(0, 80)}; the chain's key here is ${signing}`);
    if (!edVerify(null, pae(PAYLOAD_TYPE, bytes), current!, sig)) return fail(i, "the signature doesn't verify with the chain's key: it was changed, or another key signed it");
    const id = sha256(bytes);
    if (s.kind === 'merge.decided' || s.kind === 'merge.result') {
      if (s.event <= lastEvent) return fail(i, `its event ${s.event} is not after the one before (${lastEvent})`);
      lastEvent = s.event;
    }
    if (s.kind === 'merge.decided') decided.set(`${s.inputs.pr}@${s.inputs.head}`, id);
    if (s.kind === 'merge.result' && s.decision !== (decided.get(`${s.pr}@${s.head}`) ?? null)) return fail(i, "the decision it names is not the chain's latest decision for that PR head");
    if (s.kind === 'key.rotated') {
      const next = keyOfRef(s.next);
      if (!next) return fail(i, "the key it rotates to is unreadable, or isn't the key its id names");
      if (s.next.keyid === signing) return fail(i, 'it rotates to the key already in use');
      current = next;
      keys.push(s.next.keyid);
    }
    prev = id;
    ids.push(id);
    statements.push(s);
  }
  if (o.anchor !== undefined && !ids.includes(o.anchor)) return fail(envelopes.length, `the anchor ${o.anchor.slice(0, 80)} is not in the chain: receipts after it were dropped, or this is another chain`);
  return { ok: true, count: ids.length, head: prev, ids, keys, statements };
}

/** The chain so far, verified against the key it declares, for a signer about to extend it. */
function chainSoFar(existing: readonly unknown[], signer: ReceiptSigner): Extract<ChainResult, { ok: true }> {
  const state = verifyChain(existing, { keys: 'chain' });
  if (!state.ok) throw new ReceiptError(`the receipts so far don't verify (receipt ${state.index + 1}: ${state.problem}); nothing was signed`);
  const mine = keyId(signer.publicKey);
  if (state.count && state.keys.at(-1) !== mine) throw new ReceiptError(`this key (${mine}) is not the chain's current key (${state.keys.at(-1)}); nothing was signed`);
  return state;
}

function parsed<T extends (typeof RECEIPT_EVENTS)[number]>(e: ReceiptEvent, type: T): EventPayload<T> {
  const p = EventSchemas[type].safeParse(e.payload);
  if (!p.success) throw new ReceiptError(`event ${e.id} (${type}) in the log doesn't match its schema; nothing was signed past it`);
  return p.data as EventPayload<T>;
}

/** A merge event's receipt body, redacted (the log redacts on write already; this holds for any source). */
function bodyOf(e: ReceiptEvent, version: string | null, decided: Map<string, string>): Body | null {
  const common = { at: e.ts, instance: e.actor, event: e.id };
  if (e.type === 'merge.decided') {
    const p = parsed(e, 'merge.decided');
    const body = { ...common, kind: 'merge.decided' as const, engine: { version }, policy: { commit: null }, inputs: { issue: p.issue, pr: p.number, head: p.head, files: null, check_runs: null }, decision: { auto: p.auto, level: null, reasons: p.reasons, why: p.why ?? [] } };
    return redact(body);
  }
  if (e.type === 'merge.done' || e.type === 'merge.failed') {
    const done = e.type === 'merge.done' ? parsed(e, 'merge.done') : null;
    const p = done ?? parsed(e, 'merge.failed');
    const why = done ? null : (p as EventPayload<'merge.failed'>).why;
    const body = { ...common, kind: 'merge.result' as const, issue: p.issue, pr: p.number, head: p.head, merged: !!done, commit: done?.sha ?? null, reconciled: done?.reconciled === true, why, decision: decided.get(`${p.number}@${p.head}`) ?? null };
    return redact(body);
  }
  return null;
}

/**
 * Extend a chain with a receipt for each merge decision and result in `events` after the last one it receipts (a
 * new chain starts with its key). Refuses, signing nothing, when the chain so far doesn't verify, when the signer's
 * key isn't the chain's current one, or at an event that doesn't match its schema.
 */
export function signEvents(existing: readonly unknown[], events: readonly ReceiptEvent[], signer: ReceiptSigner, now: () => string = () => new Date().toISOString()): { envelopes: Envelope[]; added: number; head: string | null } {
  const state = chainSoFar(existing, signer);
  const envelopes = [...(existing as Envelope[])];
  let seq = state.count;
  let prev = state.head;
  const push = (body: Body) => {
    const { envelope, id } = seal({ ...body, schema: RECEIPT_SCHEMA, seq, prev } as Statement, signer);
    envelopes.push(envelope);
    seq++;
    prev = id;
    return id;
  };
  if (!state.count) push({ kind: 'chain.started', at: now(), key: keyRef(signer.publicKey) });
  const decided = new Map<string, string>();
  let last = 0;
  for (const [i, s] of state.statements.entries()) {
    if (s.kind === 'merge.decided') decided.set(`${s.inputs.pr}@${s.inputs.head}`, state.ids[i]!);
    if (s.kind === 'merge.decided' || s.kind === 'merge.result') last = s.event;
  }
  let version: string | null = null;
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    if (e.type === 'coordinator.started') {
      version = parsed(e, 'coordinator.started').version;
      continue;
    }
    if (e.id <= last) continue;
    const body = bodyOf(e, version, decided);
    if (!body) continue;
    const id = push(body);
    if (body.kind === 'merge.decided') decided.set(`${body.inputs.pr}@${body.inputs.head}`, id);
  }
  return { envelopes, added: seq - state.count, head: prev };
}

/** Hand the chain to a new key: a key.rotated receipt signed by the current key. After it only `next` signs. */
export function rotateChain(existing: readonly unknown[], signer: ReceiptSigner, next: KeyObject, now: () => string = () => new Date().toISOString()): Envelope[] {
  const state = chainSoFar(existing, signer);
  if (!state.count) throw new ReceiptError('there is no chain to rotate: sign with the new key to start one');
  if (next.type !== 'public' || next.asymmetricKeyType !== 'ed25519') throw new ReceiptError('the next key is an ed25519 public key');
  if (keyId(next) === keyId(signer.publicKey)) throw new ReceiptError('the next key is the key already in use');
  const { envelope } = seal({ schema: RECEIPT_SCHEMA, seq: state.count, prev: state.head, kind: 'key.rotated', at: now(), next: keyRef(next) }, signer);
  return [...(existing as Envelope[]), envelope];
}
