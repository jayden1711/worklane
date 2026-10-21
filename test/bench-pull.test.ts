// The rest of the bench's task setup (#748, slice 4): `bench pull --tasks smoke|baseline` pulls each selected task's
// image by its pinned digest only (never a tag) and reads the digest back, then copies each task's base tree out of
// its image's /testbed, through the bench's own container runner, into the held-out store: a bare remote with one
// commit (no upstream history) and a clone of it. Stand-ins only: fixture rows with synthetic ids
// (example__proj-NNNN), a temp bench root, a stand-in docker (no daemon, no image, no network), no model, no real
// store. Host git builds the fixture pack and the store's repos, in temp folders only, with no config of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentUser } from '../src/os/index.js';
import { BENCH_USER_ENV } from '../scripts/bench/auth.js';
import { benchLayout, type BenchLayout } from '../scripts/bench/paths.js';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import { repoRoot } from './helpers.js';

void repoRoot;
const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: loaded when a test runs, not at the top, so each test fails on its own on code from before this change (the
// fail-without run).
const pinsMod = () => import('../scripts/bench/pins.js');
const sel = () => import('../scripts/bench/select.js');
const cli = () => import('../scripts/bench/cli.js');

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const uid = process.getuid?.() ?? 1000;

/** Anything shaped like an instance id or an instance image name, or the image namespace: never in what pull prints. */
const TASKISH = /__|_1776_|sweb\.eval|\[task withheld\]/;

const DATA = Buffer.from('fixture stand-in for the pinned dataset file, never a task\n');
const DATA_SHA = sha256(DATA);
const REV = '0123456789abcdef0123456789abcdef01234567';
const HOST = 'data.example.org';
const SEED = 20261018;

/** git on the host, in a temp folder, with no config but its own. */
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' };
const git = (args: string[], input?: Buffer | string): string => execFileSync('git', args, { env: GIT_ENV, input, maxBuffer: 1 << 26 }).toString().trim();
const pack = (dir: string, lines: string): string => execFileSync('git', ['-C', dir, 'pack-objects', '-q', '--stdout'], { env: GIT_ENV, input: lines }).toString('base64');

/**
 * A fixture upstream repo with history: its HEAD commit and tree; what the container's pack sends (that commit object
 * alone and exactly its tree's objects), base64; the tree's objects without the commit; and the whole history.
 */
function treePack(files: Record<string, string>) {
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
const TREE = treePack({ 'pkg/mod.py': 'def f():\n    return 1\n', README: 'fixture repo\n' });
const OTHER_TREE = treePack({ 'other.py': 'y = 1\n' });

/** Synthetic instance ids in SWE-bench's shape (the repo's convention: never a real task's). */
const IDS = Array.from({ length: 60 }, (_, i) => `example__proj-${4200 + i}`);
/** Every fixture task's base_commit is the fixture repo's HEAD: the pack's commit object must hash to it. */
const baseOf = (_i: number): string => TREE.commit;
const row = (id: string, i: number) => ({
  instance_id: id,
  repo: 'example/proj',
  base_commit: baseOf(i),
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
const ORDER = ranked(IDS);
const keyOf = (n: number): string => `t${String(n + 1).padStart(2, '0')}`;

const nameOf = (id: string): string => `swebench/sweb.eval.x86_64.${id.toLowerCase().split('__').join('_1776_')}`;
const digestOf = (id: string): string => `sha256:${sha256(`image of ${id}`)}`;
/** Pinned: one digest per fixture task, plus more, so the set holds at least 100. */
const OTHERS = Array.from({ length: 60 }, (_, i) => `sha256:${sha256(`other image ${i}`)}`);
const DIGESTS = [...IDS.map(digestOf), ...OTHERS].sort();
const refOf = (id: string): string => `${nameOf(id)}@${digestOf(id)}`;
const idOfName = new Map(IDS.map((id) => [nameOf(id), id]));

interface Bench {
  base: string;
  home: string;
  layout: BenchLayout;
  pinsText: string;
}

/** A temp bench root: the store (0700), the dataset file, the rows, the manifest and (unless told not to) images.json. */
async function bench(o: { images?: Record<string, string> | false } = {}): Promise<Bench> {
  const { writeSelection } = await sel();
  const { parsePins } = await pinsMod();
  const rowsText = jsonl(IDS.map(row));
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

function writeImagesFile(layout: BenchLayout, map: Record<string, string>): void {
  const f = join(layout.heldOut, 'images.json');
  writeFileSync(f, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  chmodSync(f, 0o600);
}

const treesDir = (l: BenchLayout) => join(l.heldOut, 'trees');

interface Sent {
  status: number | null;
  stdout: string;
  stderr: string;
}

const MEM = 8 * 1024 ** 3;

/**
 * A stand-in docker CLI: records every argv, answers as a rootless daemon with the limits applied, pulls and reads
 * back each image by digest, and answers a task container's /testbed probe and pack from the fixture tree. Each `o`
 * hook may answer otherwise (undefined: the default).
 */
function docker(
  o: {
    rootless?: boolean;
    pull?: (ref: string, n: number) => Sent | undefined;
    readBack?: (ref: string) => string | undefined;
    head?: (id: string) => string | undefined;
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
      const id = idOfName.get(containers.get(c)!.split('@')[0]!)!;
      if (args.includes('/sys/fs/cgroup/memory.max')) return ok(`${MEM}\n0\n400000 100000\n4096\n`);
      const script = args[args.indexOf('-c') + 1] ?? '';
      if (script.includes('write-tree')) return o.pack?.(id) ?? ok(`${TREE.tree}\n${TREE.b64}`);
      if (script.includes('pack-objects')) return o.pack?.(id) ?? ok(TREE.b64);
      if (script.includes('rev-parse')) {
        const p = o.probe?.(id);
        if (p) return p;
        if (o.noGit?.(id)) return ok('none\n');
        return ok(`git\n${o.head?.(id) ?? baseOf(IDS.indexOf(id))}\n${TREE.tree}\n`);
      }
    }
    return { status: 1, stdout: '', stderr: `stand-in: unexpected docker ${args.join(' ')}` };
  };
  return { call, calls, containers };
}

/** The bench command's deps on a temp bench machine: the bench user, its home, and the stand-in docker. */
function cliDeps(b: { home: string }, out: string[], d: ReturnType<typeof docker>, over: Record<string, unknown> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: '/nonexistent', HOME: b.home, [BENCH_USER_ENV]: currentUser(), DOCKER_HOST: 'unix:///nonexistent/docker.sock' };
  return { env, user: currentUser(), uid, euid: process.geteuid?.() ?? uid, passwdHome: () => b.home, out: (l: string) => out.push(l), docker: { docker: '/nonexistent/docker', call: d.call }, host: { cpus: 16, memoryBytes: 64 * 1024 ** 3 }, ...over };
}

const verbs = (d: ReturnType<typeof docker>, v: string) => d.calls.filter((a) => a[0] === v);
const gitIn = (dir: string, args: string[]) => git(['--git-dir', dir, ...args]);

// ---- The flag ----

test('bench pull takes --tasks smoke or --tasks baseline and nothing else, refused before any docker call', linux, async () => {
  const { main } = await cli();
  const help: string[] = [];
  assert.equal(main(['help'], { out: (l: string) => help.push(l) }), 0);
  assert.match(help.join('\n'), /pull +--tasks smoke\|baseline/);
  const b = await bench();
  for (const argv of [['pull'], ['pull', '--tasks'], ['pull', '--tasks', 'all'], ['pull', '--tasks', 'constructor'], ['pull', '--tasks', 'smoke', 'extra'], ['pull', '--tasks=smoke'], ['pull', IDS[0]!], ['pull', '--tasks', nameOf(IDS[0]!)]]) {
    const out: string[] = [];
    const d = docker();
    assert.equal(await main(argv, cliDeps(b, out, d) as never), 2, argv.join(' '));
    const text = out.join('\n');
    assert.match(text, /pull takes --tasks smoke or --tasks baseline/, argv.join(' '));
    assert.doesNotMatch(text, /__|_1776_/, argv.join(' '));
    assert.equal(d.calls.length, 0, `${argv.join(' ')}: no docker call`);
  }
  assert.ok(!existsSync(treesDir(b.layout)));
});

// ---- The pulls ----

test('bench pull --tasks smoke: each smoke image pulled by its pinned digest, never a tag, read back, then each base tree built', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const out: string[] = [];
  const d = docker();
  assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 0, out.join('\n'));
  const smoke = ORDER.slice(0, 4);
  // Pulled by digest only: `pull <name>@sha256:<64 hex>`, the task's own reference from images.json, and nothing else.
  const pulls = verbs(d, 'pull');
  assert.deepEqual(pulls, smoke.map((id) => ['pull', refOf(id)]));
  for (const args of d.calls) {
    for (const a of args) if (a.includes('sweb.eval')) assert.match(a, /^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/, `no tag, ever: docker ${args[0]} ${a}`);
  }
  assert.deepEqual(d.calls.filter((a) => a[0] === 'image').map((a) => a.slice(0, 4)), smoke.map(() => ['image', 'inspect', '--format', '{{json .RepoDigests}}']));
  // One throwaway container per task, from its digest, with no network, and removed after.
  const runs = verbs(d, 'run');
  assert.equal(runs.length, 4);
  for (const r of runs) {
    assert.equal(r[r.indexOf('--network') + 1], 'none');
    assert.ok(r.includes('--cap-drop') && r.includes('--memory'));
  }
  assert.deepEqual([...d.containers.values()], smoke.map(refOf));
  assert.deepEqual(new Set(verbs(d, 'rm').map((a) => a[2])), new Set(d.containers.keys()), 'every container removed');
  // Each tree in the store: a bare remote with one commit whose tree is /testbed's at base_commit, and a clone of it.
  const dir = treesDir(b.layout);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(dir).sort(), ['t01', 't02', 't03', 't04'], 'nothing else: no temporary folder left');
  for (const [n, id] of smoke.entries()) {
    const t = join(dir, keyOf(n));
    const remote = join(t, 'remote.git');
    assert.equal(gitIn(remote, ['rev-list', '--count', 'main']), '1', 'one commit: no upstream history');
    assert.equal(gitIn(remote, ['rev-parse', 'main^{tree}']), TREE.tree, "the tree is /testbed's");
    assert.equal(gitIn(remote, ['rev-parse', '--is-bare-repository']), 'true');
    const clone = join(t, 'clone');
    assert.equal(git(['-C', clone, 'rev-parse', 'HEAD']), gitIn(remote, ['rev-parse', 'main']));
    assert.equal(git(['-C', clone, 'remote', 'get-url', 'origin']), remote, 'its remote is the local bare one');
    assert.equal(readFileSync(join(clone, 'w.py'), 'utf8'), 'x = 2\n');
    const rec = JSON.parse(readFileSync(join(t, 'tree.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(lstatSync(join(t, 'tree.json')).mode & 0o777, 0o600);
    assert.deepEqual({ ...rec, commit: undefined }, { key: keyOf(n), instance_id: id, base_commit: baseOf(IDS.indexOf(id)), image_digest: digestOf(id), source: 'git', head_checked: true, tree: TREE.tree, commit: undefined });
  }
  const text = out.join('\n');
  assert.match(text, /PASS +pull +4 images/);
  for (const k of ['t01', 't02', 't03', 't04']) assert.match(text, new RegExp(`PASS +${k} +base tree`));
  assert.doesNotMatch(text, TASKISH, 'built from keys: nothing for the backstop to withhold');
  assert.ok(!text.includes(TREE.tree), "no task's tree hash beside its key");
  // Again: the trees are already there and verified, so no container runs.
  const again: string[] = [];
  const d2 = docker();
  assert.equal(await pull(cliDeps(b, again, d2) as never, 'smoke', () => parsePins(b.pinsText)), 0, again.join('\n'));
  assert.equal(verbs(d2, 'run').length, 0);
  assert.match(again.join('\n'), /t01 +base tree.*kept/);
});

test('bench pull --tasks baseline pulls all 50, by digest', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const out: string[] = [];
  const d = docker();
  assert.equal(await pull(cliDeps(b, out, d) as never, 'baseline', () => parsePins(b.pinsText)), 0, out.join('\n'));
  assert.deepEqual(verbs(d, 'pull'), ORDER.slice(0, 50).map((id) => ['pull', refOf(id)]));
  assert.equal(readdirSync(treesDir(b.layout)).length, 50);
  assert.doesNotMatch(out.join('\n'), TASKISH);
});

test('a pulled image whose digest does not read back as images.json and pins.json give it is refused, naming the key only', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const t02 = ORDER[1]!;
  for (const [readBack, why] of [
    [`${nameOf(t02)}@${OTHERS[0]}`, 'another pinned digest'],
    [`${nameOf(t02)}@sha256:${sha256('not pinned at all')}`, 'a digest not pinned'],
    [`${nameOf(ORDER[0]!)}@${digestOf(t02)}`, "the digest under another task's name"],
  ] as const) {
    const out: string[] = [];
    const d = docker({ readBack: (ref) => (ref === refOf(t02) ? readBack : undefined) });
    assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1, why);
    const text = out.join('\n');
    assert.match(text, /FAIL +pull +t02: .*digest/, why);
    assert.doesNotMatch(text, TASKISH, why);
    assert.equal(verbs(d, 'pull').length, 2, `${why}: stops at t02`);
    assert.equal(verbs(d, 'run').length, 0, `${why}: no tree is built`);
    assert.ok(!existsSync(treesDir(b.layout)), why);
  }
});

test("a failed pull is refused naming the key, and docker's own words (which name the image) are never printed", linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const out: string[] = [];
  const d = docker({ pull: (ref) => ({ status: 1, stdout: '', stderr: `Error response from daemon: manifest for ${ref} not found; ${ORDER[0]}` }) });
  assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1);
  const text = out.join('\n');
  assert.match(text, /FAIL +pull +t01: /);
  assert.doesNotMatch(text, TASKISH);
  assert.ok(!text.includes('not found'), "docker's stderr is not passed on");
  assert.equal(verbs(d, 'run').length, 0);
});

