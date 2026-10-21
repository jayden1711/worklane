// Signed receipts on disk (#717): the event log read read-only, the receipts as JSON lines (one DSSE envelope each),
// the signer's own chain state, and ed25519 keys as PEM files. The format and the checks are src/signed-receipts.ts.
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BRAND } from './brand.js';
import { openReadOnly } from './events/read-only.js';
import { tryLock } from './locks.js';
import { notOwnerOnlyDir, processIdentity, processPlace, replaceOwnerOnly, syncToDisk, UNKNOWN_IDENTITY } from './os/index.js';
import { AT_UNRECORDED, canonicalJson, chainStateOf, ChainStateSchema, keyId, keySigner, predecessorOf, predecessorOfState, ReceiptError, RECEIPT_EVENTS, rotateChain, signEvents, statementOf, type ChainState, type Envelope, type Predecessor, type ReceiptEvent, type ReceiptSigner } from './signed-receipts.js';

/**
 * Every event in an events database opened read-only, oldest first, each with its payload as stored (`raw`, for the
 * log digest). Only the kinds receipts are made from are parsed.
 */
export function readReceiptEvents(dbPath: string): ReceiptEvent[] {
  if (!existsSync(dbPath)) throw new ReceiptError(`no event log at ${dbPath}`);
  const read: ReadonlySet<string> = new Set(RECEIPT_EVENTS);
  const db = openReadOnly(dbPath);
  try {
    const query = db.prepare('SELECT id, ts, type, actor, payload FROM events ORDER BY id');
    // Every integer read as a BigInt (#918 round 12): an id past 2^53 is read exactly, never refused as "too large".
    query.setReadBigInts(true);
    const rows = query.all() as { id: bigint; ts: unknown; type: unknown; actor: unknown; payload: unknown }[];
    // A payload that isn't JSON reads as undefined: its event is then signed as unsignable, never ending the chain
    // (#918 round 11, P3).
    const json = (text: string): unknown => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    };
    return rows.map((r) => ({ id: BigInt(r.id), ts: String(r.ts), type: String(r.type), actor: String(r.actor), raw: String(r.payload), payload: read.has(String(r.type)) ? json(String(r.payload)) : undefined }));
  } finally {
    db.close();
  }
}

/**
 * The most bytes of receipts read for one chain, all its files together (some 30,000 ordinary receipts, but only
 * about 40 of the worst case: a receipt can be about 1.6 MB, docs/design.md §5a `cut`). WHY (#918 round 4,
 * A7): a file in a receipts directory is whatever its writer put there; a huge one is refused from its size.
 */
export const RECEIPTS_MAX_BYTES = 64 * 1024 * 1024;
/** The most bytes a signer's chain state file holds: its fixed receipts are a chain's prefix (#918 round 7). */
const STATE_MAX_BYTES = RECEIPTS_MAX_BYTES;

/**
 * A regular file's text, at most `max` bytes: never through a link, never a FIFO, device or directory (#918 round 4,
 * A7: a FIFO named `x.jsonl` hung verify, and a link to /dev/zero would have grown it without bound). The file is
 * opened without following a link and without waiting on a FIFO, and checked through that descriptor, so what is
 * checked is what is read. `what` names it in a refusal.
 */
function readRegular(file: string, max: number, what: string, oneName = false): string {
  // Where the OS has no O_NOFOLLOW (native Windows), this check is the one that refuses a link.
  if (lstatSync(file).isSymbolicLink()) throw new ReceiptError(`${what} ${file} is a link: only a regular file is read`);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ReceiptError(`${what} ${file} ${code === 'ELOOP' || code === 'EMLINK' ? 'is a link: only a regular file is read' : `can't be read (${code ?? (e as Error).message})`}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ReceiptError(`${what} ${file} is not a regular file (a FIFO, device or directory): only a regular file is read`);
    if (st.size > max) throw new ReceiptError(`${what} ${file} is ${st.size} bytes, over the ${max} read here`);
    if (oneName && st.nlink !== 1) throw new ReceiptError(`${what} ${file} has ${st.nlink} names (a hard link): refused`);
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > st.size) throw new ReceiptError(`${what} ${file} grew while it was read`);
    const bytes = buf.subarray(0, n);
    const text = bytes.toString('utf8');
    // Compared as bytes (#918 round 7 advisory): a byte that isn't UTF-8 would decode to U+FFFD and read the same as
    // a real one, so a file that isn't valid UTF-8 is refused.
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new ReceiptError(`${what} ${file} is not valid UTF-8: refused`);
    return text;
  } finally {
    closeSync(fd);
  }
}

/**
 * The receipts in a file (JSON lines), or in a directory's *.jsonl files in name order, as one chain. A missing file
 * is no receipts (a chain not started yet). Only regular files are read, at most RECEIPTS_MAX_BYTES in all (a link,
 * FIFO or device is refused, the path given included). A line that isn't JSON throws, naming it.
 */
