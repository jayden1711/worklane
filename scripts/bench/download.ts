// The bench's pinned downloads (#748, slice 2): the dataset file at its pinned revision and sha256, into the held-out
// store, and task images by pinned digest only. What each pin is, and where it comes from: pins.ts.
//
// The dataset (downloadDataset), in this order:
// 1. the pin is one parsePins made (pins.ts requirePinned), and the store passes the preflight's held-out check (store.ts
//    heldOutCheck: absent, or a real 0700 folder of this user with no link from the bench root down). A store that
//    fails is refused as it is, never chmodded or replaced;
// 2. a file already at its name (<sha256>-<name>, in the store's dataset folder) that matches is kept and nothing is
//    fetched; one that doesn't, or a link there, is refused and left for the owner to look at;
// 3. the bytes are fetched into memory, over https only, from the pinned host (redirects: at most five, each to a
//    pinned host or its subdomain, no credentials, no port), at most max_bytes, and their sha256 must equal the pin.
//    Until then nothing is made or written: not the store, not a folder, not a temporary file;
// 4. the store and its dataset folder are made (0700, one folder at a time, never through a link) and checked again;
// 5. the bytes go to a new temporary file in the dataset folder (created exclusively, refusing a link, 0600), are
//    synced and read back through a fresh descriptor, and only when that read-back matches the pin is the file
//    renamed to its name. Any failure removes the temporary file.
//
// Images (pullImage): `docker pull <name>@sha256:<digest>`, then `docker image inspect` to read the digest back; no other
// docker command, and only an ImageRef (pins.ts pinnedImage: a pinned digest, no tag) builds the argv, which
// checkImageArgs checks again. docker gets the driver's environment (container.ts dockerEnv: no credential variable,
// an absolute DOCKER_HOST).
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { dockerEnv, spawnDocker, type DockerOptions } from './container.js';
import { realPath, type BenchLayout } from './paths.js';
import { checkUrl, DIGEST_REF, requirePinned, type DatasetPin, type ImageRef } from './pins.js';
import { heldOutCheck } from './store.js';

/** One HTTP response, redirects not followed: its status, its Location (a redirect) and its body. */
export interface Hop {
  status: number;
  location: string | null;
  body: AsyncIterable<Uint8Array> | null;
}

/** One HTTP GET, following no redirect (the download follows them itself, checking each). Tests pass a stand-in. */
export type Fetcher = (url: string) => Promise<Hop>;

/** The most redirects the download follows. */
export const MAX_REDIRECTS = 5;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
/** The longest one request may take, body included. */
const FETCH_TIMEOUT_MS = 30 * 60_000;

async function* chunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Ended early (over the cap, or an error): the rest is never read.
    await reader.cancel().catch(() => {});
  }
}

/** Node's own fetch, one request, no redirect followed. Not run by the tests (no network there). */
export const httpsFetcher: Fetcher = async (url) => {
  const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (REDIRECT.has(r.status)) {
    await r.body?.cancel().catch(() => {});
    return { status: r.status, location: r.headers.get('location'), body: null };
  }
  return { status: r.status, location: null, body: r.body ? chunks(r.body) : null };
};

const hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The pinned file's bytes, in memory: fetched as step 3 says, and refused (throws) unless they match the pin. */
export async function fetchPinned(pin: DatasetPin, fetcher: Fetcher): Promise<Buffer> {
  requirePinned(pin, 'dataset pin');
  let url = pin.url;
  for (let hops = 0; ; hops++) {
    const host = checkUrl(url, pin.hosts, hops ? 'a redirect' : 'the pinned url').hostname;
    const r = await fetcher(url);
    if (REDIRECT.has(r.status)) {
      if (hops >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${pin.url}: nothing written`);
      if (!r.location) throw new Error(`a ${r.status} redirect from ${host} with no location: nothing written`);
      url = new URL(r.location, url).href;
      continue;
    }
    if (r.status !== 200 || !r.body) throw new Error(`HTTP ${r.status}${r.body ? '' : ' with no body'} from ${host}: nothing written`);
    const hash = createHash('sha256');
    const parts: Buffer[] = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.length;
      if (n > pin.maxBytes) throw new Error(`the download is over its cap of ${pin.maxBytes} bytes: nothing written`);
      hash.update(c);
      parts.push(Buffer.from(c));
    }
    const got = hash.digest('hex');
    if (got !== pin.sha256) throw new Error(`sha256 mismatch: the download's is ${got}, the pinned one ${pin.sha256}: nothing written`);
    return Buffer.concat(parts);
  }
}

/** lstat, or null when nothing is there. */
function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Refuses (throws) unless `p` is a real folder (not a link) of `uid`, mode exactly 0700, where it really is. */
function ownFolder(p: string, st: Stats, uid: number): void {
  if (st.isSymbolicLink()) throw new Error(`${p} is a link: refused (the download never follows one)`);
  if (!st.isDirectory()) throw new Error(`${p} is not a folder`);
  if (st.uid !== uid) throw new Error(`${p} belongs to uid ${st.uid}, not this user (${uid})`);
  const mode = st.mode & 0o7777;
  if (mode !== 0o700) throw new Error(`${p} is mode 0${mode.toString(8)}, not exactly 0700: refused`);
  if (realPath(p) !== p) throw new Error(`${p} really is ${realPath(p)}: a link on the way`);
}

/** The sha256 of the regular file at `p`, read through a descriptor that refuses a link. */
function hashFile(p: string): { sha256: string; st: Stats } {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${p} is not a regular file`);
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1024 * 1024);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
    return { sha256: hash.digest('hex'), st };
  } finally {
    closeSync(fd);
  }
}

/**
 * Step 2: whether the pinned file is already in the store, verified. Refuses (throws) a dataset folder that isn't a
 * real 0700 folder of this user, a link or anything but a 0600 regular file of this user at the file's name, and a
 * file there whose bytes don't match the pin. Reads only; changes nothing.
 */
function alreadyThere(layout: BenchLayout, uid: number, pin: DatasetPin): boolean {
  const dir = lstatOrNull(layout.data);
  if (!dir) return false;
  ownFolder(layout.data, dir, uid);
  const file = join(layout.data, pin.file);
  const st = lstatOrNull(file);
  if (!st) return false;
  if (st.isSymbolicLink()) throw new Error(`${file} is a link: refused (the download never follows one); look at it, then move it aside`);
  if (!st.isFile() || st.uid !== uid || (st.mode & 0o7777) !== 0o600) throw new Error(`${file} is not a 0600 file of this user: refused; look at it, then move it aside`);
  const got = hashFile(file).sha256;
  if (got !== pin.sha256) throw new Error(`${file} is already there, but its sha256 is ${got}, not the pinned ${pin.sha256}: refused, left as it is; look at it, then move it aside`);
  return true;
}

/** Step 4: the bench root down to the store's dataset folder, each made 0700 if missing, one at a time, none a link. */
function makeStore(layout: BenchLayout, uid: number): void {
  const parts = relative(layout.root, layout.data).split(sep);
  if (parts[0] === '..' || parts.includes('..')) throw new Error(`${layout.data} is not inside the bench root ${layout.root}`);
  let at = layout.root;
  for (const part of ['', ...parts]) {
    at = part ? join(at, part) : at;
    try {
      // Not recursive: each folder on its own, so none is made through a link (mkdir never follows its last component).
      mkdirSync(at, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const st = lstatSync(at);
    if (st.isSymbolicLink()) throw new Error(`${at} is a link: refused (the download never follows one)`);
    if (!st.isDirectory()) throw new Error(`${at} is not a folder`);
  }
  heldOutCheck(layout, uid);
  ownFolder(layout.data, lstatSync(layout.data), uid);
}

/** Step 5: `bytes` (checked against `sha256` first) at `file`, through a verified temporary file and a rename. */
function writeVerified(file: string, dir: string, bytes: Buffer, sha256: string, uid: number): void {
  if (hex(bytes) !== sha256) throw new Error(`sha256 mismatch before writing ${file}: nothing written`);
  const tmp = join(dir, `.${randomBytes(8).toString('hex')}.${process.pid}.tmp`);
  // O_EXCL: a new file, never one (or a link) already there; O_NOFOLLOW: never through a link.
  let fd: number | null = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    fchmodSync(fd, 0o600);
    for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    const back = hashFile(tmp);
    if (back.sha256 !== sha256 || back.st.size !== bytes.length) throw new Error(`what landed in ${tmp} doesn't match the pin: nothing kept`);
    if (back.st.uid !== uid || (back.st.mode & 0o7777) !== 0o600) throw new Error(`${tmp} is not a 0600 file of this user: nothing kept`);
    renameSync(tmp, file);
    renamed = true;
  } finally {
    if (fd !== null) closeSync(fd);
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
  }
  const st = lstatSync(file);
  if (!st.isFile() || (st.mode & 0o7777) !== 0o600) throw new Error(`${file} is not a 0600 file after the rename`);
}

export interface Downloaded {
  /** Where the file is: <store>/dataset/<sha256>-<name>. */
  file: string;
  bytes: number;
  /** false: it was already there, verified, and nothing was fetched. */
  fetched: boolean;
}

/** The pinned dataset file into the held-out store, as the steps at the top of this file say. */
export async function downloadDataset(layout: BenchLayout, uid: number, pin: DatasetPin, fetcher: Fetcher = httpsFetcher): Promise<Downloaded> {
  requirePinned(pin, 'dataset pin');
  heldOutCheck(layout, uid);
  const file = join(layout.data, pin.file);
  if (alreadyThere(layout, uid, pin)) return { file, bytes: lstatSync(file).size, fetched: false };
  const bytes = await fetchPinned(pin, fetcher);
  makeStore(layout, uid);
  // Checked again after the fetch's awaits: the file name must still be free, and not a link.
  if (alreadyThere(layout, uid, pin)) return { file, bytes: bytes.length, fetched: true };
  writeVerified(file, layout.data, bytes, pin.sha256, uid);
  heldOutCheck(layout, uid);
  return { file, bytes: bytes.length, fetched: true };
}

/** The `image inspect` format: the digests the image was pulled by. */
export const INSPECT_FORMAT = '{{json .RepoDigests}}';

/**
 * Refuses (throws) any docker argv but `pull <name>@sha256:<64 hex>` and
 * `image inspect --format {{json .RepoDigests}} <name>@sha256:<64 hex>`: no option, no tag, no other verb.
 */
export function checkImageArgs(args: readonly string[]): void {
  const ref = (s: string | undefined) => typeof s === 'string' && DIGEST_REF.test(s);
  const pull = args.length === 2 && args[0] === 'pull' && ref(args[1]);
  const inspect = args.length === 5 && args[0] === 'image' && args[1] === 'inspect' && args[2] === '--format' && args[3] === INSPECT_FORMAT && ref(args[4]);
  if (!pull && !inspect) throw new Error(`docker ${args.slice(0, 2).join(' ').slice(0, 100)} refused: only pull <name>@sha256:<digest> and image inspect`);
}

/** docker.io's short form, as RepoDigests prints it: no docker.io/ and no library/ in front. */
const shortName = (name: string): string => name.replace(/^docker\.io\//, '').replace(/^library\//, '');

/** `ref` pulled by its digest, and the digest read back from the daemon. Refuses (throws) on any failure. */
export function pullImage(o: DockerOptions, ref: ImageRef): void {
  // Only pins.ts pinnedImage builds an ImageRef: a pinned digest, no tag.
  requirePinned(ref, 'image reference');
  const send = (args: string[], timeoutMs: number) => {
    checkImageArgs(args);
    return (o.call ?? spawnDocker)(o.docker, args, { env: dockerEnv(o.env), timeoutMs });
  };
  // From its own frozen fields only, never a method (#863 round 1: a prototype's method can be swapped in-process).
  const text = `${ref.name}@${ref.digest}`;
  const p = send(['pull', text], 60 * 60_000);
  if (p.status !== 0) throw new Error(`docker pull ${text} failed: ${p.stderr.trim().slice(0, 300)}`);
  const i = send(['image', 'inspect', '--format', INSPECT_FORMAT, text], 60_000);
  let digests: unknown = null;
  try {
    digests = JSON.parse(i.stdout);
  } catch {
    // unreadable: refused below
  }
  const want = `${shortName(ref.name)}@${ref.digest}`;
  const ok = i.status === 0 && Array.isArray(digests) && digests.some((d) => typeof d === 'string' && shortName(d) === want);
  if (!ok) throw new Error(`docker image inspect ${text}: the pinned digest ${ref.digest} doesn't read back: refused`);
}