test('images.json missing, or with a digest that is not pinned: refused before any docker call', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const map = Object.fromEntries(ORDER.slice(0, 50).map((id) => [id, refOf(id)]));
  for (const [images, re, why] of [
    [false, /images file/, 'no images.json'],
    [{ ...map, [ORDER[2]!]: `${nameOf(ORDER[2]!)}@sha256:${sha256('unpinned')}` }, /t03/, 'an unpinned digest'],
    [{ ...map, [ORDER[2]!]: `${nameOf(ORDER[2]!)}:latest` }, /t03/, 'a tag'],
    [{ ...map, [ORDER[2]!]: refOf(ORDER[3]!) }, /t03/, "another task's image"],
  ] as const) {
    const b = await bench({ images: images as Record<string, string> | false });
    const out: string[] = [];
    const d = docker();
    assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1, why);
    assert.match(out.join('\n'), re, why);
    assert.doesNotMatch(out.join('\n'), TASKISH, why);
    assert.equal(d.calls.length, 0, `${why}: no docker call`);
  }
});

test('not the bench user, a store that is not 0700, or a daemon that is not rootless: refused before any pull', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const pins = () => parsePins(b.pinsText);
  const other: string[] = [];
  const d1 = docker();
  assert.equal(await pull(cliDeps(b, other, d1, { env: { PATH: '/nonexistent', HOME: b.home, [BENCH_USER_ENV]: 'someone-else' } }) as never, 'smoke', pins), 1);
  assert.match(other.join('\n'), /FAIL/);
  assert.equal(d1.calls.length, 0);
  chmodSync(b.layout.heldOut, 0o755);
  const open: string[] = [];
  const d2 = docker();
  assert.equal(await pull(cliDeps(b, open, d2) as never, 'smoke', pins), 1);
  assert.match(open.join('\n'), /0700/);
  assert.equal(d2.calls.length, 0);
  chmodSync(b.layout.heldOut, 0o700);
  const rootful: string[] = [];
  const d3 = docker({ rootless: false });
  assert.equal(await pull(cliDeps(b, rootful, d3) as never, 'smoke', pins), 1);
  assert.match(rootful.join('\n'), /rootless/);
  assert.equal(verbs(d3, 'pull').length, 0);
});

