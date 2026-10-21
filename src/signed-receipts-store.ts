// Signed receipts on disk (#717): the event log read read-only, the receipts as JSON lines (one DSSE envelope each),
// the signer's own chain state, and ed25519 keys as PEM files. The format and the checks are src/signed-receipts.ts.
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BRAND } from './brand.js';
import { openReadOnly } from './events/read-only.js';
import { tryLock } from './locks.js';
import { notOwnerOnlyDir, processIdentity, processPlace, replaceOwnerOnly, syncToDisk, UNKNOWN_IDENTITY } from './os/index.js';
import { canonicalJson, chainStateOf, ChainStateSchema, keySigner, ReceiptError, RECEIPT_EVENTS, rotateChain, signEvents, type ChainState, type Envelope, type ReceiptEvent, type ReceiptSigner } from './signed-receipts.js';

/**
 * Every event in an events database opened read-only, oldest first, each with its payload as stored (`raw`, for the
 * log digest). Only the kinds receipts are made from are parsed.
 */
export function readReceiptEvents(dbPath: string): ReceiptEvent[] {
  if (!existsSync(dbPath)) throw new ReceiptError(`no event log at ${dbPath}`);
  const read: ReadonlySet<string> = new Set(RECEIPT_EVENTS);
  const db = openReadOnly(dbPath);
  try {
    const rows = db.prepare('SELECT id, ts, type, actor, payload FROM events ORDER BY id').all() as { id: number; ts: string; type: string; actor: string; payload: string }[];
    return rows.map((r) => ({ id: Number(r.id), ts: r.ts, type: r.type, actor: r.actor, raw: r.payload, payload: read.has(r.type) ? (JSON.parse(r.payload) as unknown) : undefined }));
  } finally {
    db.close();
  }
}

/**
 * The most bytes of receipts read for one chain, all its files together (some 30,000 receipts). WHY (#918 round 4,
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
      if (!line.trim()) return [];
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
function writeReceipts(path: string, envelopes: readonly Envelope[]): void {
  replaceOwnerOnly(path, `${envelopes.map((e) => canonicalJson(e)).join('\n')}\n`);
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
  const given = dirname(resolve(state));
  const stateDir = real(given);
  const outDir = real(dirname(resolve(out)));
  const rel = relative(join(outDir, basename(out)), join(stateDir, basename(state)));
  const inOut = rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (stateDir === outDir || inOut) {
    throw new ReceiptError(`the signer's chain state must be kept separate from the receipts: ${state} is in the directory of ${out}`);
  }
  // The path as given, then the real one. notOwnerOnlyDir refuses a link as the directory itself, and its ownedPath a
  // path any other user can redirect (on Linux, any link on the way: a link's own mode reads 0777). And from here on
  // only the real path is used, so a link flipped after this check changes nothing read or written.
  const why = notOwnerOnlyDir(given) ?? notOwnerOnlyDir(stateDir);
  if (why) throw new ReceiptError(`the signer's chain state goes in a directory only the signer can write, reached through no link: ${why}`);
  return join(stateDir, basename(state));
}

/**
 * The signer's chain state file's text, or null when there is none. Refused: a link, a file that isn't one, or one
 * with a second name (a hard link would be a second path to it, and a second lock: #918 round 6, row 5).
 */
function readStateText(path: string): string | null {
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  return readRegular(path, STATE_MAX_BYTES, "the signer's chain state", true);
}

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
  if (!st.success) throw new ReceiptError(`the signer's chain state ${path} is unreadable; nothing was signed (root or the owner restores it from a backup; a new chain takes a new key)`);
  return st.data;
}

/**
 * The signer's chain state, written BEFORE the receipts it names (#918 round 5; see signLog), and flushed to disk
 * before they are written (syncToDisk): without that, a power loss could keep the new receipts and an older state.
 */
function writeState(path: string, state: ChainState): void {
  // No copy of the state it replaces is kept (#918 round 7: round 6's `<state>.prev` was a way to roll the signer
  // back; the fixed receipts in the state make every recovery a give-back instead).
  replaceOwnerOnly(path, `${canonicalJson(state)}\n`);
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
  const lock = join(dirname(state), SIGNER_LOCK);
  // A FIFO or anything else at the lock's name would hang or fool the lock's reader: refused before it reads.
  const there = lstatSync(lock, { throwIfNoEntry: false });
  if (there && !there.isFile()) throw new ReceiptError(`${lock} is not a regular file: remove it by hand once no signer runs; nothing was signed`);
  const place = processPlace();
  const got = tryLock(lock, JSON.stringify({ by: `${BRAND.cli} receipts`, ...place, identity: processIdentity(process.pid) }), { inspected: () => samePlace(lock, place) });
  if (!('lock' in got)) throw new ReceiptError(`${holderGone(got.holder, place) ? `the signer lock ${lock} names pid ${got.holder?.pid}, which now belongs to another process (a pid reused since its holder died): remove the lock by hand once no signer runs` : `another sign or rotate holds the signer's lock (${lock}${got.holder ? `, pid ${got.holder.pid}` : ''})`}; nothing was signed`);
  try {
    const text = readStateText(state);
    const unchanged = () => {
      if (readStateText(state) !== text) throw new ReceiptError(`the signer's chain state ${state} changed while this run signed (another writer); nothing was written`);
    };
    return fn(parseState(state, text), unchanged, (next) => writeState(state, next));
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
export function signLog(o: { log: string; out: string; state: string; genesis?: boolean; signer: ReceiptSigner }): { added: number; count: number; head: string | null } {
  const statePath = statePlace(o.state, o.out);
  return asOnlySigner(statePath, (own, unchanged, save) => {
    if (own && o.genesis) throw new ReceiptError(`the signer already has a chain (its state is ${o.state}): --genesis never starts over it; nothing was signed`);
    if (!own && !o.genesis) throw new ReceiptError(`the signer has no chain state at ${o.state}: a new chain starts only with --genesis (root or the owner only); nothing was signed`);
    if (o.genesis && lstatSync(o.out, { throwIfNoEntry: false })) {
      throw new ReceiptError(`--genesis never replaces anything at --out (${o.out}): receipts there are someone else's chain, never adopted; nothing was signed`);
    }
    const existing = readReceiptFiles(o.out);
    const r = signEvents(existing, readReceiptEvents(o.log), o.signer, { from: own ?? 'genesis' });
    unchanged();
    if (!own || canonicalJson(own) !== canonicalJson(r.state)) save(r.state);
    if (r.added) writeReceipts(o.out, r.envelopes);
    return { added: r.added, count: r.envelopes.length, head: r.head };
  });
}

/**
 * Rotate the chain in `out` to `next`, signed by the current key, from the signer's own chain state in `state`, as
 * the only signer. The state is written first, as in signLog: a rotation whose receipts write then fails leaves a
 * state no receipts reach (a `key.rotated` can't be made again byte for byte), and sign refuses until root or the
 * owner restores the receipts or the state.
 */
export function rotateFile(o: { out: string; state: string; signer: ReceiptSigner; next: KeyObject }): { count: number; head: string | null } {
  const statePath = statePlace(o.state, o.out);
  return asOnlySigner(statePath, (own, unchanged, save) => {
    if (!own) throw new ReceiptError(`the signer has no chain state at ${o.state}: there is no chain of its own to rotate`);
    const envelopes = rotateChain(readReceiptFiles(o.out), o.signer, o.next, { from: own });
    const state = chainStateOf(envelopes, own.start);
    unchanged();
    save(state);
    writeReceipts(o.out, envelopes);
    return { count: envelopes.length, head: state.head };
  });
}
