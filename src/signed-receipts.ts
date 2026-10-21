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
/**
 * What the signer checked itself (docs/design.md §5a, VERIFIES vs ATTESTS): each entry names a field of this statement
 * (a dotted path) or a fact only the signer derives (e.g. `result.tree`), how it was found (`git`, `github`), and the
 * value it found. Every field not listed is ATTESTED: the coordinator's claim as its log recorded it. Slice 1's
 * signer checks nothing itself, so the list is empty; slice 3 fills it without a format change.
 */
/** The most bytes one `verified` entry's `found` may take in canonical JSON (a check-run list fits many times over). */
const FOUND_MAX = 64 * 1024;
/** Whether `v` is a canonical JSON value (canonicalJson: integers only, plain objects) within FOUND_MAX bytes. */
function foundFits(v: unknown): boolean {
  try {
    return Buffer.byteLength(canonicalJson(v), 'utf8') <= FOUND_MAX;
  } catch {
    return false;
  }
}
const Verified = z.array(z.strictObject({ field: z.string().min(1).max(100), how: z.string().min(1).max(200), found: z.unknown().refine(foundFits, `any canonical JSON value of at most ${FOUND_MAX} bytes`) }));
/**
 * The event a receipt stands for: the actor the log names, the event's id there, what the signer verified itself,
 * and `log.digest`: a running SHA-256 over every event in the log up to this one (logDigest), as the signer read it.
 * The signer refuses to go on when a log no longer hashes to what it signed (an event edited, dropped or inserted).
 */
const eventFields = { instance: z.string(), event: positive, verified: Verified, log: z.strictObject({ digest: hex64 }) };

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

/** An event as the log stores it (src/events/log.ts). `raw`: its payload as stored (JSON text), when read from one. */
export interface ReceiptEvent {
  id: number;
  ts: string;
  type: string;
  actor: string;
  payload: unknown;
  raw?: string;
}

/**
 * The log's running digest after event `e`: SHA-256 over the canonical JSON of [the digest before it, the event's id,
 * time, type, actor and payload as stored]. INVARIANT: an unambiguous encoding (each field a JSON value, so no byte can
 * move from one field to the next and keep the digest: #918 round 3 measured that with newline-joined fields).
 */
export function logDigest(before: string, e: ReceiptEvent): string {
  return createHash('sha256')
    .update(canonicalJson([before, e.id, e.ts, e.type, e.actor, e.raw ?? JSON.stringify(e.payload ?? null)]), 'utf8')
    .digest('hex');
}

export interface FieldCheck {
  field: string;
  how: string;
  found: unknown;
  /** The statement's own value at `field`, when it has one. */
  claimed?: unknown;
  /**
   * - match / mismatch: the signer's value against the coordinator's claim (only a mismatch is flagged: verify exits 3);
   * - unrecorded: the claim is null, which means the deciding engine didn't record it (an event logged before #717
   *   step 1). The coordinator claimed nothing, so the signer's value is the only one: never a mismatch;
   * - derived: a fact the statement has no field for (e.g. `result.tree`).
   */
  result: 'match' | 'mismatch' | 'unrecorded' | 'derived';
}