test('images.json changed while the images were pulled: refused before any tree', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const map = Object.fromEntries(ORDER.slice(0, 50).map((id) => [id, refOf(id)]));
  const out: string[] = [];
  // Another pinned digest under t03's own name: loadTasks alone would take it.
  const d = docker({ pull: (_ref, n) => (n === 1 ? (writeImagesFile(b.layout, { ...map, [ORDER[2]!]: `${nameOf(ORDER[2]!)}@${OTHERS[5]}` }), undefined) : undefined) });
  assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1);
  assert.match(out.join('\n'), /changed/);
  assert.doesNotMatch(out.join('\n'), TASKISH);
  assert.equal(verbs(d, 'run').length, 0);
  assert.ok(!existsSync(treesDir(b.layout)));
});

// ---- The base trees ----

test("/testbed's HEAD is not the task's base_commit: refused, nothing kept for that task, its container removed", linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const out: string[] = [];
  const d = docker({ head: (id) => (id === ORDER[1] ? sha256('somewhere else').slice(0, 40) : undefined) });
  assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1);
  const text = out.join('\n');
  assert.match(text, /FAIL +t02 +.*HEAD.*base_commit/);
  assert.doesNotMatch(text, TASKISH);
  assert.deepEqual(readdirSync(treesDir(b.layout)), ['t01'], 't02 kept nothing, no temporary folder left');
  assert.equal(verbs(d, 'run').length, 2, 'stops at t02');
  assert.deepEqual(new Set(verbs(d, 'rm').map((a) => a[2])), new Set(d.containers.keys()), 'its container removed too');
  assert.equal(d.calls.filter((a) => a[0] === 'exec' && (a[a.indexOf('-c') + 1] ?? '').includes('pack-objects')).length, 1, "t02's tree is never even copied out");
});

