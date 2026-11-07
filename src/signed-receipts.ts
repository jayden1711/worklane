// Signed receipts (#717, docs/design.md §5a): each merge decision and merge result an instance's event log records
// becomes a statement in canonical JSON, signed with ed25519 in a DSSE envelope and chained by hash, so anyone holding
// the chain's public key can verify it offline: nothing changed, dropped or reordered, every receipt by the chain's
// key. Not the claims receipts (src/receipts.ts). Pure: no files, no network; src/signed-receipts-store.ts reads the
// log and writes the receipts file.
import { createHash, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { BRAND } from './brand.js';
import { redactString } from './events/redact.js';
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
 * (a dotted path) or a fact only the signer derives (e.g. `result.tree`), how it was found (from git or GitHub), and the
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
/**
 * The fields of a receipt that were cut to their bound (cutToBound: a string past TEXT_MAX code units, a list past
 * ITEMS_MAX items), by dotted path, each with the SHA-256 and length of the whole value as the log held it (after
 * redaction). Empty when nothing was cut. WHY (#918 round 9, route 2): one oversized event made a receipt nothing
 * could read; a cut field attests its first part and the digest of the whole (docs/design.md §5a, VERIFIES vs ATTESTS).
 */
/**
 * A log field the signer never read as text (`length` is its size in bytes; the receipt keeps ""): `of: 'unread'`,
 * past the read bound (round 13); `of: 'not-utf8'`, bytes that aren't UTF-8, never shown as U+FFFD (round 14); `of:
 * 'null'`, a NULL (round 14).
 */
const Cut = z.record(z.string().min(1), z.strictObject({ sha256: hex64, length: z.number().int().min(0), of: z.enum(['whole', 'kept', 'unread', 'not-utf8', 'null']) }));
/**
 * A log event's id as a receipt holds it: its decimal digits, a JSON string, never a JSON number (#918 round 12). WHY:
 * SQLite's ids reach 2^63 - 1, and the coordinator owns the log; a JSON number past 2^53 can't be read back exactly,
 * and one event appended at 2^53 made every later `sign` throw, the honest events after it included (AUTOINCREMENT
 * gives them larger ids still). Compared as BigInt. `EVENT_MARK` also takes 0: "before the log's first event".
 */
const EVENT_ID = z.string().regex(/^[1-9][0-9]{0,18}$/);
const EVENT_MARK = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const eventFields = { instance: z.string(), event: EVENT_ID, verified: Verified, log: z.strictObject({ digest: hex64 }), cut: Cut };
/**
 * The chain a new chain succeeds, named in its `chain.started` (#918 round 9, route 1): every key that signed it (its
 * predecessors' included), its head, and the last log event it receipted. The new chain receipts only events after
 * that one, with a key not among these. Null for a first chain.
 */
const Previous = z.strictObject({
  keys: z.array(hex64).min(1),
  head: hex64,
  event: EVENT_MARK,
  /** Read from the ended chain's own state, or from a copy of its receipts (round 10: a copy may be cut short). */
  from: z.enum(['state', 'copy']),
});
export type Predecessor = z.infer<typeof Previous>;

/**
 * One receipt's statement. INVARIANT: a field the deciding engine didn't record is null, never filled in afterwards
 * from somewhere else: `policy.commit`, `inputs.files`, `inputs.check_runs` and `decision.level` are null until the
 * merge record carries them (#717 step 1), so a receipt never claims more than the log said at the time.
 */
const StatementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...chainFields, kind: z.literal('chain.started'), key: KeyRef, previous: Previous.nullable() }),
  z.strictObject({ ...chainFields, kind: z.literal('key.rotated'), next: KeyRef }),
  /**
   * A merge event the signer can't read as one (#918 round 11, P3): its payload doesn't match the event's schema.
   * Signed as unsignable, with the event's type and why, so the chain records it and goes on; never signed as if it
   * were a decision or a result. Round 10 refused it, and one appended event ended the chain.
   */
  z.strictObject({ ...chainFields, ...eventFields, kind: z.literal('event.unsignable'), type: z.string(), problem: z.string() }),
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
/** A receipt for one log event: a merge decision, a merge result, or an unsignable merge event. */
type EventReceipt = Extract<Statement, { kind: 'merge.decided' | 'merge.result' | 'event.unsignable' }>;
const isEventReceipt = (s: Statement): s is EventReceipt => s.kind === 'merge.decided' || s.kind === 'merge.result' || s.kind === 'event.unsignable';
type Body = Statement extends infer S ? (S extends Statement ? Omit<S, 'schema' | 'seq' | 'prev'> : never) : never;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** A DSSE envelope (github.com/secure-systems-lab/dsse), with exactly one signature in this version. */
const EnvelopeSchema = z.strictObject({ payloadType: z.string(), payload: base64, signatures: z.array(z.strictObject({ keyid: z.string(), sig: base64 })).length(1) });
export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * An event as the log stores it (src/events/log.ts). `raw`: its payload as stored (JSON text), when read from one.
 * `id`: an integer; the store reads it as a BigInt, so an id past 2^53 is exact (round 12).
 * `hashes`: each column's columnHash as stored, from the store (round 13); without them they are taken from the strings
 * here, as text. `unread`: each field the store didn't read as text, and why (`ts`, `actor` and `payload` are then ""
 * and undefined): past its read bound, not UTF-8, or NULL (round 14).
 */
