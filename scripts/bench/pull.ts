// The rest of the bench's task setup (#748, slice 4): `bench pull --tasks smoke|baseline` pulls the run's task images
// and puts each task's base tree in the held-out store. It runs after `bench images`, as the bench user only.
//
// The pulls (pullTasks): the tasks and their image references come from the store only (select.ts loadTasks: the
// manifest checked against the pins, each reference from images.json taken through pins.ts pinnedImage, so a pinned
// digest under the task's own name and never a tag). Each is pulled by download.ts pullImage, which sends only
// `docker pull <name>@sha256:<digest>` and reads the digest back from the daemon. Then loadTasks runs again: if
// images.json changed during the pulls, nothing more happens.
//
// The base trees (baseTree): the source at base_commit comes from the task image's own /testbed, never from upstream:
// no network, no fetch, no GitHub. It goes through the bench's own container runner (container.ts): one throwaway
// container per task (`docker run --network none --cap-drop ALL`, no mount, every limit read back), with commands sent
// only as `docker exec` through TaskRunner. Those commands only read /testbed; whatever the container does is removed
// with it. In it:
// - with git metadata in /testbed: HEAD must be the task's base_commit, or the task is refused. Then base_commit's
//   own commit object (none of its parents: no upstream history) and exactly the objects of its tree are packed out.
//   On the host that commit must hash to base_commit and name that tree, so the tree is base_commit's by its hash,
//   not by the container's word;
// - with none: refused (#947 round 2). Nothing would bind its files to base_commit, and an image takes that path just
//   by having no /testbed/.git. A content-hash fallback would be a loosening for the owner to decide.
// What comes out is bounded (#947 round 2): the probe's output and the pack's (TREE_CAPS.copyOutBytes) are capped in
// bytes as they arrive, and past the cap the exec is ended, nothing is kept and the container is removed. Then the pack
// is walked before `git index-pack` sees it (packDeclaredBytes), against one budget (TREE_CAPS.treeBytes): every
// entry's inflated data (a delta's own data too), each delta's target, and a fixed cost an entry; and one object or
// delta's data against TREE_CAPS.objectBytes (#947 rounds 3 and 4: index-pack builds each object in memory, a delta of
// a few bytes can declare gigabytes, and uncounted delta data or entries cost minutes and gigabytes). index-pack, and
// every pack-objects git runs here, uses one thread. What git read is held to the total again, before any checkout.
// And the image must be the task's own digest reference: no tag ever reaches `run`.
// On the host, in a temporary folder in the store: the pack is indexed (git hashes every object), the tree must be
// there with every object it reaches, and one root commit is made on it (fixed author and date, so the same tree
// always gives the same commit). A fresh bare repository fetches only that commit (so nothing unreachable comes
// along), and must hold exactly the objects that commit reaches: one commit, no upstream history. A clone of it is
// made, its origin that bare remote. A record (tree.json, 0600) keeps the task's key, instance id, base_commit, image
// digest, source, tree and commit. Only then is the folder renamed to trees/<key>, never over anything.
//
// Where they live: <held-out store>/trees/<key>/{remote.git,clone,tree.json}. The agents' sandbox denies the store
// (agent.ts), so no agent sees the task set: not one base tree, not the repos, not the commits. `bench run` (still to
// come) copies one task's tree into that task's own folder when the task starts.
//
// What is printed: keys and counts only, never an instance id, an image name, a digest beside its key or a tree hash.
// docker's own words (they name the image) are never passed on: a failure says its stage and exit status. Every line
// still goes through cli.ts scrub()'s withholding backstop.
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, rmSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { createInflate, inflateSync } from 'node:zlib';
import type { Mode } from './caps.js';
import { LimitsNotApplied, OutputTooLarge, TaskRunner, WORK, type Docker, type DockerOptions, type TaskContainer } from './container.js';
import { pullImage, PullRefused, writeVerified } from './download.js';
import { realPath, type BenchLayout } from './paths.js';
import { DIGEST_REF, requirePinned, type Pins } from './pins.js';
import { loadTasks, type SelectedTask } from './select.js';
import { heldOutCheck } from './store.js';