test('/testbed with git metadata that does not read, or a probe that answers anything else: refused', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  for (const [probe, why] of [
    [{ status: 128, stdout: 'git\n', stderr: 'fatal: not a git repository' }, 'git fails'],
    [{ status: 0, stdout: 'git\nnot-a-sha\nnot-a-sha\n', stderr: '' }, 'no commit id'],
    [{ status: 0, stdout: `git\n${baseOf(0)}\n`, stderr: '' }, 'no tree id'],
    [{ status: 0, stdout: 'something\n', stderr: '' }, 'neither git nor none'],
    [{ status: 1, stdout: '', stderr: 'oci runtime error' }, 'the probe fails'],
  ] as const) {
    const b = await bench();
    const out: string[] = [];
    const d = docker({ probe: () => ({ ...probe }) });
    assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1, why);
    assert.match(out.join('\n'), /FAIL +t01 /, why);
    assert.doesNotMatch(out.join('\n'), TASKISH, why);
    assert.deepEqual(readdirSync(treesDir(b.layout)), [], `${why}: nothing kept`);
  }
});

test("a pack that isn't exactly /testbed's tree is refused and nothing is kept", linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  for (const [pack, why] of [
    [{ status: 0, stdout: OTHER_TREE.b64, stderr: '' }, "another commit's tree"],
    [{ status: 0, stdout: TREE.treeOnly, stderr: '' }, "the right tree without base_commit's commit object: the container's word alone"],
    [{ status: 0, stdout: OTHER_TREE.history, stderr: '' }, "another repo's whole history"],
    [{ status: 0, stdout: 'not base64 at all!', stderr: '' }, 'not base64'],
    [{ status: 0, stdout: Buffer.from('PACK but no pack').toString('base64'), stderr: '' }, 'not a pack'],
    [{ status: 0, stdout: '', stderr: '' }, 'empty'],
    [{ status: 0, stdout: TREE.b64.slice(0, Math.floor(TREE.b64.length / 8) * 4), stderr: '' }, 'cut short'],
    [{ status: 2, stdout: TREE.b64, stderr: '' }, 'a failed exec'],
  ] as const) {
    const b = await bench();
    const out: string[] = [];
    const d = docker({ pack: () => ({ ...pack }) });
    assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1, why);
    assert.match(out.join('\n'), /FAIL +t01 /, why);
    assert.doesNotMatch(out.join('\n'), TASKISH, why);
    assert.deepEqual(readdirSync(treesDir(b.layout)), [], `${why}: nothing kept, no temporary folder left`);
  }
});