/** What the signer verified in a receipt, each against the coordinator's claim; [] when it verified nothing. */
export function fieldChecks(s: Statement): FieldCheck[] {
  if (s.kind !== 'merge.decided' && s.kind !== 'merge.result') return [];
  return s.verified.map((v) => {
    let at: unknown = s;
    for (const k of v.field.split('.')) at = at !== null && typeof at === 'object' && Object.hasOwn(at, k) ? (at as Record<string, unknown>)[k] : undefined;
    if (at === undefined) return { ...v, result: 'derived' as const };
    if (at === null) return { ...v, claimed: null, result: 'unrecorded' as const };
    return { ...v, claimed: at, result: canonicalJson(at) === canonicalJson(v.found) ? ('match' as const) : ('mismatch' as const) };
  });
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
  // A plain object only (what JSON.parse and a statement literal make): a Buffer, Date, Map or class instance has
  // another constructor and throws. WHY not by its prototype: src/ never reaches one (test/slot-path.test.ts).
  if (typeof v === 'object' && (v as { constructor?: unknown }).constructor === Object) {
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
 * Verify a chain of receipts, in order. `keys`: the public keys trusted to have started the chain (each rotation
 * after that is signed by the key before it); a key a chain declares about itself is never trusted for that.
 * `anchor`: a receipt id the chain must still hold (a head kept from an earlier look), the one way to see a dropped
 * tail. Fails at the first receipt that doesn't hold; no receipts at all fail too.
 */
export function verifyChain(envelopes: readonly unknown[], o: { keys: readonly KeyObject[]; anchor?: string }): ChainResult {
  const fail = (index: number, problem: string): ChainResult => ({ ok: false, index, problem });
  if (!o.keys.length) return fail(0, 'no public key given to verify against');
  if (o.keys.some((k) => k.type !== 'public' || k.asymmetricKeyType !== 'ed25519')) return fail(0, 'a key given to verify against is not an ed25519 public key');
  const trusted = new Map(o.keys.map((k) => [keyId(k), k]));
  if (!envelopes.length) return fail(0, 'no receipts');
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
      if (!trusted.has(s.key.keyid)) return fail(0, `the chain was started by key ${s.key.keyid}, which is not a key given to verify against`);
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

/** The schema of the signer's own chain state (ChainState); a signer refuses any other. */
export const CHAIN_STATE_SCHEMA = `${BRAND.cli}.receipt-state/v1`;

/**
 * The signer's own memory of its chain (#918 round 4: A2, A3, A4), kept by the signer where only it writes, apart
 * from the receipts: how many receipts it has signed, the last one's id, and the key that started the chain. A
 * receipts file is signed on only when it extends this head, so a file truncated, deleted or swapped for another
 * chain (one a retired start key signed and rotated to this key included) is never extended.
 */
export const ChainStateSchema = z.strictObject({
  schema: z.literal(CHAIN_STATE_SCHEMA),
  count: positive,
  head: hex64,
  start: KeyRef,
  /**
   * The receipts the current key can't make again, kept whole (#918 round 7): the chain from its start through its
   * latest `key.rotated`. A `chain.started` or `key.rotated` carries the time it was made, and the receipts before a
   * rotation were signed by a key the signer no longer holds. With them kept, a missing, emptied or short receipts
   * file is always given back byte for byte from this and the log, or refused when the log changed: never a recovery
   * that deletes the state and so lets the same key start a second chain.
   */
  fixed: z.array(EnvelopeSchema).min(1),
});
export type ChainState = z.infer<typeof ChainStateSchema>;

/**
 * Where a signer extends from: its own chain state, or 'genesis', a new chain where the signer has none. Never a key
 * to trust: a start key is trusted only as the signer's own state names it (#918 round 4, A4: `--trust` let a chain
 * any holder of a retired start key made be extended).
 */
export type ChainFrom = ChainState | 'genesis';

/** How a signer extends a chain: from where, and its clock. */
export interface SignOptions {
  from: ChainFrom;
  now?: () => string;
}

/** A receipt's id: the SHA-256 of its payload, hex. */
export function receiptId(env: Envelope): string {
  return sha256(Buffer.from(env.payload, 'base64'));
}

/** The signer's chain state after `envelopes`, a chain that starts from `start` (`fixed`: through its last rotation). */
export function chainStateOf(envelopes: readonly Envelope[], start: { keyid: string; spki: string }): ChainState {
  let last = 0;
  for (const [i, e] of envelopes.entries()) if ((statementOf(e) as { kind?: unknown } | null)?.kind === 'key.rotated') last = i;
  const fixed = envelopes.slice(0, last + 1).map((e) => ({ payloadType: e.payloadType, payload: e.payload, signatures: e.signatures.map((s) => ({ keyid: s.keyid, sig: s.sig })) }));
  return ChainStateSchema.parse({ schema: CHAIN_STATE_SCHEMA, count: envelopes.length, head: receiptId(envelopes.at(-1)!), start: { keyid: start.keyid, spki: start.spki }, fixed });
}

/** The words every refusal about the signer's own head uses. */
const headOf = (own: ChainState) => `the signer's own chain head is receipt ${own.count} (${own.head})`;

/**
 * The chain so far, for a signer about to extend it (`base`, verified as `state`), and whether it is behind the
 * signer's own head.
 * - 'genesis': there must be no receipts. A file the signer has no state for is someone else's, never adopted.
 * - Its own state: the receipts, if any, must verify from the start key the state names and agree with the state's
 *   fixed receipts (ChainState.fixed) as far as both go; receipts that reach the state's count must hold its head at
 *   its place (not cut back and replaced, not another chain). The chain to extend is the receipts, or the state's
 *   fixed receipts when the receipts are shorter (missing or emptied included). If that is short of the state's head
 *   it is `behind`: the state is written before the receipts (#918 round 5), so a failed or killed run leaves it so,
 *   and so does a cut. The caller signs the rest again from the log and accepts only the very head the state names.
 *   And this key must be the current key of the chain it extends.
 */
function chainSoFar(existing: readonly unknown[], signer: ReceiptSigner, from: ChainFrom): { state: Extract<ChainResult, { ok: true }>; base: readonly unknown[]; behind: ChainState | null } {
  if (from === 'genesis') {
    if (existing.length) throw new ReceiptError("there are receipts already, and the signer has no chain state of its own: they are someone else's chain, never adopted; nothing was signed");
    return { state: { ok: true, count: 0, head: null, ids: [], keys: [], statements: [] }, base: [], behind: null };
  }
  const own = ChainStateSchema.parse(from);
  const start = keyOfRef(own.start);
  if (!start) throw new ReceiptError("the signer's chain state names a start key that is unreadable, or isn't the key its id names; nothing was signed");
  const fixed = verifyChain(own.fixed, { keys: [start] });
  if (!fixed.ok || fixed.count > own.count) throw new ReceiptError("the signer's chain state is damaged (its fixed receipts don't verify from its start key); nothing was signed");
  let state = fixed;
  let base: readonly unknown[] = own.fixed;
  if (existing.length) {
    const found = verifyChain(existing, { keys: [start] });
    if (!found.ok) throw new ReceiptError(`the receipts so far don't verify from the signer's start key (receipt ${found.index + 1}: ${found.problem}); nothing was signed`);
    const both = Math.min(found.count, fixed.count);
    const agree = found.ids.slice(0, both).every((id, i) => id === fixed.ids[i]);
    if (!agree || (found.count >= own.count && found.ids[own.count - 1] !== own.head)) {
      throw new ReceiptError(`the receipts don't extend the chain this signer signed (${headOf(own)}): they were truncated and replaced, or forked; nothing was signed`);
    }
    if (found.count >= fixed.count) {
      state = found;
      base = existing;
    }
  }
  const mine = keyId(signer.publicKey);
  if (state.keys.at(-1) !== mine) throw new ReceiptError(`this key (${mine}) is not the chain's current key (${state.keys.at(-1)}); nothing was signed`);
  return { state, base, behind: state.count < own.count ? own : null };
}

function parsed<T extends (typeof RECEIPT_EVENTS)[number]>(e: ReceiptEvent, type: T): EventPayload<T> {
  const p = EventSchemas[type].safeParse(e.payload);
  if (!p.success) throw new ReceiptError(`event ${e.id} (${type}) in the log doesn't match its schema; nothing was signed past it`);
  return p.data as EventPayload<T>;
}

/** A merge event's receipt body, redacted (the log redacts on write already; this holds for any source). */
function bodyOf(e: ReceiptEvent, version: string | null, decided: Map<string, string>, digest: string): Body | null {
  const common = { at: e.ts, instance: e.actor, event: e.id };
  // Slice 1 verifies nothing itself: every field is attested (see Verified). Added after the redactor, which only
  // the event-derived text needs.
  const signer = { verified: [], log: { digest } };
  if (e.type === 'merge.decided') {
    const p = parsed(e, 'merge.decided');
    const body = { ...common, kind: 'merge.decided' as const, engine: { version }, policy: { commit: null }, inputs: { issue: p.issue, pr: p.number, head: p.head, files: null, check_runs: null }, decision: { auto: p.auto, level: null, reasons: p.reasons, why: p.why ?? [] } };
    return { ...redact(body), ...signer };
  }
  if (e.type === 'merge.done' || e.type === 'merge.failed') {
    const done = e.type === 'merge.done' ? parsed(e, 'merge.done') : null;
    const p = done ?? parsed(e, 'merge.failed');
    const why = done ? null : (p as EventPayload<'merge.failed'>).why;
    const body = { ...common, kind: 'merge.result' as const, issue: p.issue, pr: p.number, head: p.head, merged: !!done, commit: done?.sha ?? null, reconciled: done?.reconciled === true, why, decision: decided.get(`${p.number}@${p.head}`) ?? null };
    return { ...redact(body), ...signer };
  }
  return null;
}

/**
 * Extend a chain with a receipt for each merge decision and result in `events` after the last one it receipts (a
 * new chain, from 'genesis', starts with its key). Refuses, signing nothing, when the chain so far doesn't extend the
 * signer's own chain state (chainSoFar), when the signer's key isn't the chain's current one, when the log changed
 * under receipts already signed, or at an event that doesn't match its schema. `state`: the signer's chain state
 * after this (unchanged when nothing was added).
 */
export function signEvents(existing: readonly unknown[], events: readonly ReceiptEvent[], signer: ReceiptSigner, o: SignOptions): { envelopes: Envelope[]; added: number; head: string | null; state: ChainState } {
  const { state, base, behind } = chainSoFar(existing, signer, o.from);
  const r = extend(base, state, events, signer, o.now ?? (() => new Date().toISOString()));
  // Receipts behind the signer's own head are signed again from the log, onto its fixed receipts. Merge receipts take
  // their time, version and digest from the log, and ed25519 is deterministic, so an unchanged log gives back the very
  // receipts the state names; a log changed meanwhile gives another id: refused.
  if (behind && (r.envelopes.length < behind.count || receiptId(r.envelopes[behind.count - 1]!) !== behind.head)) {
    throw new ReceiptError(`the receipts are ${existing.length ? 'short of' : 'missing or empty, short of'} the chain this signer signed (${headOf(behind)}), and signing them again from the log doesn't give that head back: the log changed under receipts already signed, or they were replaced; nothing was signed`);
  }
  // `added`: receipts the receipts file gains (given back or new).
  return { ...r, added: r.envelopes.length - existing.length, state: chainStateOf(r.envelopes, o.from === 'genesis' ? keyRef(signer.publicKey) : o.from.start) };
}

/** `existing` (verified as `state`) extended with a receipt for each merge event in `events` after its last one. */
function extend(existing: readonly unknown[], state: Extract<ChainResult, { ok: true }>, events: readonly ReceiptEvent[], signer: ReceiptSigner, now: () => string): { envelopes: Envelope[]; added: number; head: string | null } {
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
  // The log as read now must hash, at each event already receipted, to what that receipt recorded: an event edited,
  // dropped or inserted before it is a log that changed under signed receipts, and nothing more is signed.
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const digests = new Map<number, string>();
  let digest = '';
  for (const e of sorted) {
    if (digests.has(e.id)) throw new ReceiptError(`event ${e.id} appears twice in the log; nothing was signed`);
    digest = logDigest(digest, e);
    digests.set(e.id, digest);
  }
  for (const s of state.statements) {
    if ((s.kind === 'merge.decided' || s.kind === 'merge.result') && digests.get(s.event) !== s.log.digest) {
      throw new ReceiptError(`the log changed under receipts already signed (at event ${s.event}: an event before it was edited, dropped or inserted, or it is gone); nothing was signed`);
    }
  }
  let version: string | null = null;
  for (const e of sorted) {
    if (e.type === 'coordinator.started') {
      version = parsed(e, 'coordinator.started').version;
      continue;
    }
    if (e.id <= last) continue;
    const body = bodyOf(e, version, decided, digests.get(e.id)!);
    if (!body) continue;
    const id = push(body);
    if (body.kind === 'merge.decided') decided.set(`${body.inputs.pr}@${body.inputs.head}`, id);
  }
  return { envelopes, added: seq - state.count, head: prev };
}

/**
 * Hand the chain to a new key: a key.rotated receipt signed by the current key. After it only `next` signs. Only
 * from the signer's own chain state (a chain to rotate); chainStateOf gives the state after it.
 */
export function rotateChain(existing: readonly unknown[], signer: ReceiptSigner, next: KeyObject, o: SignOptions & { from: ChainState }): Envelope[] {
  const now = o.now ?? (() => new Date().toISOString());
  const { state, base, behind } = chainSoFar(existing, signer, o.from);
  // A rotation is never made on receipts short of the signer's head: sign first, which brings them back.
  if (behind || base !== existing) throw new ReceiptError(`the receipts are short of the chain this signer signed (${headOf(o.from)}): run sign first; nothing was rotated`);
  if (!state.count) throw new ReceiptError('there is no chain to rotate: sign with the new key to start one');
  if (next.type !== 'public' || next.asymmetricKeyType !== 'ed25519') throw new ReceiptError('the next key is an ed25519 public key');
  if (keyId(next) === keyId(signer.publicKey)) throw new ReceiptError('the next key is the key already in use');
  const { envelope } = seal({ schema: RECEIPT_SCHEMA, seq: state.count, prev: state.head, kind: 'key.rotated', at: now(), next: keyRef(next) }, signer);
  return [...(existing as Envelope[]), envelope];
}