export interface ReceiptEvent {
  id: number | bigint;
  ts: string;
  type: string;
  actor: string;
  payload: unknown;
  raw?: string;
  hashes?: { ts: string; type: string; actor: string; payload: string };
  unread?: { ts?: Unread; actor?: Unread; payload?: Unread };
}
/** A log field not read as text: its size in bytes, and why (round 14). */
export type Unread = { bytes: number; why: 'bound' | 'values' | 'not-utf8' | 'null' };

/**
 * A log column's hash: SHA-256 over its SQLite storage class (`text`, `blob`, `integer`, `real` or `null`), a NUL, and
 * its bytes as stored. WHY the class (#918 round 14): round 13 hashed a NULL as it hashed "", so a NULL turned into ""
 * under a signed receipt kept the digest (the round-13 second review's row 5).
 */
export function columnHash(storage: string, bytes: Uint8Array | string): string {
  return createHash('sha256').update(storage, 'utf8').update('\0', 'utf8').update(bytes).digest('hex');
}
const textHash = (s: string) => columnHash('text', s);

/**
 * The log's running digest after event `e`: SHA-256 over the canonical JSON of [the digest before it, the event's id
 * (decimal), and the SHA-256 of its time, type, actor and payload as stored]. INVARIANT: an unambiguous encoding (each
 * field its own JSON value, so no byte can move from one field to the next and keep the digest: #918 round 3 measured
 * that with newline-joined fields). WHY each field by its hash (#918 round 13): round 12 put the fields themselves in
 * one string, and one appended event of 90,000,000 control characters (6 each in JSON) was past V8's longest string,
 * so every `sign` threw. A field's hash is taken from its bytes (columnHash), never from one string of the event.
 */
