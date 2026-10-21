// Fixtures for the `bench pull` tests (#748, slice 4): a temp bench root with fixture rows (synthetic ids,
// example__proj-NNNN), the pins, the manifest and images.json; a fixture upstream repo and the packs its /testbed would
// send; and a stand-in docker CLI (no daemon, no image, no network). No test here: test/bench-pull*.test.ts use it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentUser } from '../src/os/index.js';
import { BENCH_USER_ENV } from '../scripts/bench/auth.js';
import { benchLayout, type BenchLayout } from '../scripts/bench/paths.js';

// WHY: loaded when a test runs, not at import, so each test fails on its own on code from before a change.
export const pinsMod = () => import('../scripts/bench/pins.js');
const sel = () => import('../scripts/bench/select.js');

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const uid = process.getuid?.() ?? 1000;

/** Anything shaped like an instance id or an instance image name, or the image namespace: never in what pull prints. */
export const TASKISH = /__|_1776_|sweb\.eval|\[task withheld\]/;

const DATA = Buffer.from('fixture stand-in for the pinned dataset file, never a task\n');
const DATA_SHA = sha256(DATA);
const REV = '0123456789abcdef0123456789abcdef01234567';
const HOST = 'data.example.org';
export const SEED = 20261018;

/** git on the host, in a temp folder, with no config but its own. */
export const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' };
export const git = (args: string[], input?: Buffer | string): string => execFileSync('git', args, { env: GIT_ENV, input, maxBuffer: 1 << 26 }).toString().trim();
const pack = (dir: string, lines: string): string => execFileSync('git', ['-C', dir, 'pack-objects', '-q', '--stdout'], { env: GIT_ENV, input: lines, maxBuffer: 1 << 26 }).toString('base64');
export const gitIn = (dir: string, args: string[]) => git(['--git-dir', dir, ...args]);

/**
 * A fixture upstream repo with history: its HEAD commit and tree; what the container's pack sends (that commit object
 * alone and exactly its tree's objects), base64; the tree's objects without the commit; and the whole history.
 */
export function treePack(files: Record<string, string | Buffer>) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pull-src-')));
  git(['init', '-q', '--template=', d]);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  writeFileSync(join(d, 'w.py'), 'x = 1\n');
  git(['-C', d, 'add', '-A']);
  git(['-C', d, 'commit', '-q', '-m', 'upstream history the bench must not keep']);
  const oldBlob = git(['-C', d, 'rev-parse', 'HEAD:w.py']);
  const parent = git(['-C', d, 'rev-parse', 'HEAD']);
  writeFileSync(join(d, 'w.py'), 'x = 2\n');
  git(['-C', d, 'add', '-A']);
  git(['-C', d, 'commit', '-q', '-m', 'more upstream history']);
  const commit = git(['-C', d, 'rev-parse', 'HEAD']);
  const tree = git(['-C', d, 'rev-parse', 'HEAD^{tree}']);
  const treeObjects = git(['-C', d, 'rev-list', '--objects', tree]);
  return {
    commit,
    tree,
    parent,
    oldBlob,
    b64: pack(d, `${commit}\n${treeObjects}\n`),
    treeOnly: pack(d, `${treeObjects}\n`),
    history: pack(d, `${git(['-C', d, 'rev-list', '--objects', 'HEAD'])}\n`),
  };
}
export const TREE = treePack({ 'pkg/mod.py': 'def f():\n    return 1\n', README: 'fixture repo\n' });
export const OTHER_TREE = treePack({ 'other.py': 'y = 1\n' });