export function readReceiptFiles(path: string): unknown[] {
  const top = lstatSync(path, { throwIfNoEntry: false });
  if (!top) return [];
  const files = top.isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .map((f) => join(path, f))
    : [path];
  let budget = RECEIPTS_MAX_BYTES;
  return files.flatMap((file) => {
    const text = readRegular(file, budget, 'receipts file');
    budget -= Buffer.byteLength(text, 'utf8');
    return text.split('\n').flatMap((line, i) => {
      // Only an empty line is skipped (the one after the last newline); a line of whitespace is not canonical JSON.
      if (line === '') return [];
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new ReceiptError(`${file}:${i + 1} is not JSON`);
      }
      // WHY (#918 round 6, row 8): a line is exactly the canonical JSON of what it holds, as the signer writes it. A
      // duplicate key (JSON.parse keeps the last; another reader may keep the first), other spacing or key order is
      // refused, so no reader can read a line two ways.
      let canonical: string | null = null;
      try {
        canonical = canonicalJson(value);
      } catch {
        canonical = null;
      }
      if (canonical !== line) throw new ReceiptError(`${file}:${i + 1} is not one receipt in canonical JSON (a duplicate key, other spacing or key order): refused`);
      return [value];
    });
  });
}

/** Replace the receipts file (replaceOwnerOnly: never through a name planted beside it; #918 round 4, A11). */
/**
 * The receipts file's text, refused over RECEIPTS_MAX_BYTES before anything is written (#918 round 9, route 2: a
 * receipts file over the cap was written after the state, and nothing could read it back). writeReceipts publishes it.
 */
function receiptsText(envelopes: readonly Envelope[]): string {
  const text = `${envelopes.map((e) => canonicalJson(e)).join('\n')}\n`;
  if (Buffer.byteLength(text, 'utf8') > RECEIPTS_MAX_BYTES) throw new ReceiptError(`the receipts would be over the ${RECEIPTS_MAX_BYTES} bytes a receipts file may hold; nothing was written`);
  return text;
}

function writeReceipts(path: string, text: string): void {
  replaceOwnerOnly(path, text);
}

/** `--out` is one receipts file for sign and rotate: a directory there is refused before anything is written. */
function outIsFile(out: string): void {
  if (lstatSync(out, { throwIfNoEntry: false })?.isDirectory()) throw new ReceiptError(`--out ${out} is a directory: sign and rotate write one receipts file; nothing was written`);
}

/**
 * Where the signer keeps its chain state, checked, as the one path every later step uses: the state's directory
 * resolved ONCE to its real path, joined with the file's name. Checked:
 * - the directory as given is only this user's (notOwnerOnlyDir): not a link itself, and no directory on the way
 *   (nor any link there) can be changed by another user (ownedPath), so no one else can redirect it;
 * - its real directory is only this user's too, and isn't the receipts' (compared by real path), nor inside `--out`.
 * WHY (#918 round 6, row 1): round 5 checked the real path but read and wrote the path as given, so a directory link
 * in a directory others could write, flipped after the check, made the signer read a set-back state.
 */
function statePlace(state: string, out: string): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const stateDir = real(dirname(resolve(state)));
  const outDir = real(dirname(resolve(out)));
  const rel = relative(join(outDir, basename(out)), join(stateDir, basename(state)));
  const inOut = rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (stateDir === outDir || inOut) {
    throw new ReceiptError(`the signer's chain state must be kept separate from the receipts: ${state} is in the directory of ${out}`);
  }
  return ownedStatePath(state);
}

/**
 * A chain state's path, checked and resolved once (statePlace, and an ended chain's state for --after): the directory
 * as given, then its real one, must be only this user's. notOwnerOnlyDir refuses a link as the directory itself, and
 * its ownedPath a path any other user can redirect (on Linux, any link on the way: a link's own mode reads 0777). From
 * here on only the real path is used, so a link flipped after this check changes nothing read or written.
 */
function ownedStatePath(state: string): string {
  const given = dirname(resolve(state));
  let real = resolve(given);
  try {
    real = realpathSync(given);
  } catch {
    // Missing: notOwnerOnlyDir names it below.
  }
  const why = notOwnerOnlyDir(given) ?? notOwnerOnlyDir(real);
  if (why) throw new ReceiptError(`the signer's chain state goes in a directory only the signer can write, reached through no link: ${why}`);
  return join(real, basename(state));
}

/**
 * The signer's chain state file's text, or null when there is none. Refused: a link, a file that isn't one, or one
 * with a second name (a hard link would be a second path to it, and a second lock: #918 round 6, row 5).
 */
function readStateText(path: string): string | null {
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  try {
    return readRegular(path, STATE_MAX_BYTES, "the signer's chain state", true);
  } catch (e) {
    // Every unreadable state (a link, a second name, over the cap, not UTF-8) gets the same guidance (#918 round 9).
    if (e instanceof ReceiptError) throw new ReceiptError(`${e.message}; nothing was signed. ${CHAIN_ENDS}`);
    throw e;
  }
}

/** What every refusal over an unreadable state says (#918 rounds 8 and 9). */
const CHAIN_ENDS = 'This chain ends here: an older copy of the state is never restored (it would let this key sign a published decision again), and a new chain takes a new key, started with --genesis --after naming this chain';

/** The signer's chain state from its file's text (readStateText), or null when it has none. */
function parseState(path: string, text: string | null): ChainState | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const st = ChainStateSchema.safeParse(parsed);
  if (!st.success) throw new ReceiptError(`the signer's chain state ${path} is unreadable; nothing was signed. ${CHAIN_ENDS}`);
  return st.data;
}

/**
 * The signer's chain state, written BEFORE the receipts it names (#918 round 5; see signLog), and flushed to disk
 * before they are written (syncToDisk): without that, a power loss could keep the new receipts and an older state.
 */