export function logDigest(before: string, e: ReceiptEvent): string {
  const h = e.hashes ?? { ts: textHash(e.ts), type: textHash(e.type), actor: textHash(e.actor), payload: textHash(e.raw ?? JSON.stringify(e.payload ?? null)) };
  return createHash('sha256')
    .update(canonicalJson([before, BigInt(e.id).toString(), h.ts, h.type, h.actor, h.payload]), 'utf8')
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
  let lastEvent = 0n;
  let previousKeys: readonly string[] = [];
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
      // A successor (round 10, #918 round-9 review row 4): never started by a key that signed the chain it
      // succeeds, and receipting only events after that chain's last one.
      if (s.previous?.keys.includes(s.key.keyid)) return fail(0, `the chain was started by key ${s.key.keyid}, which signed the chain it succeeds`);
      previousKeys = s.previous?.keys ?? [];
      lastEvent = BigInt(s.previous?.event ?? '0');
      current = declared;
      keys.push(s.key.keyid);
    } else if (s.kind === 'chain.started') return fail(i, 'a second chain start inside the chain');
    if (s.seq !== i) return fail(i, `its sequence number is ${s.seq} where ${i} belongs: a receipt was dropped or moved`);
    if (s.prev !== prev) return fail(i, "it doesn't follow the receipt before it: one was dropped, moved or changed");
    const signing = keyId(current!);
    if (signatures[0]!.keyid !== signing) return fail(i, `signed by key ${signatures[0]!.keyid.slice(0, 80)}; the chain's key here is ${signing}`);
    if (!edVerify(null, pae(PAYLOAD_TYPE, bytes), current!, sig)) return fail(i, "the signature doesn't verify with the chain's key: it was changed, or another key signed it");
    const id = sha256(bytes);
    if (isEventReceipt(s)) {
      if (BigInt(s.event) <= lastEvent) return fail(i, `its event ${s.event} is not after the one before (${lastEvent})`);
      lastEvent = BigInt(s.event);
    }
    if (s.kind === 'merge.decided') decided.set(`${s.inputs.pr}@${s.inputs.head}`, id);
    if (s.kind === 'merge.result' && s.decision !== (decided.get(`${s.pr}@${s.head}`) ?? null)) return fail(i, "the decision it names is not the chain's latest decision for that PR head");
    if (s.kind === 'key.rotated') {
      const next = keyOfRef(s.next);
      if (!next) return fail(i, "the key it rotates to is unreadable, or isn't the key its id names");
      if (s.next.keyid === signing) return fail(i, 'it rotates to the key already in use');
      if (previousKeys.includes(s.next.keyid)) return fail(i, 'it rotates to a key that signed the chain this one succeeds');
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
  /** The last log event the chain receipted (its predecessor's, before its own first): where a successor starts. */
  event: EVENT_MARK,
  /**
   * Set when a successor started from this chain (round 10): the successor's start key and the head it succeeded.
   * An ended chain never signs or rotates again, and has one successor only. WHY (#918 round-9 review, rows 1 and 2):
   * an ended chain resumed beside its successor once the log was restored, and a second successor started from it.
   */
  ended: z.strictObject({ successor: hex64, head: hex64 }).nullable(),
  /**
   * The signer's chain registry (round 11) as this chain started: its path, and its line count and head just after
   * this chain's start line. `head` is that start line's id: the chain's identity in the registry (round 12). Every
   * later sign and rotate checks the registry still holds that line there, so a registry deleted, replaced, edited or
   * cut short of it is refused; an older copy that still holds it is not (the signer user's act, docs/design.md §5a).
   * Null only outside the store (the pure functions here).
   */
  registry: z.strictObject({ path: z.string().min(1), count: positive, head: hex64 }).nullable(),
});
export type ChainState = z.infer<typeof ChainStateSchema>;

/**
 * Where a signer extends from: its own chain state, or 'genesis', a new chain where the signer has none. Never a key
 * to trust: a start key is trusted only as the signer's own state names it (#918 round 4, A4: `--trust` let a chain
 * any holder of a retired start key made be extended).
 */
export type ChainFrom = ChainState | 'genesis';

/**
 * How a signer extends a chain: from where, and its clock. `after`, with 'genesis' only: the chain this new one
 * succeeds (predecessorOf), so it receipts only events after that chain's last, with a key that never signed it.
 */
export interface SignOptions {
  from: ChainFrom;
  after?: Predecessor;
  now?: () => string;
  /** The most bytes the receipts may take as JSON lines; refused as they grow past it (round 14). */
  maxBytes?: number;
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
  return ChainStateSchema.parse({ schema: CHAIN_STATE_SCHEMA, count: envelopes.length, head: receiptId(envelopes.at(-1)!), start: { keyid: start.keyid, spki: start.spki }, fixed, event: lastEventOf(envelopes), ended: null, registry: null });
}

/** The chain a successor names, from the ended chain's own state: its keys (from its fixed receipts), head and last event. */
export function predecessorOfState(s: ChainState): Predecessor {
  return Previous.parse({ ...predecessorOf(s.fixed), head: s.head, event: s.event, from: 'state' });
}

/** The last log event a chain receipted: its last merge receipt's, or, with none, its predecessor's (or 0). */
function lastEventOf(envelopes: readonly Envelope[]): string {
  let event = '0';
  for (const e of envelopes) {
    const s = statementOf(e) as { kind?: string; event?: unknown; previous?: { event?: string } | null };
    if (s.kind === 'chain.started') event = s.previous?.event ?? '0';
    if ((s.kind === 'merge.decided' || s.kind === 'merge.result' || s.kind === 'event.unsignable') && typeof s.event === 'string') event = s.event;
  }
  return event;
}

