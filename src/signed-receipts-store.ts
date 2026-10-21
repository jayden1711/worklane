// Signed receipts on disk (#717): the event log read read-only, the receipts as JSON lines (one DSSE envelope each),
// the signer's own chain state, and ed25519 keys as PEM files. The format and the checks are src/signed-receipts.ts.
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openReadOnly } from './events/read-only.js';
import { notOwnerOnlyDir, replaceOwnerOnly } from './os/index.js';
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
/** The most bytes a signer's chain state file holds (it is a few hundred). */
const STATE_MAX_BYTES = 64 * 1024;

/**
 * A regular file's text, at most `max` bytes: never through a link, never a FIFO, device or directory (#918 round 4,
 * A7: a FIFO named `x.jsonl` hung verify, and a link to /dev/zero would have grown it without bound). The file is
 * opened without following a link and without waiting on a FIFO, and checked through that descriptor, so what is
 * checked is what is read. `what` names it in a refusal.
 */
function readRegular(file: string, max: number, what: string): string {
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
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > st.size) throw new ReceiptError(`${what} ${file} grew while it was read`);
    return buf.subarray(0, n).toString('utf8');
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
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        throw new ReceiptError(`${file}:${i + 1} is not JSON`);
      }
    });
  });
}

/** Replace the receipts file (replaceOwnerOnly: never through a name planted beside it; #918 round 4, A11). */
function writeReceipts(path: string, envelopes: readonly Envelope[]): void {
  replaceOwnerOnly(path, `${envelopes.map((e) => canonicalJson(e)).join('\n')}\n`);
}

/**
 * Where the signer keeps its chain state, checked: in a directory only this user can change (notOwnerOnlyDir), and
 * not the receipts' directory (whoever may write that may not reach the state; #918 round 4).
 */
function statePlace(state: string, out: string): void {
  const rel = relative(resolve(out), resolve(state));
  const inOut = rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (resolve(dirname(state)) === resolve(dirname(out)) || inOut) {
    throw new ReceiptError(`the signer's chain state must be kept separate from the receipts: ${state} is in the directory of ${out}`);
  }
  const why = notOwnerOnlyDir(dirname(resolve(state)));
  if (why) throw new ReceiptError(`the signer's chain state goes in a directory only the signer can write: ${why}`);
}

/** The signer's chain state, or null when it has none (no file at `path`). Refused: a link, or a file that isn't one. */
function readState(path: string): ChainState | null {
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  const text = readRegular(path, STATE_MAX_BYTES, "the signer's chain state");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const st = ChainStateSchema.safeParse(parsed);
  if (!st.success) throw new ReceiptError(`the signer's chain state ${path} is unreadable; nothing was signed (restore it, or start a new chain with --genesis: root or the owner only)`);
  return st.data;
}

/** The signer's chain state, written after the receipts (a crash between leaves receipts that still extend it). */
function writeState(path: string, state: ChainState): void {
  replaceOwnerOnly(path, `${canonicalJson(state)}\n`);
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
 * own chain state in `state` (#918 round 4). With no state, only `genesis` starts a chain, and only where `out` holds
 * no receipts; with one, `genesis` is refused and `out` must extend it. Writes nothing when there is nothing new, or
 * when it refuses (src/signed-receipts.ts). Writes the receipts first, then the state.
 */
export function signLog(o: { log: string; out: string; state: string; genesis?: boolean; signer: ReceiptSigner }): { added: number; count: number; head: string | null } {
  statePlace(o.state, o.out);
  const own = readState(o.state);
  if (own && o.genesis) throw new ReceiptError(`the signer already has a chain (its state is ${o.state}): --genesis never starts over it; nothing was signed`);
  if (!own && !o.genesis) throw new ReceiptError(`the signer has no chain state at ${o.state}: a new chain starts only with --genesis (root or the owner only); nothing was signed`);
  const existing = readReceiptFiles(o.out);
  const r = signEvents(existing, readReceiptEvents(o.log), o.signer, { from: own ?? 'genesis' });
  if (r.added) writeReceipts(o.out, r.envelopes);
  if (r.added || (own && own.count !== r.state.count)) writeState(o.state, r.state);
  return { added: r.added, count: r.envelopes.length, head: r.head };
}

/** Rotate the chain in `out` to `next`, signed by the current key, from the signer's own chain state in `state`. */
export function rotateFile(o: { out: string; state: string; signer: ReceiptSigner; next: KeyObject }): { count: number; head: string | null } {
  statePlace(o.state, o.out);
  const own = readState(o.state);
  if (!own) throw new ReceiptError(`the signer has no chain state at ${o.state}: there is no chain of its own to rotate`);
  const envelopes = rotateChain(readReceiptFiles(o.out), o.signer, o.next, { from: own });
  writeReceipts(o.out, envelopes);
  const state = chainStateOf(envelopes, own.start);
  writeState(o.state, state);
  return { count: envelopes.length, head: state.head };
}