function writeState(path: string, state: ChainState): void {
  // No copy of the state it replaces is kept (#918 round 7: round 6's `<state>.prev` was a way to roll the signer
  // back; the fixed receipts in the state make every recovery a give-back instead).
  const text = `${canonicalJson(state)}\n`;
  // Never a state the next run couldn't read back (#918 round 8 advisory): refused before anything is written.
  if (Buffer.byteLength(text, 'utf8') > STATE_MAX_BYTES) throw new ReceiptError(`the signer's chain state would be over ${STATE_MAX_BYTES} bytes; nothing was written`);
  replaceOwnerOnly(path, text);
  syncToDisk(path);
}

/** The signer's lock: one per state directory (#918 round 6, row 5: one per state path let a hard-linked alias in). */
const SIGNER_LOCK = '.receipts-signer.lock';

/**
 * Called by tryLock when it judged the lock at `lock` stale (its pid answers no signal from here), before it takes
 * it over: refuses unless the lock was taken in this very place (the same pid namespace, boot and host, each known).
 * WHY (#918 round 6, row 2): a holder in another pid namespace, or on another host sharing the directory, looks dead
 * from here while it runs, and was taken over. A lock that can't be read is never taken over either. Fails closed:
 * such a lock stays until the owner removes it, once no signer runs. tryLock itself is unchanged for its other callers.
 */
function samePlace(lock: string, here: ReturnType<typeof processPlace>): void {
  let theirs: unknown;
  try {
    if (!lstatSync(lock, { throwIfNoEntry: false })) return; // gone meanwhile: tryLock competes for it afresh
    theirs = JSON.parse((JSON.parse(readRegular(lock, 4096, 'the signer lock')) as { owner?: string }).owner ?? '');
  } catch {
    theirs = null;
  }
  const t = theirs as Partial<ReturnType<typeof processPlace>> | null;
  const known = here.pidns && here.boot;
  if (!t || !known || t.pidns !== here.pidns || t.boot !== here.boot || t.host !== here.host) {
    throw new ReceiptError(`the signer lock ${lock} names a process this one can't check (another pid namespace, boot or host, or unreadable): never taken over. Remove it by hand once no signer runs; nothing was signed`);
  }
}

/**
 * Run `fn` as the only signer of the chain state at `state` (#918 round 5, row 2: two `sign` runs at once, with the
 * log edited between their reads, each signed its own version of an event). An exclusive lock in the state's
 * owner-only directory (SIGNER_LOCK, by tryLock: created whole or not at all) is held from the first read to the last
 * write; one already held refuses. A lock whose pid is gone is taken over only when it was taken in the same pid
 * namespace, boot and host (samePlace). A pid reused since makes a dead holder look alive: refused, and the owner
 * removes the lock. And the state must still be what `fn` read just before it writes (`unchanged`): a writer that
 * took no lock is refused too.
 */
function asOnlySigner<T>(state: string, fn: (own: ChainState | null, unchanged: () => void, save: (next: ChainState) => void) => T): T {
  return withLock(join(dirname(state), SIGNER_LOCK), "another sign or rotate holds the signer's lock", () => {
    const text = readStateText(state);
    const unchanged = () => {
      if (readStateText(state) !== text) throw new ReceiptError(`the signer's chain state ${state} changed while this run signed (another writer); nothing was written`);
    };
    return fn(parseState(state, text), unchanged, (next) => writeState(state, next));
  });
}

/**
 * Run `fn` holding the exclusive lock at `lock` (tryLock, checked by samePlace and holderGone as asOnlySigner says),
 * or refuse with `busy`. A FIFO or anything else at the lock's name would hang or fool the lock's reader: refused
 * before it reads.
 */
function withLock<T>(lock: string, busy: string, fn: () => T): T {
  const there = lstatSync(lock, { throwIfNoEntry: false });
  if (there && !there.isFile()) throw new ReceiptError(`${lock} is not a regular file: remove it by hand once no signer runs; nothing was signed`);
  const place = processPlace();
  const got = tryLock(lock, JSON.stringify({ by: `${BRAND.cli} receipts`, ...place, identity: processIdentity(process.pid) }), { inspected: () => samePlace(lock, place) });
  if (!('lock' in got)) throw new ReceiptError(`${holderGone(got.holder, place) ? `the lock ${lock} names pid ${got.holder?.pid}, which now belongs to another process (a pid reused since its holder died): remove the lock by hand once no signer runs` : `${busy} (${lock}${got.holder ? `, pid ${got.holder.pid}` : ''})`}; nothing was signed`);
  try {
    return fn();
  } finally {
    got.lock.release();
  }
}

/**
 * Whether a lock whose pid answers signal 0 was taken by a process that is gone: taken in this very place, recording
 * the holder's identity (processIdentity: boot and start time), which that pid no longer has. Still refused, never
 * taken over (tryLock, shared, takes over only a pid that answers no signal), but named for what it is, so the owner
 * knows the lock is safe to remove (#918 round 6: a reused pid makes a dead holder look alive).
 */