/**
 * The chain a successor names (#918 round 9, route 1), from that chain's receipts, verified from the start key its
 * first receipt declares (`envelopes` come from its own state, or a copy the owner trusts): every key that signed it
 * or its own predecessors, its head, and its last event.
 */
export function predecessorOf(envelopes: readonly unknown[]): Predecessor {
  const first = EnvelopeSchema.safeParse(envelopes[0]);
  const st = first.success ? (statementOf(first.data) as { kind?: string; key?: { keyid: string; spki: string }; previous?: Predecessor | null }) : null;
  const start = st?.kind === 'chain.started' && st.key ? keyOfRef(st.key) : null;
  if (!start) throw new ReceiptError('the chain to succeed has no readable start: give its own state, or a copy of its receipts');
  const r = verifyChain(envelopes, { keys: [start] });
  if (!r.ok) throw new ReceiptError(`the chain to succeed doesn't verify (receipt ${r.index + 1}: ${r.problem}): give its own state, or a copy of its receipts`);
  return Previous.parse({ keys: [...new Set([...(st?.previous?.keys ?? []), ...r.keys])], head: r.head, event: lastEventOf(envelopes as Envelope[]), from: 'copy' });
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
  if (own.ended) throw new ReceiptError(`this chain ended: key ${own.ended.successor} started its successor after its head ${own.ended.head}. An ended chain never signs or rotates again; nothing was signed`);
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


/** A merge event's receipt body, redacted (the log redacts on write already; this holds for any source). */
/** The most UTF-16 code units a string in a receipt keeps, and the most items a list keeps (redactBounded). */
export const TEXT_MAX = 1024;
export const ITEMS_MAX = 64;
/**
 * The longest string the redactor is run on (UTF-16 code units). A longer one is never redacted and never kept: the
 * receipt holds no text of it. WHY (#918 round-9 review, row 6): the private-key pattern is quadratic on repeated
 * BEGIN markers, and round 9 ran it on the whole value before the cut (a 6.9 MB reason took 125 s, holding the
 * signer's lock). Keeping none of an unredacted string also means no part of a secret it holds reaches a receipt.
 */
export const REDACT_MAX = 16 * 1024;

/**
 * The most bytes the store reads of a log event's ts, type or actor (round 13): more than any string the redactor
 * keeps (REDACT_MAX UTF-16 code units are at most 48 KiB of UTF-8), so every field a receipt could keep is read.
 */
export const FIELD_READ_MAX = 64 * 1024;
/**
 * The most bytes the store reads of a merge event's payload (round 13); a longer one is never read or parsed, and its
 * event is signed as `event.unsignable`. A coordinator.started's payload is read only to FIELD_READ_MAX (round 14: it
 * holds a version, and three 60 MiB ones ran `sign` out of heap), and every other payload is never read, only hashed.
 * WHY: one appended 90 MB event stalled every `sign` (round-12 second review, row 1). 64 MiB keeps round 9's 50 MiB
 * reason readable (it is cut in its receipt), and is far below V8's longest string.
 */
export const PAYLOAD_READ_MAX = 64 * 1024 * 1024;

type CutEntry = { sha256: string; length: number; of: 'whole' | 'kept' | 'unread' | 'not-utf8' | 'null' };
const UNREAD_OF = { bound: 'unread', values: 'unread', 'not-utf8': 'not-utf8', null: 'null' } as const;

/**
 * The most JSON values (containers, keys and list items, counted from the `[`, `{`, `,` and `:` outside strings) a
 * payload the signer parses may hold (round 15). No merge event needs more (a decision's lists are cut at ITEMS_MAX
 * items anyway); a payload with more is never parsed, and its event is `event.unsignable`. WHY: one 64 MiB merge payload
 * of flat `[[],…]` (22M values) took about 13× its size in heap to parse, and a 512 MB heap aborted (the round-14
 * final check, 3d, measured).
 */
export const JSON_VALUES_MAX = 65_536;

/** Whether the JSON text in `bytes` holds more than `max` values (a linear scan, never a parse). */
export function moreJsonValuesThan(bytes: Uint8Array, max: number): boolean {
  let n = 0;
  let inString = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (inString) {
      if (c === 0x5c) i++; // a backslash escapes the next byte
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if ((c === 0x5b || c === 0x7b || c === 0x2c || c === 0x3a) && ++n > max) return true;
  }
  return false;
}
/** A value's SHA-256 over its canonical JSON (a lone surrogate is escaped there, never read as U+FFFD: row 7). */
const digestOf = (v: unknown) => sha256(Buffer.from(canonicalJson(v), 'utf8'));

/**
 * `v` redacted and bounded, every cut recorded in `cut` by its dotted path:
 * - a string up to REDACT_MAX is redacted whole; past TEXT_MAX it is cut, with `of: 'whole'`: the length and SHA-256
 *   of the whole redacted value (whoever holds the text can redact it the same way and check);
 * - a string past REDACT_MAX is kept as "" and never redacted, with `of: 'kept'`: its length, and the digest of what
 *   the receipt keeps; never a digest of unredacted text, which could confirm a guessed secret;
 * - a list past ITEMS_MAX keeps its first items, with `of: 'kept'`: its length and the digest of the kept items.
 * Each string is redacted on its own, as redact() does for an object's values. WHY (#918 rounds 9 and 10): one event
 * with a 50 MiB reason made receipts nothing could read, and one oversized string stalled the redactor.
 */
function redactBounded(v: unknown, path: string, cut: Record<string, CutEntry>): unknown {
  if (typeof v === 'string') {
    if (v.length > REDACT_MAX) {
      cut[path] = { length: v.length, sha256: digestOf(''), of: 'kept' };
      return '';
    }
    const r = redactString(v);
    if (r.length <= TEXT_MAX) return r;
    cut[path] = { length: r.length, sha256: digestOf(r), of: 'whole' };
    const kept = r.slice(0, TEXT_MAX);
    const end = kept.charCodeAt(kept.length - 1);
    // Never half a surrogate pair at the cut.
    return end >= 0xd800 && end <= 0xdbff ? kept.slice(0, -1) : kept;
  }
  if (Array.isArray(v)) {
    const kept = v.slice(0, ITEMS_MAX).map((x, i) => redactBounded(x, `${path}.${i}`, cut));
    if (v.length > ITEMS_MAX) cut[path] = { length: v.length, sha256: digestOf(kept), of: 'kept' };
    return kept;
  }
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactBounded(x, path ? `${path}.${k}` : k, cut)]));
  return v;
}