test('a pack that carries upstream history: only the one new commit and its tree are kept, in the bare remote and the clone', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const out: string[] = [];
  assert.equal(await pull(cliDeps(b, out, docker({ pack: () => ({ status: 0, stdout: TREE.history, stderr: '' }) })) as never, 'smoke', () => parsePins(b.pinsText)), 0, out.join('\n'));
  const t = join(treesDir(b.layout), 't01');
  for (const repo of [join(t, 'remote.git'), join(t, 'clone', '.git')]) {
    for (const obj of [TREE.parent, TREE.oldBlob, TREE.commit]) assert.throws(() => gitIn(repo, ['cat-file', '-e', obj]), `${repo}: no upstream object`);
    assert.equal(gitIn(repo, ['rev-list', '--count', '--all']), '1');
    assert.equal(gitIn(repo, ['rev-parse', 'HEAD^{tree}']), TREE.tree);
  }
});

test('no git metadata in /testbed: its content hash is recorded instead, and the output says HEAD was not checked', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const out: string[] = [];
  const d = docker({ noGit: (id) => id === ORDER[0] });
  assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 0, out.join('\n'));
  assert.match(out.join('\n'), /t01 +base tree.*no git metadata.*content hash.*not checked/);
  assert.match(out.join('\n'), /t02 +base tree.*HEAD checked/);
  const rec = JSON.parse(readFileSync(join(treesDir(b.layout), 't01', 'tree.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(rec.source, 'content');
  assert.equal(rec.head_checked, false);
  assert.equal(rec.tree, TREE.tree);
  assert.equal(gitIn(join(treesDir(b.layout), 't01', 'remote.git'), ['rev-list', '--count', 'main']), '1');
});

test("a tree already at a task's place that is a link, another task's or another image's is refused and left as it is", linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const pins = (b: Bench) => () => parsePins(b.pinsText);
  // A link at trees/t01.
  const l = await bench();
  mkdirSync(treesDir(l.layout), { mode: 0o700 });
  const elsewhere = join(l.base, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(treesDir(l.layout), 't01'));
  const out: string[] = [];
  const d = docker();
  assert.equal(await pull(cliDeps(l, out, d) as never, 'smoke', pins(l)), 1);
  assert.match(out.join('\n'), /FAIL +t01 +.*link/);
  assert.ok(lstatSync(join(treesDir(l.layout), 't01')).isSymbolicLink(), 'left as it is');
  assert.deepEqual(readdirSync(elsewhere), []);
  // The trees folder itself a link: refused, nothing made through it.
  const lt = await bench();
  const away = join(lt.base, 'away');
  mkdirSync(away, { mode: 0o700 });
  symlinkSync(away, treesDir(lt.layout));
  const outT: string[] = [];
  assert.equal(await pull(cliDeps(lt, outT, docker()) as never, 'smoke', pins(lt)), 1);
  assert.match(outT.join('\n'), /FAIL +t01 +.*link/);
  assert.deepEqual(readdirSync(away), []);
  // Built for t01, then the selection's images change under it: another image's tree is refused, never replaced.
  const b = await bench();
  assert.equal(await pull(cliDeps(b, [], docker()) as never, 'smoke', pins(b)), 0);
  const rec = join(treesDir(b.layout), 't01', 'tree.json');
  const before = readFileSync(rec, 'utf8');
  const map = Object.fromEntries(ORDER.slice(0, 50).map((id) => [id, refOf(id)]));
  writeImagesFile(b.layout, { ...map, [ORDER[0]!]: `${nameOf(ORDER[0]!)}@${OTHERS[7]}` });
  const out2: string[] = [];
  const d2 = docker();
  assert.equal(await pull(cliDeps(b, out2, d2) as never, 'smoke', pins(b)), 1);
  assert.match(out2.join('\n'), /FAIL +t01 +.*another/);
  assert.doesNotMatch(out2.join('\n'), TASKISH);
  assert.equal(readFileSync(rec, 'utf8'), before, 'left as it is');
  assert.equal(verbs(d2, 'run').length, 0);
  // A record that doesn't match its own repo: refused.
  writeImagesFile(b.layout, map);
  const f = join(treesDir(b.layout), 't02', 'tree.json');
  writeFileSync(f, `${JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), tree: OTHER_TREE.tree })}\n`);
  const out3: string[] = [];
  assert.equal(await pull(cliDeps(b, out3, docker()) as never, 'smoke', pins(b)), 1);
  assert.match(out3.join('\n'), /FAIL +t02 /);
  assert.match(out3.join('\n'), /PASS +t01 +base tree.*kept/, 't01 still checks out');
});