/** The base trees' folder in the held-out store, and each tree's record. */
export const TREES = 'trees';
export const TREE_RECORD = 'tree.json';

/** A refusal whose message names no task: safe to print beside the task's key. */
export class Refused extends Error {}

/**
 * How much a task's copy-out may bring: the pack's base64 text; the walk's budget (packDeclaredBytes: every entry's
 * inflated data, a delta's own data too, each delta's target, and ENTRY_COST an entry, summed); and what any one
 * object or delta's data decodes to. The last two are read from the pack itself before `git index-pack` sees it:
 * index-pack builds each object in memory, and a delta of a few bytes can declare gigabytes. What git read is held to
 * `treeBytes` again after index-pack.
 */
export interface TreeCaps {
  copyOutBytes: number;
  treeBytes: number;
  objectBytes: number;
}

/**
 * The caps `bench pull` uses. All are guesses at what SWE-bench Verified's largest base tree needs, with room: none is
 * measured here (no real image is pulled). A tree over any is refused, naming the cap; raising one is a reviewed
 * change. 384 MiB of base64 (a 288 MiB pack) stays well inside one string's limit (about 512 MiB).
 */
export const TREE_CAPS: Readonly<TreeCaps> = Object.freeze({ copyOutBytes: 384 * 1024 * 1024, treeBytes: 1024 * 1024 * 1024, objectBytes: 256 * 1024 * 1024 });

/**
 * What one pack entry costs the walk's budget on top of its bytes, whatever it declares. `git index-pack` keeps a record
 * of every entry, and the walk's time grows with the count: 18 million 4-byte blobs (a 288 MB pack, under the copy-out
 * cap) took the walk 49.7 s and peaked `index-pack --threads=1` at 1.41 GB (#947 round 4, measured). At 1 KiB an entry,
 * the 1 GiB budget admits at most a million entries; a real tree has tens of thousands (inferred).
 */
export const ENTRY_COST = 1024;
/** Entry data up to this size is inflated in one piece; past it, streamed, keeping only its first bytes. */
const INFLATE_WHOLE_MAX = 1024 * 1024;
/** How much of an entry's inflated data the walk keeps: a delta's header (two sizes, at most 10 bytes each). */
const HEAD_BYTES = 32;

/**
 * An entry's zlib data, `data` (it runs on to the pack's trailer), inflated to exactly `size` bytes and never more:
 * its first HEAD_BYTES bytes and how many bytes of `data` it used, or null when it isn't zlib, is cut short or isn't
 * `size` bytes. Memory stays small whatever `size` is: past INFLATE_WHOLE_MAX the output is streamed and dropped.
 */