/**
 * A merge event's receipt body, redacted and bounded, or null for any other kind. `version`: the engine version the
 * last coordinator.started gave, and `versionUnread` when that payload was never read (round 15: cut as
 * `engine.version`). A merge.result's `decision` is null here: the receipt ids it names exist only once signed, so the
 * signer fills it (extend).
 */
function bodyOf(e: ReceiptEvent, version: string | null, versionUnread: Unread | null, digest: string): Body | null {
  const common = { at: e.ts, instance: e.actor, event: BigInt(e.id).toString() };
  // Slice 1 verifies nothing itself: every field is attested (see Verified). Added after the redactor, which only
  // the event-derived text needs.
  const signer = { verified: [], log: { digest } };
  const bounded = <T extends { kind: string }>(body: T) => {
    const cut: Record<string, CutEntry> = {};
    const out = redactBounded(body, '', cut) as T & { at: string };
    // A field past the store's read bound was never read (round 13): the receipt keeps none of it, and says so.
    for (const [field, u] of [['at', e.unread?.ts], ['instance', e.unread?.actor], ['engine.version', body.kind === 'merge.decided' ? (versionUnread ?? undefined) : undefined]] as const) {
      if (u !== undefined) cut[field] = { length: u.bytes, sha256: digestOf(''), of: UNREAD_OF[u.why] };
    }
    // WHY (#918 round 11, P3): a `ts` that is empty, or cut to nothing (over REDACT_MAX), would make `at` "", which
    // no receipt may be, and one appended event ended the chain. The receipt says so instead, and records the cut.
    if (out.at === '') {
      cut.at ??= { length: 0, sha256: digestOf(''), of: 'kept' };
      out.at = AT_UNRECORDED;
    }
    return { ...out, ...signer, cut };
  };
  if (e.type !== 'merge.decided' && e.type !== 'merge.done' && e.type !== 'merge.failed') return null;
  // A merge event whose payload doesn't match its schema is signed as unsignable (round 11, P3), never as if it
  // were whole, and the chain goes on. So is one whose payload is past the store's read bound (round 13: never read).
  const unsignable = (problem = "its payload doesn't match the event's schema") => bounded({ ...common, kind: 'event.unsignable' as const, type: e.type, problem });
  const unreadPayload = e.unread?.payload;
  if (unreadPayload !== undefined) {
    const u = unreadPayload;
    return unsignable(
      u.why === 'bound'
        ? `its payload is ${u.bytes} bytes, past the ${PAYLOAD_READ_MAX} the signer reads: never read`
        : u.why === 'values'
          ? `its payload (${u.bytes} bytes) holds more than ${JSON_VALUES_MAX} JSON values, which no merge event needs: never parsed`
          : u.why === 'null'
            ? 'its payload is NULL'
            : `its payload (${u.bytes} bytes) isn't UTF-8: never read`,
    );
  }
  if (e.type === 'merge.decided') {
    const r = EventSchemas['merge.decided'].safeParse(e.payload);
    if (!r.success) return unsignable();
    const p = r.data as EventPayload<'merge.decided'>;
    return bounded({ ...common, kind: 'merge.decided' as const, engine: { version }, policy: { commit: null }, inputs: { issue: p.issue, pr: p.number, head: p.head, files: null, check_runs: null }, decision: { auto: p.auto, level: null, reasons: p.reasons, why: p.why ?? [] } });
  }
  const r = (e.type === 'merge.done' ? EventSchemas['merge.done'] : EventSchemas['merge.failed']).safeParse(e.payload);
  if (!r.success) return unsignable();
  const done = e.type === 'merge.done' ? (r.data as EventPayload<'merge.done'>) : null;
  const p = done ?? (r.data as EventPayload<'merge.failed'>);
  const why = done ? null : (p as EventPayload<'merge.failed'>).why;
  return bounded({ ...common, kind: 'merge.result' as const, issue: p.issue, pr: p.number, head: p.head, merged: !!done, commit: done?.sha ?? null, reconciled: done?.reconciled === true, why, decision: null as string | null });
}