function holderGone(holder: { pid: number; owner: string } | null, here: ReturnType<typeof processPlace>): boolean {
  if (!holder) return false;
  try {
    const t = JSON.parse(holder.owner) as Partial<ReturnType<typeof processPlace>> & { identity?: string | null };
    if (!here.pidns || !here.boot || t.pidns !== here.pidns || t.boot !== here.boot || t.host !== here.host || !t.identity || t.identity === UNKNOWN_IDENTITY) return false;
    const now = processIdentity(holder.pid);
    return now !== UNKNOWN_IDENTITY && now !== t.identity;
  } catch {
    return false;
  }
}

/** An ed25519 private key from a PEM file, as a signer. */
export function loadSigner(path: string): ReceiptSigner {
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ReceiptError(`${path} is not a readable private key (${(e as Error).message.split('\n')[0]})`);
  }
  return keySigner(key);
}

/** An ed25519 public key from a PEM file. A private key is refused: a verifier is never handed one. */
export function loadPublicKey(path: string): KeyObject {
  const text = readFileSync(path, 'utf8');
  if (/PRIVATE KEY/.test(text)) throw new ReceiptError(`${path} is a private key: verify takes the public key (keygen's --public file)`);
  let key: KeyObject;
  try {
    key = createPublicKey(text);
  } catch (e) {
    throw new ReceiptError(`${path} is not a readable public key (${(e as Error).message.split('\n')[0]})`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new ReceiptError(`${path} is not an ed25519 key`);
  return key;
}

/**
 * Receipt every merge decision and result in the log not yet receipted, onto the chain in `out`, from the signer's
 * own chain state in `state` (#918 rounds 4 and 5), as the only signer (asOnlySigner). With no state, only `genesis`
 * starts a chain, and only where nothing is at `out`; with one, `genesis` is refused and `out` must extend it, or be
 * short of it by receipts the log gives back exactly (signEvents). Writes nothing when there is nothing new, or when
 * it refuses (src/signed-receipts.ts).
 *
 * INVARIANT: the state is written BEFORE the receipts. A run that fails or is killed between the two leaves the state
 * ahead of the receipts, never receipts the state doesn't cover (#918 round 4 review, row 1: receipts first let a cut
 * file and an edited log be signed again). The next run gives the missing receipts back only if the log still makes
 * them byte for byte; otherwise it refuses.
 */
export function signLog(o: { log: string; out: string; state: string; genesis?: boolean; after?: string; registry?: string; signer: ReceiptSigner }): SignResult {
  const statePath = statePlace(o.state, o.out);
  outIsFile(o.out);
  if (o.after !== undefined && !o.genesis) throw new ReceiptError('--after names the chain a new chain succeeds: it goes with --genesis only');
  if (o.genesis && o.registry === undefined) throw new ReceiptError("--genesis needs the signer's chain registry (--registry): every chain start is recorded there; nothing was signed");
  if (!o.genesis && o.registry !== undefined) throw new ReceiptError('--registry goes with --genesis only: an existing chain names its registry in its state');
  const registry = o.registry === undefined ? null : registryPlace(o.registry, statePath);
  if (o.after === undefined) return signAs(o, statePath, registry, null);
  // The new chain's own preconditions first, so nothing is looked at for a successor that can't start (they are
  // checked again under its lock).
  if (lstatSync(statePath, { throwIfNoEntry: false })) throw new ReceiptError(`the signer already has a chain (its state is ${o.state}): --genesis never starts over it; nothing was signed`);
  if (lstatSync(o.out, { throwIfNoEntry: false })) throw new ReceiptError(`--genesis never replaces anything at --out (${o.out}); nothing was signed`);
  const after = o.after;
  const oldPath = chainStateAt(after);
  if (oldPath === null) return signAs(o, statePath, registry, fromCopy(after, o.log, o.signer, registry!, statePath));
  if (dirname(oldPath) === dirname(statePath)) throw new ReceiptError(`a successor's state goes in a directory of its own, not the ended chain's (${dirname(oldPath)}); nothing was signed`);
  // WHY (#918 round 12, Race C): the ended chain's lock is held from the read of its state through its ended mark, so
  // it can't sign, rotate or be succeeded meanwhile. Round 11 read the state unlocked and locked it only for the mark:
  // a `sign` of the ended chain in between signed the events its successor also signed (the round-11 delta check).
  return withLock(join(dirname(oldPath), SIGNER_LOCK), `the chain at ${after} is signing or rotating (it holds its signer lock): succeed it once that run ends`, () =>
    signAs(o, statePath, registry, fromState(oldPath, o.signer, registry!)),
  );
}

/** What `sign` did: the receipts it added, the chain's length and head, and how many it couldn't read (round 12). */
export type SignResult = { added: number; count: number; head: string | null; unsignable: number; unrecorded: number };

/**
 * signLog's body, as the only signer of the chain at `statePath` (asOnlySigner). `after`: the chain a new chain
 * succeeds; its lock is already held when it is read from its state (signLog).
 */
function signAs(o: { log: string; out: string; state: string; genesis?: boolean; signer: ReceiptSigner }, statePath: string, registry: string | null, after: Ended | null): SignResult {
  return asOnlySigner(statePath, (own, unchanged, save) => {
    if (own && o.genesis) throw new ReceiptError(`the signer already has a chain (its state is ${o.state}): --genesis never starts over it; nothing was signed`);
    if (!own && !o.genesis) throw new ReceiptError(`the signer has no chain state at ${o.state}: a new chain starts only with --genesis (root or the owner only); nothing was signed`);
    if (o.genesis && lstatSync(o.out, { throwIfNoEntry: false })) {
      throw new ReceiptError(`--genesis never replaces anything at --out (${o.out}): receipts there are someone else's chain, never adopted; nothing was signed`);
    }
    if (own) checkRegistry(own, statePath);
    const existing = readReceiptFiles(o.out);
    const r = signEvents(existing, readReceiptEvents(o.log), o.signer, { from: own ?? 'genesis', ...(after ? { after: after.previous } : {}) });
    const text = r.added ? receiptsText(r.envelopes) : null;
    unchanged();
    let ref = own?.registry ?? null;
    if (!own) {
      // WHY (#918 rounds 11 and 12): every chain start is recorded in the signer's registry before its first receipt,
      // and the ended chain is marked only now, once the successor's receipts are computed: a failure that depends on
      // the log burns nothing (round-10 review, P3a). Its head must still be the one the successor names.
      if (after?.held) stillAt(after.held, after.previous);
      ref = recordStart(registry!, o.signer, statePath, realLog(o.log), after);
      if (after?.held) markEnded(after.held, after.previous, o.signer);
    }
    const next = { ...r.state, registry: ref };
    if (!own || canonicalJson(own) !== canonicalJson(next)) save(next);
    if (text !== null) writeReceipts(o.out, text);
    const added = r.envelopes.slice(existing.length).map((e) => statementOf(e) as { kind?: string; at?: string });
    return {
      added: r.added,
      count: r.envelopes.length,
      head: r.head,
      unsignable: added.filter((s) => s.kind === 'event.unsignable').length,
      unrecorded: added.filter((s) => s.kind !== 'chain.started' && s.kind !== 'key.rotated' && s.at === AT_UNRECORDED).length,
    };
  });
}

/** The event log's real path (as a registry's start line records it), or the path as given when it can't be resolved. */
function realLog(log: string): string {
  try {
    return realpathSync(log);
  } catch {
    return resolve(log);
  }
}

/** The schema of the signer's chain registry's lines (RegistryLine); a signer refuses any other. */
export const REGISTRY_SCHEMA = `${BRAND.cli}.receipt-registry/v1`;
const registryFields = { schema: z.literal(REGISTRY_SCHEMA), seq: z.number().int().min(0), prev: z.string().regex(/^[0-9a-f]{64}$/).nullable() };
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
/**
 * One line of the signer's chain registry (#918 rounds 11 and 12), hash-chained like the receipts (`prev` is the
 * SHA-256 of the line before), so an edit breaks it. A chain is known by its start line's id (lineId), which its state
 * keeps (`registry.head`), never by where its state sits (round 12: round 11 matched a chain's end by its state's path,
 * and a renamed state directory signed on beside its successor).
 * - start: a chain started: its key, its state's real path, the event log's real path, and `previous`, the chain it
 *   succeeds (that chain's start line id, and the head it succeeded) or null for the registry's one first chain. A
 *   start line naming a chain in `previous` is that chain's end: one line, written at once.
 * - rotate: the chain whose start line is `chain` rotated to `key`: that key then signed a chain, so it never starts
 *   one (row 3b: a cut copy hides it).
 */
const RegistryLine = z.discriminatedUnion('kind', [
  z.strictObject({ ...registryFields, kind: z.literal('start'), key: hex64, state: z.string().min(1), log: z.string().min(1), previous: z.strictObject({ chain: hex64, head: hex64 }).nullable() }),
  z.strictObject({ ...registryFields, kind: z.literal('rotate'), chain: hex64, key: hex64 }),
]);
type RegistryLine = z.infer<typeof RegistryLine>;
type StartLine = Extract<RegistryLine, { kind: 'start' }>;
type Registry = { path: string; lines: RegistryLine[]; ids: string[] };
const REGISTRY_LOCK = '.receipts-registry.lock';
const lineId = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The registry's path, checked and resolved once (as ownedStatePath does for a state): in a directory only the signer
 * can write, and not a chain state's own directory ("outside any per-chain --state").
 */
function registryPlace(path: string, statePath: string): string {
  const real = ownedStatePath(path);
  if (dirname(real) === dirname(statePath)) throw new ReceiptError(`the signer's chain registry goes outside any chain's state directory: ${path} is beside ${statePath}`);
  return real;
}

/** The registry at `path` as a verified hash chain (missing: no lines). Refused: not regular, not canonical, broken. */
function readRegistry(path: string): Registry {
  if (!lstatSync(path, { throwIfNoEntry: false })) return { path, lines: [], ids: [] };
  const text = readRegular(path, STATE_MAX_BYTES, "the signer's chain registry", true);
  const lines: RegistryLine[] = [];
  const ids: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line === '') continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    const r = RegistryLine.safeParse(parsed);
    let canonical: string | null = null;
    try {
      canonical = canonicalJson(parsed);
    } catch {
      canonical = null;
    }
    if (!r.success || canonical !== line || r.data.seq !== lines.length || r.data.prev !== (ids.at(-1) ?? null)) {
      throw new ReceiptError(`the signer's chain registry ${path} is broken at line ${i + 1} (edited, reordered or not a registry line); nothing was signed. ${CHAIN_ENDS}`);
    }
    lines.push(r.data);
    ids.push(lineId(line));
  }
  return { path, lines, ids };
}