async function inflateEntry(data: Buffer, size: number): Promise<{ head: Buffer; used: number } | null> {
  if (size <= INFLATE_WHOLE_MAX) {
    try {
      const r = inflateSync(data, { info: true, maxOutputLength: Math.max(size, 1) }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      return r.buffer.length === size && r.engine.bytesWritten > 0 ? { head: Buffer.from(r.buffer.subarray(0, HEAD_BYTES)), used: r.engine.bytesWritten } : null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const z = createInflate({ chunkSize: INFLATE_WHOLE_MAX });
    let out = 0;
    let head = Buffer.alloc(0);
    let settled = false;
    const settle = (v: { head: Buffer; used: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    z.on('data', (b: Buffer) => {
      out += b.length;
      if (out > size) {
        z.destroy();
        return settle(null);
      }
      // A copy: a slice would keep the whole chunk alive.
      if (head.length < HEAD_BYTES) head = Buffer.concat([head, Buffer.from(b.subarray(0, HEAD_BYTES - head.length))]);
    });
    z.on('error', () => settle(null));
    z.on('end', () => settle(out === size && z.bytesWritten > 0 ? { head, used: z.bytesWritten } : null));
    z.end(data);
  });
}

/** What packDeclaredBytes read: the objects' decoded sizes, summed, and what the walk's budget was charged. */
export interface PackWalk {
  /** A whole object's size, or a delta's target size, summed: what git reads (`cat-file --batch-check`). */
  decoded: number;
  /** Every entry's inflated data (a delta's own data too), each delta's target, and ENTRY_COST an entry. */
  spent: number;
}

/**
 * The pack's entries, read from the pack itself before `git index-pack` sees it, against one budget,
 * `caps.treeBytes`. Each entry is charged ENTRY_COST, the bytes its data inflates to (a delta's own data counts, not
 * only its target) and, for a delta, its target size (the second number of its delta header). The charge is made
 * before the data is inflated, so the walk never inflates past the budget, and reads at most a million entries
 * (#947 round 4: uncounted delta data let a 300 MB pack take the walk 302.6 s, and 33 deltas of 248 MiB each made
 * index-pack peak at 1.96 GB). index-pack's memory follows the budget; its time does not (it can rebuild a chain's
 * bases again and again: 19 chained 50 MiB deltas, a 51 KB pack, took it 18.6 s at 106 MB in review), and is bounded
 * by the 30-minute git timeout. Refuses (throws Refused) a pack that isn't well
 * formed (signature, version, count, types, sizes, zlib data, nothing after the last entry but the 20-byte trailer),
 * an object or delta data over `caps.objectBytes`, and a charge over `caps.treeBytes`. Its messages name no task.
 */
export async function packDeclaredBytes(pack: Buffer, caps: { treeBytes: number; objectBytes: number }): Promise<PackWalk> {
  const bad = (why: string) => new Refused(`what came out of /testbed is not a well-formed pack (${why}): refused before it is indexed, nothing kept`);
  const over = () => new Refused(`what came out of /testbed is too much to inflate and decode: it declares over ${caps.treeBytes} bytes of data, delta targets and entries (${ENTRY_COST} bytes each): refused before it is indexed, nothing kept`);
  if (!Buffer.isBuffer(pack) || pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw bad('no pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw bad(`version ${version}`);
  const count = pack.readUInt32BE(8);
  // Every entry's fixed charge first: a count over the budget is refused before any entry is read.
  let spent = count * ENTRY_COST;
  if (spent > caps.treeBytes) throw over();
  const spend = (n: number) => {
    spent += n;
    if (spent > caps.treeBytes) throw over();
  };
  const end = pack.length - 20;
  if (!createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end))) throw bad('a trailer that is not its checksum');
  let pos = 12;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (pos >= end) throw bad('fewer entries than its count');
    const start = pos;
    let b = pack[pos++]!;
    const type = (b >> 4) & 7;
    let size = b & 15;
    let mult = 16;
    for (let n = 0; b & 0x80; n++) {
      if (pos >= end || n >= 9) throw bad('an entry size cut short or too long');
      b = pack[pos++]!;
      size += (b & 0x7f) * mult;
      mult *= 128;
    }
    if (type === 6) {
      // OFS_DELTA: how far back its base starts, 7 bits a byte, as git reads it. index-pack resolves it; here it only
      // has to land on or after the first entry and before this one.
      if (pos >= end) throw bad('a delta base offset cut short');
      b = pack[pos++]!;
      let back = b & 0x7f;
      for (let n = 1; b & 0x80; n++) {
        if (pos >= end || n >= 10 || back > start) throw bad('a delta base offset cut short or outside the pack');
        b = pack[pos++]!;
        back = (back + 1) * 128 + (b & 0x7f);
      }
      if (back < 1 || start - back < 12) throw bad('a delta base offset outside the pack');
    } else if (type === 7) {
      pos += 20;
      if (pos > end) throw bad('a delta base id cut short');
    } else if (type < 1 || type > 4) throw bad(`entry type ${type}`);
    // A whole object's size is what it decodes to; a delta's is its own data. Both capped and charged before inflating.
    if (size > caps.objectBytes) throw new Refused(`what came out of /testbed declares an object of over ${caps.objectBytes} bytes: refused before it is indexed, nothing kept`);
    spend(size);
    const r = await inflateEntry(pack.subarray(pos, end), size);
    if (!r) throw bad('entry data that is not zlib, cut short, or not what its size says');
    const data = r.head;
    pos += r.used;
    let decoded = size;
    if (type === 6 || type === 7) {
      let p = 0;
      const header = (): number => {
        let v = 0;
        let m = 1;
        let c: number;
        let k = 0;
        do {
          if (p >= data.length || k++ >= 10) throw bad('a delta header cut short');
          c = data[p++]!;
          v += (c & 0x7f) * m;
          m *= 128;
        } while (c & 0x80);
        return v;
      };
      header();
      decoded = header();
      if (decoded > caps.objectBytes) throw new Refused(`what came out of /testbed declares an object of over ${caps.objectBytes} bytes: refused before it is indexed, nothing kept`);
      // index-pack builds the target from its base and this data: charged on top of the data.
      spend(decoded);
    }
    total += decoded;
  }
  if (pos !== end) throw bad('bytes after its last entry');
  return { decoded: total, spent };
}
/** The probe answers three short lines. */
const PROBE_MAX_BYTES = 64 * 1024;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const SHA1 = /^[0-9a-f]{40}$/;

/**
 * The run's tasks (loadTasks, `mode`), each image pulled by its pinned digest and read back (pullImage). Refuses
 * (throws) at the first failure, naming the key only, and when images.json changed while the images were pulled.
 */
export function pullTasks(layout: BenchLayout, uid: number, pins: Pins, mode: Mode, o: DockerOptions, tasks: readonly SelectedTask[]): void {
  for (const t of tasks) {
    // loadTasks took it through pinnedImage; checked again here, where it is pulled.
    if (!pins.digests.includes(t.ref.digest)) throw new Refused(`${t.key}: its image digest is not one of the pinned image_digests: refused, nothing pulled`);
    try {
      pullImage(o, t.ref);
    } catch (e) {
      // pullImage's own message quotes the reference and docker's words, which name the task: never passed on.
      if (e instanceof PullRefused && e.stage === 'pull') throw new Refused(`${t.key}: docker pull by the pinned digest failed (exit ${e.status ?? 'none'}): refused. docker's own message names the image, so it isn't printed`);
      if (e instanceof PullRefused) throw new Refused(`${t.key}: the pulled image's digest doesn't read back as the one images.json and pins.json give this task: refused`);
      throw new Refused(`${t.key}: the image pull was refused before docker ran`);
    }
  }
  const again = loadTasks(layout, uid, pins, mode);
  if (again.length !== tasks.length || again.some((t, i) => t.key !== tasks[i]!.key || t.image !== tasks[i]!.image)) {
    throw new Refused('images.json changed while bench pull ran: refused, no base tree built; look at it, then run bench pull again');
  }
}

/** What a task's tree record holds. */
export interface TreeRecord {
  key: string;
  instance_id: string;
  base_commit: string;
  image_digest: string;
  /** git: /testbed's HEAD tree, HEAD checked to be base_commit, bound by its commit's hash. The only source taken. */
  source: 'git';
  head_checked: true;
  tree: string;
  /** The one commit, on the tree, in the bare remote and the clone. */
  commit: string;
}

export interface TreeResult {
  key: string;
  /** true: already there and verified, so nothing was copied. */
  kept: boolean;
}

/** git on the host, with no config but its own (an agent's Edit could reach ~/.gitconfig), and the local file protocol only. */
const GIT_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@localhost', GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@localhost', GIT_COMMITTER_DATE: '@0 +0000' };
// pack.threads=1: index-pack and pack-objects (here and in what fetch runs) on one thread. Each thread holds its own
// objects, so their memory grew with the host's CPUs: an admitted 12.5 MB pack peaked index-pack at 0.86 to 1.96 GB
// with git's default threads on 16 CPUs, 3.27 GB with 16, and 283 MiB with one (#947 round 4, measured in review).
const GIT_HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'pack.threads=1'];
const git = (args: readonly string[], input?: Buffer): string =>
  execFileSync('git', [...GIT_HARDENED, ...args], { env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30 * 60_000, maxBuffer: 256 * 1024 * 1024, ...(input ? { input } : {}) })
    .toString('utf8')
    .trim();

