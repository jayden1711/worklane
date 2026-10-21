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
// - with none: /testbed's files are added to a throwaway repository in the container (outside /testbed), and that
//   tree is packed out. Its tree id is recorded as the content hash, and the output says HEAD wasn't checked.
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
import type { Mode } from './caps.js';
import { LimitsNotApplied, TaskRunner, WORK, type Docker, type DockerOptions, type TaskContainer } from './container.js';
import { pullImage, PullRefused, writeVerified } from './download.js';
import { realPath, type BenchLayout } from './paths.js';
import type { Pins } from './pins.js';
import { loadTasks, type SelectedTask } from './select.js';
import { heldOutCheck } from './store.js';

/** The base trees' folder in the held-out store, and each tree's record. */
export const TREES = 'trees';
export const TREE_RECORD = 'tree.json';

/** A refusal whose message names no task: safe to print beside the task's key. */
export class Refused extends Error {}

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
  /** git: /testbed's HEAD tree, HEAD checked to be base_commit; content: /testbed's files (no git metadata there). */
  source: 'git' | 'content';
  head_checked: boolean;
  tree: string;
  /** The one commit, on the tree, in the bare remote and the clone. */
  commit: string;
}

export interface TreeResult {
  key: string;
  source: 'git' | 'content';
  /** true: already there and verified, so nothing was copied. */
  kept: boolean;
}

/** git on the host, with no config but its own (an agent's Edit could reach ~/.gitconfig), and the local file protocol only. */
const GIT_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@localhost', GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@localhost', GIT_COMMITTER_DATE: '@0 +0000' };
const GIT_HARDENED = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always'];
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
/** In the container, with no git metadata in /testbed: its files in a throwaway repository under /work, the tree id, then that tree as a pack in base64. */
const CONTENT = [
  'set -e',
  'g=/work/content.git',
  'git init -q --bare --template= "$g"',
  'cd /testbed',
  'GIT_DIR="$g" GIT_INDEX_FILE="$g/index" GIT_WORK_TREE=/testbed git -c core.fsmonitor=false add -A -f .',
  't=$(GIT_DIR="$g" GIT_INDEX_FILE="$g/index" git write-tree)',
  'echo "$t"',
  "printf '%s\\n' \"$t\" | GIT_DIR=\"$g\" git pack-objects -q --stdout --revs | base64 -w0",
].join('\n');

/** The three scripts run in a task's container, for the test that runs them with sh on a stand-in /testbed. */
export const CONTAINER_SCRIPTS = Object.freeze({ probe: PROBE, pack: PACK, content: CONTENT });

/** A pack sent as base64: refused unless it is base64 and not empty. Its contents are checked by git on the host. */
function decodePack(text: string): Buffer {
  const s = text.trim();
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Refused("what came out of /testbed is not a pack (not base64): refused, nothing kept");
  return Buffer.from(s, 'base64');
}

interface Copied {
  source: 'git' | 'content';
  tree: string;
  pack: Buffer;
}

/** The task's base tree, packed out of its container's /testbed: as the top of this file says. */
async function copyOut(run: TaskRunner, task: SelectedTask): Promise<Copied> {
  const probe = await run.exec(WORK, ['sh', '-c', PROBE], {}, 5 * 60_000);
  if (probe.status !== 0) throw new Refused(`the /testbed probe in its container failed (exit ${probe.status ?? 'none'}): refused, nothing kept`);
  const lines = probe.stdout.split('\n').map((l) => l.trim());
  while (lines.at(-1) === '') lines.pop();
  if (lines[0] === 'git') {
    const [head, tree] = [lines[1] ?? '', lines[2] ?? ''];
    if (lines.length !== 3 || !SHA1.test(head) || !SHA1.test(tree)) throw new Refused("/testbed has git metadata, but its HEAD and tree didn't read as object ids: refused, nothing kept");
    if (head !== task.row.base_commit) throw new Refused("/testbed's HEAD is not this task's base_commit: refused, nothing kept");
    const p = await run.exec(WORK, ['sh', '-c', PACK, 'sh', head, tree], {}, 60 * 60_000);
    if (p.status !== 0) throw new Refused(`copying /testbed's tree out failed (exit ${p.status ?? 'none'}): refused, nothing kept`);
    return { source: 'git', tree, pack: decodePack(p.stdout) };
  }
  if (lines.length === 1 && lines[0] === 'none') {
    const p = await run.exec(WORK, ['sh', '-c', CONTENT], {}, 60 * 60_000);
    if (p.status !== 0) throw new Refused(`copying /testbed's content out failed (exit ${p.status ?? 'none'}): refused, nothing kept`);
    const nl = p.stdout.indexOf('\n');
    const tree = nl < 0 ? '' : p.stdout.slice(0, nl).trim();
    if (!SHA1.test(tree)) throw new Refused("/testbed's content didn't come out as a tree id and a pack: refused, nothing kept");
    return { source: 'content', tree, pack: decodePack(p.stdout.slice(nl + 1)) };
  }
  throw new Refused('the /testbed probe answered neither git nor none: refused, nothing kept');
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
  if ((rec.source !== 'git' && rec.source !== 'content') || rec.head_checked !== (rec.source === 'git') || !SHA1.test(rec.tree ?? '') || !SHA1.test(rec.commit ?? '')) throw new Refused(`${join(final, TREE_RECORD)} is not a whole tree record: refused, left as it is`);
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
  return { key: task.key, source: rec.source, kept: true };
}