/**
 * The start line of the chain whose state is `own` (read from `statePath`), in the registry that state names: it must
 * still be there, at the place the state recorded, for this chain's start key. Refused otherwise: a registry deleted,
 * cut short of this line, replaced or edited. A cut or an older copy that still holds this line is NOT refused here
 * (round 12 scopes round 11's claim): that is the signer user's own act (docs/design.md §5a, the trust model).
 */
function startOf(own: ChainState, statePath: string): { reg: Registry; line: StartLine; chain: string } {
  if (!own.registry) throw new ReceiptError(`the chain state ${statePath} names no registry; nothing was signed. ${CHAIN_ENDS}`);
  const reg = readRegistry(own.registry.path);
  const line = reg.lines[own.registry.count - 1];
  if (reg.ids[own.registry.count - 1] !== own.registry.head || line?.kind !== 'start' || line.key !== own.start.keyid) {
    throw new ReceiptError(`the signer's chain registry ${own.registry.path} no longer holds the start of the chain at ${statePath} (deleted, cut or replaced); nothing was signed. ${CHAIN_ENDS}`);
  }
  return { reg, line, chain: own.registry.head };
}

/** The start line that succeeds the chain whose start line id is `chain` (that chain's end), if any. */
const successorOf = (reg: Registry, chain: string): StartLine | undefined => reg.lines.find((l): l is StartLine => l.kind === 'start' && l.previous?.chain === chain);