test("the container's own scripts, run by sh on a stand-in /testbed: HEAD and tree, exactly that tree's objects, the content path, and /testbed untouched", linux, async () => {
  const { CONTAINER_SCRIPTS } = await import('../scripts/bench/pull.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pull-sh-')));
  const work = join(root, 'work');
  mkdirSync(work);
  const at = (testbed: string) => (s: string) => s.split('/work').join(work).split('/testbed').join(testbed);
  const sh = (testbed: string, script: string, ...args: string[]) => execFileSync('sh', ['-c', at(testbed)(script), 'sh', ...args], { env: GIT_ENV, maxBuffer: 1 << 26 }).toString();
  /** Every path under `d` with its size and mtime: what must not change. */
  const snapshot = (d: string): string[] => {
    const out: string[] = [];
    const walk = (p: string) => {
      const s = lstatSync(p);
      out.push(`${p} ${s.size} ${s.mtimeMs}`);
      if (s.isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f));
    };
    walk(d);
    return out;
  };
  // With git metadata: HEAD and its tree, then a pack of exactly that tree.
  const testbed = join(root, 'testbed');
  git(['init', '-q', '--template=', testbed]);
  mkdirSync(join(testbed, 'pkg'));
  writeFileSync(join(testbed, 'pkg', 'a.py'), 'old = 1\n');
  git(['-C', testbed, 'add', '-A']);
  git(['-C', testbed, 'commit', '-q', '-m', 'history']);
  const oldBlob = git(['-C', testbed, 'rev-parse', 'HEAD:pkg/a.py']);
  writeFileSync(join(testbed, 'pkg', 'a.py'), 'new = 2\n');
  writeFileSync(join(testbed, 'setup.py'), 'setup()\n');
  git(['-C', testbed, 'add', '-A']);
  git(['-C', testbed, 'commit', '-q', '-m', 'base']);
  // A change in the work tree (as an image's setup may make): not what is copied, never touched.
  writeFileSync(join(testbed, 'setup.py'), 'setup(changed=True)\n');
  const [head, tree] = [git(['-C', testbed, 'rev-parse', 'HEAD']), git(['-C', testbed, 'rev-parse', 'HEAD^{tree}'])];
  const before = snapshot(testbed);
  assert.equal(sh(testbed, CONTAINER_SCRIPTS.probe), `git\n${head}\n${tree}\n`);
  const packed = Buffer.from(sh(testbed, CONTAINER_SCRIPTS.pack, head, tree), 'base64');
  const parent = git(['-C', testbed, 'rev-parse', 'HEAD~1']);
  const bare = join(root, 'bare.git');
  git(['init', '--bare', '-q', '--template=', bare]);
  execFileSync('git', ['--git-dir', bare, 'index-pack', '--stdin'], { env: GIT_ENV, input: packed });
  assert.equal(gitIn(bare, ['cat-file', '-t', head]), 'commit', 'the commit object itself, so its hash binds the tree');
  assert.equal(gitIn(bare, ['rev-parse', `${head}^{tree}`]), tree);
  assert.equal(gitIn(bare, ['show', `${tree}:setup.py`]), 'setup()', "the tree at HEAD, not the work tree's change");
  assert.throws(() => gitIn(bare, ['cat-file', '-e', oldBlob]), 'no history: an older blob is not in the pack');
  assert.throws(() => gitIn(bare, ['cat-file', '-e', parent]), 'no parent commit');
  // No git metadata: the probe says none, and the content path gives the files' tree id and a pack of it.
  const plain = join(root, 'plain');
  mkdirSync(join(plain, 'pkg'), { recursive: true });
  writeFileSync(join(plain, 'pkg', 'a.py'), 'new = 2\n');
  writeFileSync(join(plain, 'setup.py'), 'setup()\n');
  writeFileSync(join(plain, '.gitignore'), 'build/\n');
  mkdirSync(join(plain, 'build'));
  writeFileSync(join(plain, 'build', 'out.so'), 'binary\n');
  const plainBefore = snapshot(plain);
  assert.equal(sh(plain, CONTAINER_SCRIPTS.probe), 'none\n');
  const out = sh(plain, CONTAINER_SCRIPTS.content);
  const nl = out.indexOf('\n');
  const ctree = out.slice(0, nl);
  assert.match(ctree, /^[0-9a-f]{40}$/);
  const cbare = join(root, 'content.git');
  git(['init', '--bare', '-q', '--template=', cbare]);
  execFileSync('git', ['--git-dir', cbare, 'index-pack', '--stdin'], { env: GIT_ENV, input: Buffer.from(out.slice(nl + 1), 'base64') });
  assert.deepEqual(gitIn(cbare, ['ls-tree', '-r', '--name-only', ctree]).split('\n'), ['.gitignore', 'build/out.so', 'pkg/a.py', 'setup.py'], 'every file, ignored ones too');
  // Neither stand-in /testbed was changed by any of it.
  assert.deepEqual(snapshot(testbed), before);
  assert.deepEqual(snapshot(plain), plainBefore);
});