/** Synthetic instance ids in SWE-bench's shape (the repo's convention: never a real task's). */
export const IDS = Array.from({ length: 60 }, (_, i) => `example__proj-${4200 + i}`);
/** Every fixture task's base_commit is the fixture repo's HEAD (or `base`): the pack's commit object must hash to it. */
export const baseOf = (_i: number): string => TREE.commit;
const row = (id: string, i: number, base: string) => ({
  instance_id: id,
  repo: 'example/proj',
  base_commit: base,
  problem_statement: `Fixture problem ${i}.`,
  patch: `--- a/w.py\n+++ b/w.py\n@@ -1 +1 @@\n-x = ${i}\n+x = ${i + 1}\n`,
  test_patch: `--- a/t.py\n+++ b/t.py\n@@ -0,0 +1 @@\n+def test_w_${i}(): assert True\n`,
  FAIL_TO_PASS: JSON.stringify([`t.py::test_w_${i}`]),
  PASS_TO_PASS: '[]',
  hints_text: '',
  difficulty: '<15 min fix',
});
const jsonl = (rows: readonly object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function canonicalSha(text: string): string {
  const rows = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .sort((a, b) => ((a.instance_id as string) < (b.instance_id as string) ? -1 : 1));
  return sha256(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** The test's own statement of the rule: rank by sha256("<seed>:<instance id>"), ascending. */
const ranked = (ids: readonly string[]): string[] => [...ids].sort((a, b) => (sha256(`${SEED}:${a}`) < sha256(`${SEED}:${b}`) ? -1 : 1));
export const ORDER = ranked(IDS);
export const keyOf = (n: number): string => `t${String(n + 1).padStart(2, '0')}`;

export const nameOf = (id: string): string => `swebench/sweb.eval.x86_64.${id.toLowerCase().split('__').join('_1776_')}`;
export const digestOf = (id: string): string => `sha256:${sha256(`image of ${id}`)}`;
/** Pinned: one digest per fixture task, plus more, so the set holds at least 100. */
export const OTHERS = Array.from({ length: 60 }, (_, i) => `sha256:${sha256(`other image ${i}`)}`);
const DIGESTS = [...IDS.map(digestOf), ...OTHERS].sort();
export const refOf = (id: string): string => `${nameOf(id)}@${digestOf(id)}`;
const idOfName = new Map(IDS.map((id) => [nameOf(id), id]));

export interface Bench {
  base: string;
  home: string;
  layout: BenchLayout;
  pinsText: string;
}

/**
 * A temp bench root: the store (0700), the dataset file, the rows (every base_commit `o.base`, default the fixture
 * repo's HEAD), the manifest and (unless told not to) images.json.
 */
export async function bench(o: { images?: Record<string, string> | false; base?: string } = {}): Promise<Bench> {
  const { writeSelection } = await sel();
  const { parsePins } = await pinsMod();
  const rowsText = jsonl(IDS.map((id, i) => row(id, i, o.base ?? TREE.commit)));
  const dataset = { base: `https://${HOST}/datasets/fixture/resolve/`, path: 'data/verified.parquet', revision: REV, sha256: DATA_SHA, max_bytes: 1024 * 1024, hosts: [HOST] };
  const pinsText = `${JSON.stringify({ dataset, image_digests: DIGESTS, selection: { rule: 'sha256-rank-v1', seed: SEED, rows_sha256: canonicalSha(rowsText) } }, null, 2)}\n`;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pull-')));
  const home = join(base, 'home');
  mkdirSync(home);
  const layout = benchLayout(join(home, 'bench'));
  for (const d of [layout.root, layout.state, join(layout.state, 'evals'), join(layout.state, 'evals', 'held-out'), layout.heldOut, layout.data]) {
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
  }
  for (const [f, data] of [
    [join(layout.data, `${DATA_SHA}-verified.parquet`), DATA],
    [join(layout.data, 'rows.jsonl'), rowsText],
  ] as const) {
    writeFileSync(f, data, { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  writeSelection(layout, uid, parsePins(pinsText));
  if (o.images !== false) writeImagesFile(layout, o.images ?? Object.fromEntries(ORDER.slice(0, 50).map((id) => [id, refOf(id)])));
  return { base, home, layout, pinsText };
}

export function writeImagesFile(layout: BenchLayout, map: Record<string, string>): void {
  const f = join(layout.heldOut, 'images.json');
  writeFileSync(f, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
}

export const treesDir = (l: BenchLayout) => join(l.heldOut, 'trees');

export interface Sent {
  status: number | null;
  stdout: string;
  stderr: string;
}

const MEM = 8 * 1024 ** 3;

/**
 * A stand-in docker CLI: records every argv, answers as a rootless daemon with the limits applied, pulls and reads
 * back each image by digest, and answers a task container's /testbed probe (HEAD and tree: `o.head` and `o.tree`, else
 * the fixture repo's) and pack (`o.pack`, else the fixture repo's). Each `o` hook may answer otherwise (undefined: the
 * default).
 */
export function docker(
  o: {
    rootless?: boolean;
    pull?: (ref: string, n: number) => Sent | undefined;
    readBack?: (ref: string) => string | undefined;
    head?: (id: string) => string | undefined;
    tree?: string;
    probe?: (id: string) => Sent | undefined;
    pack?: (id: string) => Sent | undefined;
    noGit?: (id: string) => boolean;
  } = {},
) {
  const calls: string[][] = [];
  const containers = new Map<string, string>();
  let pulls = 0;
  const ok = (stdout = ''): Sent => ({ status: 0, stdout, stderr: '' });
  const call = (_bin: string, args: readonly string[]): Sent => {
    calls.push([...args]);
    const [verb] = args;
    if (verb === 'info') return ok(JSON.stringify(o.rootless === false ? ['name=seccomp,profile=builtin'] : ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns']));
    if (verb === 'pull') return o.pull?.(args[1]!, pulls++) ?? ok();
    if (verb === 'image' && args[1] === 'inspect') return ok(JSON.stringify([o.readBack?.(args[4]!) ?? args[4]!]));
    if (verb === 'run') {
      containers.set(args[args.indexOf('--name') + 1]!, args[args.indexOf('infinity') - 1]!);
      return ok('container-id\n');
    }
    if (verb === 'inspect') return ok(JSON.stringify({ Memory: MEM, MemorySwap: MEM, NanoCpus: 4e9, PidsLimit: 4096 }));
    if (verb === 'rm') return ok();
    if (verb === 'exec') {
      const c = args.find((a) => containers.has(a))!;
      const id = idOfName.get(containers.get(c)!.split('@')[0]!.split(':')[0]!) ?? '';
      if (args.includes('/sys/fs/cgroup/memory.max')) return ok(`${MEM}\n0\n400000 100000\n4096\n`);
      const script = args[args.indexOf('-c') + 1] ?? '';
      if (script.includes('write-tree')) return o.pack?.(id) ?? ok(`${o.tree ?? TREE.tree}\n${TREE.b64}`);
      if (script.includes('pack-objects')) return o.pack?.(id) ?? ok(TREE.b64);
      if (script.includes('rev-parse')) {
        const p = o.probe?.(id);
        if (p) return p;
        if (o.noGit?.(id)) return ok('none\n');
        return ok(`git\n${o.head?.(id) ?? TREE.commit}\n${o.tree ?? TREE.tree}\n`);
      }
    }
    return { status: 1, stdout: '', stderr: `stand-in: unexpected docker ${args.join(' ')}` };
  };
  return { call, calls, containers };
}

/** The bench command's deps on a temp bench machine: the bench user, its home, and the stand-in docker. */
export function cliDeps(b: { home: string }, out: string[], d: ReturnType<typeof docker>, over: Record<string, unknown> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: '/nonexistent', HOME: b.home, [BENCH_USER_ENV]: currentUser(), DOCKER_HOST: 'unix:///nonexistent/docker.sock' };
  return { env, user: currentUser(), uid, euid: process.geteuid?.() ?? uid, passwdHome: () => b.home, out: (l: string) => out.push(l), docker: { docker: '/nonexistent/docker', call: d.call }, host: { cpus: 16, memoryBytes: 64 * 1024 ** 3 }, ...over };
}

export const verbs = (d: ReturnType<typeof docker>, v: string) => d.calls.filter((a) => a[0] === v);