/**
 * A state must sit where its chain's start line recorded it. WHY (#918 round 12, the round-11 reviews' row 3 and
 * 3.2): a renamed state directory looked unreadable at its recorded path, so a successor started from a receipts copy,
 * while the chain signed on at its new path. A chain is known by its start line, and its state never moves.
 */
function inPlace(line: StartLine, statePath: string): void {
  if (line.state !== statePath) {
    throw new ReceiptError(`this chain's start was recorded with its state at ${line.state}, and the state is at ${statePath} now: a chain's state never moves (a moved state signing beside a successor started from a copy was a fork). Put it back where it was recorded; nothing was signed`);
  }
}

/**
 * The registry an existing chain names in its state must still hold that chain's start line (startOf), no start line
 * may name it as the chain it succeeds (an ended chain), and the state must sit where its start was recorded (inPlace).
 */
function checkRegistry(own: ChainState, statePath: string): void {
  const { reg, line, chain } = startOf(own, statePath);
  const next = successorOf(reg, chain);
  if (next) throw new ReceiptError(`this chain ended: key ${next.key} started its successor (the signer's registry says so). An ended chain never signs or rotates again; nothing was signed`);
  inPlace(line, statePath);
}

/**
 * A successor's view of the chain it succeeds: its `previous`, its start line's id in the registry (`chain`), and,
 * when read from its state, that state as read under its lock (`held`), to check and mark.
 */
type Ended = { previous: Predecessor; chain: string; held: { path: string; text: string | null } | null };

/**
 * Record a chain start in the registry, under the registry's lock. Its line names the chain it succeeds, which ends that
 * chain. The rules that make a successor fork impossible (#918 rounds 11 and 12):
 * - a key that ever started a chain, or was rotated into one, never starts another;
 * - a registry holds one first chain (`previous: null`), for one event log; every later chain is a successor (round
 *   12: round 11 took a second first chain beside a recorded one, which signed the log again from event 1);
 * - a chain is succeeded at most once;
 * - a run that only finishes its own interrupted start records nothing new, and only as what its line recorded: the
 *   same state, log and `previous` (round 12: a successor's start finished as a first chain signed from event 1).
 * Returns the registry reference the new state keeps.
 */
function recordStart(registry: string, signer: ReceiptSigner, statePath: string, log: string, after: Ended | null): NonNullable<ChainState['registry']> {
  return withLock(join(dirname(registry), REGISTRY_LOCK), "another genesis holds the signer's registry lock", () => {
    const reg = readRegistry(registry);
    const mine = keyId(signer.publicKey);
    const previous = after ? { chain: after.chain, head: after.previous.head } : null;
    const at = reg.lines.findIndex((l) => l.kind === 'start' && l.key === mine);
    const line = reg.lines[at];
    if (line?.kind === 'start') {
      if (line.state !== statePath) throw new ReceiptError(`this key (${mine}) already started a chain (the signer's registry, at ${line.state}): a key starts one chain only; nothing was signed`);
      if (canonicalJson(line.previous) !== canonicalJson(previous)) {
        throw new ReceiptError(
          line.previous
            ? `this key's start was recorded as the successor of the chain whose start line is ${line.previous.chain}, after its head ${line.previous.head}: finish it only with --genesis --after that chain; nothing was signed`
            : `this key's start was recorded as the registry's first chain (previous: null): finish it only with a plain --genesis, never --after; nothing was signed`,
        );
      }
      if (line.log !== log) throw new ReceiptError(`this key's start was recorded over the event log ${line.log}: finish it over that log; nothing was signed`);
      // Finishing an interrupted start, as recorded: its line is there already.
      return { path: registry, count: at + 1, head: reg.ids[at]! };
    }
    const rotated = reg.lines.find((l) => l.kind === 'rotate' && l.key === mine);
    if (rotated) throw new ReceiptError(`this key (${mine}) already signed a chain, rotated to in the chain whose start line is ${rotated.kind === 'rotate' ? rotated.chain : ''} (the signer's registry): a key starts no chain after that; nothing was signed`);
    const starts = reg.lines.filter((l): l is StartLine => l.kind === 'start');
    const other = starts.find((l) => l.log !== log);
    if (other) throw new ReceiptError(`the signer's chain registry ${registry} serves the event log ${other.log}, not ${log}: a registry serves one instance's log (a signer for several instances keeps a registry and a key for each); nothing was signed`);
    if (!previous && starts.length) {
      throw new ReceiptError(`the signer's chain registry ${registry} already holds its first chain (previous: null, key ${starts[0]!.key}): a registry holds one, and every later chain succeeds one (--genesis --after); nothing was signed`);
    }
    if (previous) {
      const i = reg.ids.indexOf(previous.chain);
      if (reg.lines[i]?.kind !== 'start') throw new ReceiptError(`the chain to succeed isn't in the signer's registry ${registry}; nothing was signed`);
      const next = successorOf(reg, previous.chain);
      if (next) throw new ReceiptError(`the chain to succeed already has a successor, started by key ${next.key} (the signer's registry): a chain has one successor; nothing was signed`);
    }
    return appendRegistry(reg, [{ kind: 'start', key: mine, state: statePath, log, previous }]);
  });
}