// ---- The README ----

const README = () => readFileSync(join(repoRoot, 'scripts', 'bench', 'README.md'), 'utf8');
/** The commands of the README's setup step `n`, as the owner pastes them (its indented lines), as bench-cli.test.ts reads them. */
function stepBlock(n: number): string {
  const text = README();
  const at = text.indexOf(`### ${n}.`);
  assert.ok(at >= 0, `the README has a step ${n}`);
  const next = text.indexOf('\n#', at + 1);
  return text
    .slice(at, next < 0 ? undefined : next)
    .split('\n')
    .filter((l) => l.startsWith('    '))
    .map((l) => l.slice(4))
    .join('\n');
}

test("the README's owner steps hold exactly each setup step's commands, steps 1 to 10 in order, and step 10 pastes as it stands", linux, () => {
  const text = README();
  const at = text.indexOf("## The owner's steps, in order");
  assert.ok(at >= 0, 'the README has the owner steps');
  const end = text.indexOf('\n## ', at + 1);
  const parts = text.slice(at, end < 0 ? undefined : end).split(/\n(?=\*\*[A-Z]\. )/).slice(1);
  const seen: number[] = [];
  for (const p of parts) {
    const head = p.split('\n')[0]!;
    const block = p.split('\n').filter((l) => l.startsWith('    ')).map((l) => l.slice(4)).join('\n');
    const m = /\(setup step (\d+)\)/.exec(head);
    if (!m) {
      assert.equal(block, '', `${head.slice(0, 40)}: no commands without a setup step`);
      continue;
    }
    seen.push(Number(m[1]));
    assert.equal(block, stepBlock(Number(m[1])), `${head.slice(0, 40)}: exactly setup step ${m[1]}'s commands`);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(stepBlock(10), 'bench pull --tasks smoke');
  const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-n', '-c', stepBlock(10)], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('no task id, image name or tree hash leaks into what bench pull prints, on success or on any refusal', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const all: string[] = [];
  const scenarios: Parameters<typeof docker>[0][] = [
    {},
    { readBack: () => `${nameOf(ORDER[0]!)}@${OTHERS[1]}` },
    { pull: (ref) => ({ status: 1, stdout: ref, stderr: ref }) },
    { head: () => '0'.repeat(40) },
    { probe: (id) => ({ status: 1, stdout: id, stderr: nameOf(id) }) },
    { pack: (id) => ({ status: 1, stdout: id, stderr: nameOf(id) }) },
    { noGit: () => true },
  ];
  for (const s of scenarios) {
    const b = await bench();
    const out: string[] = [];
    await pull(cliDeps(b, out, docker(s)) as never, 'smoke', () => parsePins(b.pinsText));
    all.push(...out);
  }
  const text = all.join('\n');
  assert.doesNotMatch(text, TASKISH);
  for (const id of IDS) assert.ok(!text.includes(id) && !text.includes(digestOf(id)), 'no id, and no digest beside a key');
  assert.ok(!text.includes(TREE.tree));
});