/** What `at` says when the log's `ts` was empty or past the bound (the receipt's `cut.at` records which). */
export const AT_UNRECORDED = 'unrecorded';

/**
 * Extend a chain with a receipt for each merge decision and result in `events` after the last one it receipts (a
 * new chain, from 'genesis', starts with its key). Refuses, signing nothing, when the chain so far doesn't extend the
 * signer's own chain state (chainSoFar), when the signer's key isn't the chain's current one, when the log changed
 * under receipts already signed, or at an event that doesn't match its schema. `state`: the signer's chain state
 * after this (unchanged when nothing was added).
 */
export function signEvents(existing: readonly unknown[], events: Iterable<ReceiptEvent> | LogScanner, signer: ReceiptSigner, o: SignOptions): { envelopes: Envelope[]; added: number; head: string | null; state: ChainState; skipped: number; first: string | null } {
  if (o.after && o.from !== 'genesis') throw new ReceiptError('only a new chain (genesis) names a chain it succeeds');
  // WHY (#918 round 9, routes 1b, 1c): a key that signed the ended chain, or a chain before it, never starts its
  // successor, so the same key never signs a second version of what it signed there.
  const mine = keyId(signer.publicKey);
  if (o.after?.keys.includes(mine)) throw new ReceiptError(`this key (${mine}) signed the chain it would succeed: a successor takes a new key; nothing was signed`);
  const { state, base, behind } = chainSoFar(existing, signer, o.from);
  const scan: LogScanner = typeof events === 'function' ? events : (q) => scanEvents(events, q);
  const r = extend(base, state, scan, signer, o.now ?? (() => new Date().toISOString()), o.after ? Previous.parse(o.after) : null, o.maxBytes ?? Infinity);
  // Receipts behind the signer's own head are signed again from the log, onto its fixed receipts. Merge receipts take
  // their time, version and digest from the log, and ed25519 is deterministic, so an unchanged log gives back the very
  // receipts the state names; a log changed meanwhile gives another id: refused.
  if (behind && (r.envelopes.length < behind.count || receiptId(r.envelopes[behind.count - 1]!) !== behind.head)) {
    throw new ReceiptError(`the receipts are ${existing.length ? 'short of' : 'missing or empty, short of'} the chain this signer signed (${headOf(behind)}), and signing them again from the log doesn't give that head back: the log changed under receipts already signed, or they were replaced; nothing was signed`);
  }
  // `added`: receipts the receipts file gains (given back or new).
  return { ...r, added: r.envelopes.length - existing.length, state: chainStateOf(r.envelopes, o.from === 'genesis' ? keyRef(signer.publicKey) : o.from.start) };
}