type RegistryAdd = { kind: 'start'; key: string; state: string; log: string; previous: { chain: string; head: string } | null } | { kind: 'rotate'; chain: string; key: string };

/** Append `add` to the registry `reg` (read under its lock), flushed to disk; its count and head after. */
function appendRegistry(reg: Registry, add: readonly RegistryAdd[]): NonNullable<ChainState['registry']> {
  const lines = reg.lines.map((l) => canonicalJson(l));
  let prev = reg.ids.at(-1) ?? null;
  for (const a of add) {
    const line = canonicalJson(RegistryLine.parse({ ...a, schema: REGISTRY_SCHEMA, seq: lines.length, prev }));
    lines.push(line);
    prev = lineId(line);
  }
  const text = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(text, 'utf8') > STATE_MAX_BYTES) throw new ReceiptError("the signer's chain registry would be over its cap; nothing was signed");
  replaceOwnerOnly(reg.path, text);
  syncToDisk(reg.path);
  return { path: reg.path, count: lines.length, head: prev! };
}

/** Record a rotation of the chain `own` to `next` in its registry (round 11, row 3b), before it is written. */
function recordRotate(own: ChainState, next: string): void {
  const registry = own.registry!.path;
  withLock(join(dirname(registry), REGISTRY_LOCK), "another genesis or rotate holds the signer's registry lock", () => {
    const reg = readRegistry(registry);
    if (reg.lines.some((l) => (l.kind === 'start' || l.kind === 'rotate') && l.key === next)) throw new ReceiptError(`the next key (${next}) already signed a chain (the signer's registry): a key signs one chain only; nothing was rotated`);
    appendRegistry(reg, [{ kind: 'rotate', chain: own.registry!.head, key: next }]);
  });
}

/**
 * The chain a new chain succeeds (`--after`), from that chain's own state file, or from a copy of its receipts (a file
 * or a directory). WHY (#918 round 9, route 1): after a chain ends, a new one started from event 1 signed the edited
 * log the old one refused. A successor names its predecessor and starts after its last event, with a key that never
 * signed it. A copy of the receipts shorter than what the old chain signed would let the successor sign events the old
 * one also signed: give the state when it can be read (docs/design.md §5a).
 */
/**
 * The real path of the chain state `--after` names, or null when it names a copy of receipts instead (a directory, or
 * a file that isn't a chain state). Only picks the route: the state is read again, under its lock (fromState).
 */
function chainStateAt(path: string): string | null {
  const there = lstatSync(path, { throwIfNoEntry: false });
  if (!there) throw new ReceiptError(`--after ${path}: nothing there; give the ended chain's state, or a copy of its receipts`);
  if (there.isDirectory()) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readRegular(path, STATE_MAX_BYTES, 'the chain to succeed'));
  } catch (e) {
    if (e instanceof ReceiptError) throw e;
    parsed = null;
  }
  return ChainStateSchema.safeParse(parsed).success ? ownedStatePath(path) : null;
}

/**
 * The chain a new chain succeeds (`--after`), from that chain's own state, read under its lock (signLog holds it until
 * the mark). WHY (#918 round 9, route 1): after a chain ends, a new one started from event 1 signed the edited log the
 * old one refused. A successor names its predecessor and starts after its last event, with a key that never signed it.
 * The state must sit where its start line recorded it (round 12: a stale copy elsewhere would name an older head).
 */
function fromState(path: string, signer: ReceiptSigner, registry: string): Ended {
  const text = readStateText(path);
  const own = parseState(path, text);
  if (!own) throw new ReceiptError(`--after ${path}: the chain state is gone; nothing was signed`);
  const mine = keyId(signer.publicKey);
  const p = predecessorOfState(own);
  if (p.keys.includes(mine)) throw new ReceiptError(`this key (${mine}) signed the chain it would succeed: a successor takes a new key; nothing was signed`);
  if (own.ended && own.ended.successor !== mine) throw new ReceiptError(`the chain at ${path} already has a successor, started by key ${own.ended.successor}: a chain has one successor; nothing was signed`);
  if (!own.registry || own.registry.path !== registry) throw new ReceiptError(`the chain at ${path} is recorded in another registry (${own.registry?.path ?? 'none'}): a successor is recorded where its predecessor was; nothing was signed`);
  const { line, chain } = startOf(own, path);
  inPlace(line, path);
  return { previous: p, chain, held: { path, text } };
}