/** The bare remote, the clone and the record, built in `tmp` from what came out of the container. Throws Refused on any doubt. */
function build(tmp: string, final: string, uid: number, task: SelectedTask, c: Copied): void {
  const scratch = join(tmp, 'import.git');
  const remote = join(tmp, 'remote.git');
  const clone = join(tmp, 'clone');
  git(['init', '--bare', '-q', '--template=', scratch]);
  try {
    // index-pack hashes every object, so what is indexed is exactly what the ids say.
    git(['--git-dir', scratch, 'index-pack', '--stdin'], c.pack);
    if (git(['--git-dir', scratch, 'cat-file', '-t', c.tree]) !== 'tree') throw new Error('not a tree');
  } catch {
    throw new Refused("what came out of /testbed is not a pack holding its tree: refused, nothing kept");
  }
  if (c.source === 'git') {
    // By hash, not by the container's word: base_commit's own commit object, and its tree is the one copied out.
    let ok = false;
    try {
      ok = git(['--git-dir', scratch, 'cat-file', '-t', task.row.base_commit]) === 'commit' && git(['--git-dir', scratch, 'rev-parse', '--verify', `${task.row.base_commit}^{tree}`]) === c.tree;
    } catch {
      ok = false;
    }
    if (!ok) throw new Refused("the pack out of /testbed doesn't hold base_commit's own commit on that tree: refused, nothing kept");
  }
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
  const rec: TreeRecord = { key: task.key, instance_id: task.row.instance_id, base_commit: task.row.base_commit, image_digest: task.ref.digest, source: c.source, head_checked: c.source === 'git', tree: c.tree, commit };
  const text = `${JSON.stringify(rec, null, 2)}\n`;
  writeVerified(join(tmp, TREE_RECORD), tmp, Buffer.from(text), createHash('sha256').update(text).digest('hex'), uid);
}

/**
 * The task's base tree in the store (trees/<key>/), as the top of this file says: kept when it is already there and
 * checks out, otherwise copied out of the task's image through `docker` (its container runner) and built. Refuses
 * (throws Refused, naming no task) on any doubt, keeping nothing of it.
 */
export async function baseTree(layout: BenchLayout, uid: number, task: SelectedTask, o: DockerOptions, docker: Docker): Promise<TreeResult> {
  if (!SHA1.test(task.row.base_commit)) throw new Refused("this task's base_commit is not a commit id: refused");
  const dir = treesDir(layout, uid);
  const final = join(dir, task.key);
  if (lstatOrNull(final)) return keepExisting(final, uid, task);
  const c: TaskContainer = { name: `bench-pull-${randomBytes(4).toString('hex')}-${task.key}`, image: task.image };
  let copied: Copied;
  try {
    docker.start(c, task.row);
    // Nothing is ever sent on its stdin, so there is no tree to check one against.
    copied = await copyOut(new TaskRunner(o, c, task.row, Buffer.alloc(0)), task);
  } catch (e) {
    if (e instanceof Refused || e instanceof LimitsNotApplied) throw new Refused(message(e));
    // docker's own words name the image: never passed on.
    throw new Refused("the task's container didn't start or its command was refused: refused, nothing kept");
  } finally {
    docker.stop(c);
  }
  const tmp = join(dir, `.${task.key}.${randomBytes(8).toString('hex')}.new`);
  mkdirSync(tmp, { mode: 0o700 });
  let placed = false;
  try {
    try {
      build(tmp, final, uid, task, copied);
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
  return { key: task.key, source: copied.source, kept: false };
}