/**
 * What a log scan needs to know of the chain (round 15): the last event it receipted, the digest each of its receipts
 * expects at its event, and the most bytes the new receipts' bodies may take.
 */
export interface ScanQuery {
  last: string;
  expected: [string, string][];
  maxBytes: number;
}
/**
 * What a log scan gives back (round 15): the log's digest step at its first event (null: no event), how many merge
 * events at ids <= 0 it passed over, and the receipt body of each merge event after `last`, in id order (a
 * merge.result's `decision` still null). Plain JSON: the store's scan runs in a child process (signed-receipts-log-child).
 */
export interface ScanResult {
  first: string | null;
  skipped: number;
  items: unknown[];
}
/** A scan of a log by query: scanEvents over events in memory, or the store's child process over a log file. */
export type LogScanner = (q: ScanQuery) => ScanResult;

/**
 * One pass over `events` in id order (round 14), keeping no event: the running digest, each receipted event checked
 * against the digest its receipt holds, and a body for each merge event after `q.last`. WHY one pass (#918 round 14):
 * round 13 kept every row and parsed payload until signing ended, and a few large events or a few million small ones
 * ran every `sign`, and every successor, out of heap for good (the round-13 reviews, measured). Kept across rows: the
 * running digest, the expected digests (one per receipt), the latest engine version, and the bodies, refused as they
 * grow past `q.maxBytes`. Pure: the store runs it in a child process with a deadline and a heap limit (round 15).
 */
export function scanEvents(events: Iterable<ReceiptEvent>, q: ScanQuery): ScanResult {
  const last = BigInt(q.last);
  // The log as read now must hash, at each event already receipted, to what that receipt recorded: an event edited,
  // dropped or inserted before it is a log that changed under signed receipts, and nothing more is signed. Ids are
  // compared as BigInt, keyed by their decimal text (round 12). Every receipted id is at or before `last`, so every
  // check is done before the first new body.
  const expected = new Map<string, string>(q.expected);
  const changed = (event: string) => new ReceiptError(`the log changed under receipts already signed (at event ${event}: an event before it was edited, dropped or inserted, or it is gone); nothing was signed`);
  const allSeen = () => {
    const missing = [...expected.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))[0];
    if (missing !== undefined) throw changed(missing);
  };
  // An array (from a caller in memory) is put in id order; the store's rows come in id order, and are checked to.
  const ordered: Iterable<ReceiptEvent> = Array.isArray(events) ? [...(events as ReceiptEvent[])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)) : events;
  let digest = '';
  let first: string | null = null;
  let before: bigint | null = null;
  let version: string | null = null;
  let versionUnread: Unread | null = null;
  let skipped = 0;
  let bytes = 0;
  const items: Body[] = [];
  for (const e of ordered) {
    const eventId = BigInt(e.id);
    if (before !== null && eventId <= before) throw new ReceiptError(eventId === before ? `event ${eventId} appears twice in the log; nothing was signed` : `the log's events came out of id order (${eventId} after ${before}); nothing was signed`);
    before = eventId;
    digest = logDigest(digest, e);
    first ??= digest;
    const want = expected.get(eventId.toString());
    if (want !== undefined) {
      if (want !== digest) throw changed(eventId.toString());
      expected.delete(eventId.toString());
    }
    if (eventId > last) allSeen();
    if (e.type === 'coordinator.started') {
      // A coordinator.started that doesn't match its schema leaves the version unrecorded (null) for the decisions
      // after it, rather than ending the chain (#918 round 11, P3). One the store never read is cut as such (round 15).
      versionUnread = e.unread?.payload ?? null;
      const v = EventSchemas['coordinator.started'].safeParse(e.payload);
      version = v.success ? (v.data as EventPayload<'coordinator.started'>).version : null;
      continue;
    }
    // A merge event at an id <= 0 is never receipted (no receipt holds such an id): counted, so it is never passed
    // over silently (round 13, the round-12 second review's row 2).
    if (eventId <= 0n && (e.type === 'merge.decided' || e.type === 'merge.done' || e.type === 'merge.failed')) skipped++;
    if (eventId <= last) continue;
    const body = bodyOf(e, version, versionUnread, digest);
    if (!body) continue;
    bytes += Buffer.byteLength(canonicalJson(body), 'utf8');
    if (bytes > q.maxBytes) throw new ReceiptError(`the receipts would be over the ${q.maxBytes} bytes a receipts file may hold; nothing was written`);
    items.push(body);
  }
  allSeen();
  return { first, skipped, items };
}