/** In the container: whether /testbed has git metadata, and if so its HEAD commit and tree. Reads only. */
const PROBE = "if [ -e /testbed/.git ]; then echo git && git -c safe.directory=/testbed -c core.fsmonitor=false -C /testbed rev-parse 'HEAD^{commit}' 'HEAD^{tree}'; else echo none; fi";
/**
 * In the container: the commit $1 (that object alone, none of its parents) and exactly the objects of its tree $2, as a
 * pack, in base64. Reads /testbed only. The commit object lets the host check, by its hash, that the tree is base_commit's.
 */
const PACK = "{ printf '%s\\n' \"$1\"; git -c safe.directory=/testbed -c core.fsmonitor=false -C /testbed rev-list --objects \"$2\"; } | git -c safe.directory=/testbed -c core.fsmonitor=false -C /testbed pack-objects -q --stdout | base64 -w0";
/** The two scripts run in a task's container, for the test that runs them with sh on a stand-in /testbed. */
export const CONTAINER_SCRIPTS = Object.freeze({ probe: PROBE, pack: PACK });

/** A pack sent as base64: refused unless it is base64 and not empty. Its contents are checked by git on the host. */
function decodePack(text: string): Buffer {
  const s = text.trim();
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Refused("what came out of /testbed is not a pack (not base64): refused, nothing kept");
  return Buffer.from(s, 'base64');
}

