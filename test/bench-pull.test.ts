// The rest of the bench's task setup (#748, slice 4): `bench pull --tasks smoke|baseline` pulls each selected task's
// image by its pinned digest only (never a tag) and reads the digest back, then copies each task's base tree out of
// its image's /testbed, through the bench's own container runner, into the held-out store: a bare remote with one
// commit (no upstream history) and a clone of it. Stand-ins only (test/bench-pull-fixtures.ts): fixture rows with
// synthetic ids (example__proj-NNNN), a temp bench root, a stand-in docker (no daemon, no image, no network), no model,
// no real store. Host git builds the fixture pack and the store's repos, in temp folders only, with no config of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseOf, bench, cliDeps, digestOf, docker, git, GIT_ENV, gitIn, IDS, keyOf, nameOf, ORDER, OTHER_TREE, OTHERS, pinsMod, refOf, sha256, TASKISH, TREE, treesDir, verbs, writeImagesFile, type Bench } from './bench-pull-fixtures.js';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import { repoRoot } from './helpers.js';

const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: loaded when a test runs, not at the top, so each test fails on its own on code from before this change (the
// fail-without run).
const cli = () => import('../scripts/bench/cli.js');

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
  const { BENCH_USER_ENV } = await import('../scripts/bench/auth.js');
  assert.equal(await pull(cliDeps(b, other, d1, { env: { PATH: '/nonexistent', HOME: b.home, [BENCH_USER_ENV]: 'someone-else' } }) as never, 'smoke', pins), 1);
  assert.match(other.join('\n'), /FAIL/);
  assert.equal(d1.calls.length, 0);
  const { chmodSync } = await import('node:fs');
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
  // A record of a tree that was never bound to base_commit (an older build's content mode): refused, left as it is.
  const g = join(treesDir(b.layout), 't03', 'tree.json');
  const g0 = readFileSync(g, 'utf8');
  writeFileSync(g, `${JSON.stringify({ ...JSON.parse(g0), source: 'content', head_checked: false })}\n`);
  writeFileSync(f, `${JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), tree: TREE.tree })}\n`);
  const out4: string[] = [];
  assert.equal(await pull(cliDeps(b, out4, docker()) as never, 'smoke', pins(b)), 1);
  assert.match(out4.join('\n'), /FAIL +t03 +.*bound to base_commit/);
});

test("the container's own scripts, run by sh on a stand-in /testbed: HEAD and tree, exactly that tree's objects, and /testbed untouched", linux, async () => {
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
  assert.deepEqual(snapshot(testbed), before, '/testbed unchanged');
  // No git metadata: the probe says none (and the pull refuses it: test/bench-pull-bounds.test.ts).
  const plain = join(root, 'plain');
  mkdirSync(plain);
  writeFileSync(join(plain, 'setup.py'), 'setup()\n');
  assert.equal(sh(plain, CONTAINER_SCRIPTS.probe), 'none\n');
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