/**
 * `existing` (verified as `state`) extended with a receipt for each merge event the log scan gives (`scan`), signed
 * here in order. `first`: the log's digest step at its first event (null: no event).
 */
function extend(existing: readonly unknown[], state: Extract<ChainResult, { ok: true }>, scan: LogScanner, signer: ReceiptSigner, now: () => string, after: Predecessor | null, maxBytes: number): { envelopes: Envelope[]; added: number; head: string | null; skipped: number; first: string | null } {
  const envelopes = [...(existing as Envelope[])];
  let bytes = envelopes.reduce((n, e) => n + Buffer.byteLength(canonicalJson(e), 'utf8') + 1, 0);
  let seq = state.count;
  let prev = state.head;
  const push = (body: Body) => {
    const { envelope, id } = seal({ ...body, schema: RECEIPT_SCHEMA, seq, prev } as Statement, signer);
    bytes += Buffer.byteLength(canonicalJson(envelope), 'utf8') + 1;
    // Stopped at the cap as it grows, never after (round 14: the receipts are the one thing kept in full).
    if (bytes > maxBytes) throw new ReceiptError(`the receipts would be over the ${maxBytes} bytes a receipts file may hold; nothing was written`);
    envelopes.push(envelope);
    seq++;
    prev = id;
    return id;
  };
  if (!state.count) push({ kind: 'chain.started', at: now(), key: keyRef(signer.publicKey), previous: after });
  const decided = new Map<string, string>();
  // A successor chain receipts only events after the last one the chain it succeeds receipted (#918 round 9).
  let last = state.count ? 0n : BigInt(after?.event ?? '0');
  for (const [i, s] of state.statements.entries()) {
    if (s.kind === 'chain.started') last = BigInt(s.previous?.event ?? '0');
    if (s.kind === 'merge.decided') decided.set(`${s.inputs.pr}@${s.inputs.head}`, state.ids[i]!);
    if (isEventReceipt(s)) last = BigInt(s.event);
  }
  const expected: [string, string][] = state.statements.filter(isEventReceipt).map((s) => [s.event, s.log.digest]);
  const s = scan({ last: last.toString(), expected, maxBytes });
  for (const item of s.items) {
    const body = item as Body;
    // A result names the chain's latest decision for its PR head, which only the signer knows (its receipt ids).
    if (body.kind === 'merge.result') body.decision = decided.get(`${body.pr}@${body.head}`) ?? null;
    const id = push(body);
    if (body.kind === 'merge.decided') decided.set(`${body.inputs.pr}@${body.inputs.head}`, id);
  }
  return { envelopes, added: seq - state.count, head: prev, skipped: s.skipped, first: s.first };
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
  // WHY (#918 round 11, P7): verify refuses a successor that rotates to a key of the chain it succeeds, so the
  // signer never writes one.
  const started = state.statements[0];
  if (started?.kind === 'chain.started' && started.previous?.keys.includes(keyId(next))) throw new ReceiptError('the next key signed the chain this one succeeds: a successor never rotates to it; nothing was rotated');
  const { envelope } = seal({ schema: RECEIPT_SCHEMA, seq: state.count, prev: state.head, kind: 'key.rotated', at: now(), next: keyRef(next) }, signer);
  return [...(existing as Envelope[]), envelope];
}