interface Copied {
  tree: string;
  pack: Buffer;
}

/** run.exec with a byte cap: past it, the exec is ended and refused (Refused, naming the cap). */
async function capped(run: TaskRunner, argv: string[], timeoutMs: number, cap: number) {
  try {
    return await run.exec(WORK, argv, {}, timeoutMs, undefined, cap);
  } catch (e) {
    if (e instanceof OutputTooLarge) throw new Refused(`what came out of /testbed went over ${cap} bytes: ended, refused, nothing kept`);
    throw e;
  }
}

/** The task's base tree, packed out of its container's /testbed: as the top of this file says. */
async function copyOut(run: TaskRunner, task: SelectedTask, caps: TreeCaps): Promise<Copied> {
  const probe = await capped(run, ['sh', '-c', PROBE], 5 * 60_000, PROBE_MAX_BYTES);
  if (probe.status !== 0) throw new Refused(`the /testbed probe in its container failed (exit ${probe.status ?? 'none'}): refused, nothing kept`);
  const lines = probe.stdout.split('\n').map((l) => l.trim());
  while (lines.at(-1) === '') lines.pop();
  if (lines.length === 1 && lines[0] === 'none') {
    throw new Refused("/testbed has no git metadata, so nothing binds its files to this task's base_commit: refused, nothing copied out or kept");
  }
  if (lines[0] !== 'git') throw new Refused('the /testbed probe answered neither git nor none: refused, nothing kept');
  const [head, tree] = [lines[1] ?? '', lines[2] ?? ''];
  if (lines.length !== 3 || !SHA1.test(head) || !SHA1.test(tree)) throw new Refused("/testbed has git metadata, but its HEAD and tree didn't read as object ids: refused, nothing kept");
  if (head !== task.row.base_commit) throw new Refused("/testbed's HEAD is not this task's base_commit: refused, nothing kept");
  const p = await capped(run, ['sh', '-c', PACK, 'sh', head, tree], 60 * 60_000, caps.copyOutBytes);
  if (p.status !== 0) throw new Refused(`copying /testbed's tree out failed (exit ${p.status ?? 'none'}): refused, nothing kept`);
  return { tree, pack: decodePack(p.stdout) };
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

/** The store's trees folder: made 0700 when missing, never through a link; refused unless a real 0700 folder of `uid`. */
function treesDir(layout: BenchLayout, uid: number): string {
  heldOutCheck(layout, uid);
  const dir = join(layout.heldOut, TREES);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Refused(`${dir} is not a real folder (a link?): refused, never followed`);
  if (st.uid !== uid || (st.mode & 0o7777) !== 0o700) throw new Refused(`${dir} is not a 0700 folder of this user: refused (chmod 700 it)`);
  if (realPath(dir) !== dir) throw new Refused(`${dir} really is ${realPath(dir)}: a link on the way`);
  return dir;
}

/** The record at `f`: a 0600 regular file of `uid`, never a link, at most 64 KiB of JSON. */
function readRecord(f: string, uid: number): Partial<TreeRecord> {
  let fd: number;
  try {
    fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Refused(`${f} is missing or a link: an unfinished or odd tree, refused, left as it is; move its folder aside`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o7777) !== 0o600 || st.size > 64 * 1024) throw new Refused(`${f} is not a 0600 file of this user: refused, left as it is`);
    const buf = Buffer.alloc(st.size);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0; ) n += r;
    const o: unknown = JSON.parse(buf.subarray(0, n).toString('utf8'));
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error('not an object');
    return o as Partial<TreeRecord>;
  } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused(`${f} is not a tree record: refused, left as it is`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the bare remote `remote` holds exactly one commit, `commit`, on `tree`, with every object that commit
 * reaches and nothing else: no upstream history. Throws Refused otherwise.
 */
function checkRemote(remote: string, commit: string, tree: string, where: string): void {
  const st = lstatOrNull(remote);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Refused(`${where}: its bare remote is missing or a link: refused, left as it is`);
  try {
    if (git(['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/main^{commit}']) !== commit) throw new Error('commit');
    if (git(['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/main^{tree}']) !== tree) throw new Error('tree');
    if (git(['--git-dir', remote, 'rev-list', '--count', 'refs/heads/main']) !== '1') throw new Error('history');
    git(['--git-dir', remote, 'fsck', '--connectivity-only', '--no-dangling', '--no-progress']);
    const reached = git(['--git-dir', remote, 'rev-list', '--objects', '--all']).split('\n').filter(Boolean).length;
    const counts = Object.fromEntries(
      git(['--git-dir', remote, 'count-objects', '-v'])
        .split('\n')
        .map((l) => l.split(': ') as [string, string]),
    );
    if (Number(counts.count) + Number(counts['in-pack']) !== reached) throw new Error('extra objects');
  } catch {
    throw new Refused(`${where}: its bare remote isn't one commit on the recorded tree with exactly that tree's objects: refused, left as it is; move it aside to build it again`);
  }
}

/** A tree already at the task's place: kept when it is this task's, from this image, and checks out; refused otherwise. */
function keepExisting(final: string, uid: number, task: SelectedTask): TreeResult {
  const st = lstatSync(final);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Refused(`${final} is a link or not a folder: refused, never followed, left as it is`);
  const rec = readRecord(join(final, TREE_RECORD), uid);
  if (rec.key !== task.key || rec.instance_id !== task.row.instance_id || rec.base_commit !== task.row.base_commit) throw new Refused(`the store's tree at ${final} is another task's: refused, left as it is; move it aside to build it again`);
  if (rec.image_digest !== task.ref.digest) throw new Refused(`the store's tree at ${final} came from another image: refused, left as it is; move it aside to build it again`);
  if (rec.source !== 'git' || rec.head_checked !== true || !SHA1.test(rec.tree ?? '') || !SHA1.test(rec.commit ?? '')) throw new Refused(`${join(final, TREE_RECORD)} is not a whole tree record bound to base_commit: refused, left as it is`);
  checkRemote(join(final, 'remote.git'), rec.commit!, rec.tree!, final);
  const clone = join(final, 'clone');
  const cst = lstatOrNull(clone);
  let cloneOk = false;
  try {
    cloneOk = !!cst && cst.isDirectory() && !cst.isSymbolicLink() && git(['-C', clone, 'rev-parse', 'HEAD']) === rec.commit && git(['-C', clone, 'remote', 'get-url', 'origin']) === join(final, 'remote.git');
  } catch {
    cloneOk = false;
  }
  if (!cloneOk) throw new Refused(`${final}: its clone is missing, a link, or not at the recorded commit with its bare remote as origin: refused, left as it is; move it aside to build it again`);
  return { key: task.key, kept: true };
}

/** What every object in the repository at `gitDir` decodes to, summed (`cat-file --batch-all-objects`). */
function decodedBytes(gitDir: string): number {
  return git(['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objectsize)'])
    .split('\n')
    .filter(Boolean)
    .reduce((n, l) => n + Number(l), 0);
}

/** The bare remote, the clone and the record, built in `tmp` from what came out of the container. Throws Refused on any doubt. */
function build(tmp: string, final: string, uid: number, task: SelectedTask, c: Copied, caps: TreeCaps): void {
  const scratch = join(tmp, 'import.git');
  const remote = join(tmp, 'remote.git');
  const clone = join(tmp, 'clone');
  // baseTree walked the pack against the budget before this (packDeclaredBytes).
  git(['init', '--bare', '-q', '--template=', scratch]);
  try {
    // index-pack hashes every object, so what is indexed is exactly what the ids say. One thread, whatever the config.
    git(['--git-dir', scratch, 'index-pack', '--threads=1', '--stdin'], c.pack);
    if (git(['--git-dir', scratch, 'cat-file', '-t', c.tree]) !== 'tree') throw new Error('not a tree');
  } catch {
    throw new Refused("what came out of /testbed is not a pack holding its tree: refused, nothing kept");
  }
  // By hash, not by the container's word: base_commit's own commit object, and its tree is the one copied out.
  let ok = false;
  try {
    ok = git(['--git-dir', scratch, 'cat-file', '-t', task.row.base_commit]) === 'commit' && git(['--git-dir', scratch, 'rev-parse', '--verify', `${task.row.base_commit}^{tree}`]) === c.tree;
  } catch {
    ok = false;
  }
  if (!ok) throw new Refused("the pack out of /testbed doesn't hold base_commit's own commit on that tree: refused, nothing kept");
  // Again, on what git itself read, before anything is fetched or checked out (packDeclaredBytes already held the pack's
  // own declarations to the same cap, before index-pack).
  let size = Infinity;
  try {
    size = decodedBytes(scratch);
  } catch {
    // unreadable: refused below
  }
  if (!(size <= caps.treeBytes)) throw new Refused(`what came out of /testbed decodes to over ${caps.treeBytes} bytes: refused before any checkout, nothing kept`);
  const commit = git(['--git-dir', scratch, 'commit-tree', c.tree, '-m', 'bench base tree']);
  git(['--git-dir', scratch, 'update-ref', 'refs/heads/main', commit]);
  // A fresh bare remote takes only what that commit reaches: nothing else in the pack comes along.
  git(['init', '--bare', '-q', '--template=', remote]);
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  try {
    git(['--git-dir', remote, 'fetch', '-q', '--no-tags', scratch, 'refs/heads/main:refs/heads/main']);
  } catch {
    throw new Refused("the pack out of /testbed is missing objects its tree needs: refused, nothing kept");
  }
  rmSync(scratch, { recursive: true, force: true });
  checkRemote(remote, commit, c.tree, task.key);
  git(['clone', '-q', '--template=', remote, clone]);
  git(['-C', clone, 'remote', 'set-url', 'origin', join(final, 'remote.git')]);
  if (git(['-C', clone, 'rev-parse', 'HEAD']) !== commit || git(['-C', clone, 'rev-list', '--count', 'HEAD']) !== '1') throw new Refused('its clone is not the one commit of its bare remote: refused, nothing kept');
  const rec: TreeRecord = { key: task.key, instance_id: task.row.instance_id, base_commit: task.row.base_commit, image_digest: task.ref.digest, source: 'git', head_checked: true, tree: c.tree, commit };
  const text = `${JSON.stringify(rec, null, 2)}\n`;
  writeVerified(join(tmp, TREE_RECORD), tmp, Buffer.from(text), createHash('sha256').update(text).digest('hex'), uid);
}

/**
 * The task's base tree in the store (trees/<key>/), as the top of this file says: kept when it is already there and
 * checks out, otherwise copied out of the task's image through `docker` (its container runner) and built. Refuses
 * (throws Refused, naming no task) on any doubt, keeping nothing of it.
 */
export async function baseTree(layout: BenchLayout, uid: number, task: SelectedTask, o: DockerOptions, docker: Docker, caps: TreeCaps = TREE_CAPS): Promise<TreeResult> {
  if (!SHA1.test(task.row.base_commit)) throw new Refused("this task's base_commit is not a commit id: refused");
  // Only the task's own pinned digest reference reaches `docker run`: never a tag (container.ts's image check allows one).
  try {
    requirePinned(task.ref, 'image reference');
  } catch {
    throw new Refused("this task's image reference is not one pins.ts built: refused before docker run");
  }
  if (typeof task.image !== 'string' || !DIGEST_REF.test(task.image) || task.image !== `${task.ref.name}@${task.ref.digest}`) throw new Refused("this task's image is not its pinned digest reference: refused before docker run");
  if (!(caps.copyOutBytes > 0) || !(caps.treeBytes > 0) || !(caps.objectBytes > 0)) throw new Refused('the copy-out caps must be positive: refused');
  const dir = treesDir(layout, uid);
  const final = join(dir, task.key);
  if (lstatOrNull(final)) return keepExisting(final, uid, task);
  const c: TaskContainer = { name: `bench-pull-${randomBytes(4).toString('hex')}-${task.key}`, image: task.image };
  let copied: Copied;
  try {
    docker.start(c, task.row);
    // Nothing is ever sent on its stdin, so there is no tree to check one against.
    copied = await copyOut(new TaskRunner(o, c, task.row, Buffer.alloc(0)), task, caps);
  } catch (e) {
    if (e instanceof Refused || e instanceof LimitsNotApplied) throw new Refused(message(e));
    // docker's own words name the image: never passed on.
    throw new Refused("the task's container didn't start or its command was refused: refused, nothing kept");
  } finally {
    docker.stop(c);
  }
  // Before index-pack, which builds each object in memory, and before anything is made in the store: the pack against
  // the budget.
  await packDeclaredBytes(copied.pack, caps);
  const tmp = join(dir, `.${task.key}.${randomBytes(8).toString('hex')}.new`);
  mkdirSync(tmp, { mode: 0o700 });
  let placed = false;
  try {
    try {
      build(tmp, final, uid, task, copied, caps);
    } catch (e) {
      if (e instanceof Refused) throw e;
      throw new Refused('building its bare remote and clone failed: refused, nothing kept');
    }
    // Checked again after the awaits: the store, and the place still free. Made empty here, then the built folder is
    // renamed over that empty folder only: never over anything else.
    treesDir(layout, uid);
    try {
      mkdirSync(final, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Refused(`${final} appeared while bench pull ran: refused, never replaced`);
      throw e;
    }
    try {
      renameSync(tmp, final);
      placed = true;
    } catch (e) {
      rmdirSync(final);
      throw e;
    }
  } finally {
    if (!placed) rmSync(tmp, { recursive: true, force: true });
  }
  return { key: task.key, kept: false };
}