/**
 * The chain a new chain succeeds, from a copy of its receipts (a file or a directory), for a chain whose state can't
 * be read. Round 10 (#918 round-9 review rows 3 and 3b): a copy may be cut short, before events the ended chain signed,
 * or before a rotation to a key it doesn't name. So the successor starts after the log's last event now, whatever the
 * copy reaches. Events in the gap stay unreceipted, which an auditor sees against the merges. That holds while the
 * log's ids never go back, which the coordinator controls (round 11, P4). Round 11 (P2): the registry names the state
 * of the copy's chain; if that state reads, the copy is refused. Round 12: the copy's chain is the one its own
 * `chain.started` key started, never another its `previous.keys` name (round 11 took the first of those, so a
 * successor's successor was a dead end).
 */
function fromCopy(path: string, log: string, signer: ReceiptSigner, registry: string, statePath: string): Ended {
  const mine = keyId(signer.publicKey);
  const envelopes = readReceiptFiles(path);
  const p = predecessorOf(envelopes);
  if (p.keys.includes(mine)) throw new ReceiptError(`this key (${mine}) signed the chain it would succeed: a successor takes a new key; nothing was signed`);
  // predecessorOf verified the copy from the start key its first receipt declares.
  const startKey = (statementOf(envelopes[0] as Envelope) as { key: { keyid: string } }).key.keyid;
  const reg = readRegistry(registry);
  const at = reg.lines.findIndex((l) => l.kind === 'start' && l.key === startKey);
  const started = reg.lines[at];
  if (started?.kind !== 'start') throw new ReceiptError(`the chain in the copy ${path} isn't in the signer's registry: a successor succeeds a chain this signer started; nothing was signed`);
  let readable = false;
  try {
    readable = parseState(started.state, readStateText(started.state)) !== null;
  } catch {
    readable = false;
  }
  if (readable) throw new ReceiptError(`the ended chain's state ${started.state} can be read: succeed it from its state (--after ${started.state}), never from a copy; nothing was signed`);
  if (dirname(started.state) === dirname(statePath)) throw new ReceiptError(`a successor's state goes in a directory of its own, not the ended chain's (${dirname(started.state)}); nothing was signed`);
  const now = readReceiptEvents(log).reduce((m, e) => (BigInt(e.id) > m ? BigInt(e.id) : m), 0n);
  const event = BigInt(p.event) > now ? BigInt(p.event) : now;
  return { previous: { ...p, event: event.toString() }, chain: reg.ids[at]!, held: null };
}

/**
 * The ended chain's state, held under its lock since fromState read it, must still be what it read, at the head the
 * successor names (round 12: round 11 marked a chain whose head had moved since, and both chains signed its events).
 */
function stillAt(held: NonNullable<Ended['held']>, previous: Predecessor): ChainState {
  const text = readStateText(held.path);
  const own = parseState(held.path, text);
  if (text !== held.text || !own || own.head !== previous.head) {
    throw new ReceiptError(`the chain at ${held.path} is no longer at the head ${previous.head} this successor names (another writer); nothing was signed`);
  }
  return own;
}

/**
 * Mark the ended chain ended, under the lock signLog holds (round 10, #918 round-9 review rows 1 and 2): its state
 * records the successor's start key and the head it succeeded, so it never signs or rotates again, even once the log
 * is restored. The registry's start line for the successor (written first, recordStart) is what refuses a second
 * successor and ends the chain; this mark is the chain's own copy of it. Already marked for this successor: nothing
 * new. A state that can't be read (the copy route) can't be marked; the registry covers it.
 */
function markEnded(held: NonNullable<Ended['held']>, previous: Predecessor, signer: ReceiptSigner): void {
  const own = stillAt(held, previous);
  const mine = keyId(signer.publicKey);
  if (own.ended && own.ended.successor !== mine) throw new ReceiptError(`the chain at ${held.path} already has a successor, started by key ${own.ended.successor}: a chain has one successor; nothing was signed`);
  if (!own.ended) writeState(held.path, { ...own, ended: { successor: mine, head: own.head } });
}

/**
 * Rotate the chain in `out` to `next`, signed by the current key, from the signer's own chain state in `state`, as
 * the only signer. The state is written first, as in signLog: a rotation whose receipts write then fails is given
 * back by the next sign with the new key, from the state's fixed receipts (#918 round 7).
 */
export function rotateFile(o: { out: string; state: string; signer: ReceiptSigner; next: KeyObject }): { count: number; head: string | null } {
  const statePath = statePlace(o.state, o.out);
  outIsFile(o.out);
  return asOnlySigner(statePath, (own, unchanged, save) => {
    if (!own) throw new ReceiptError(`the signer has no chain state at ${o.state}: there is no chain of its own to rotate`);
    checkRegistry(own, statePath);
    const envelopes = rotateChain(readReceiptFiles(o.out), o.signer, o.next, { from: own });
    const state = { ...chainStateOf(envelopes, own.start), registry: own.registry };
    const text = receiptsText(envelopes);
    unchanged();
    recordRotate(own, keyId(o.next));
    save(state);
    writeReceipts(o.out, text);
    return { count: envelopes.length, head: state.head };
  });
}
