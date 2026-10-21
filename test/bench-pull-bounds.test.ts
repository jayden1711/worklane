// `bench pull`'s bounds (#748, slice 4, review round 2): what comes out of a task's container is capped in bytes, and
// what the copied tree decodes to is capped before anything is checked out; an image with no git metadata in /testbed
// is refused (no binding to base_commit); a task image that isn't a digest reference never reaches `docker run`; and the
// agents' lane denies the system journal, where the bench user's dockerd may log image names. Stand-ins only: the
// fixtures of test/bench-pull-fixtures.ts, a stand-in docker CLI (a temp shell script for the real async path), no
// daemon, no image, no network, no model, no real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bench, cliDeps, docker, gitIn, pinsMod, TASKISH, treePack, treesDir, uid, verbs, type Sent } from './bench-pull-fixtures.js';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import { repoRoot } from './helpers.js';

const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: loaded when a test runs, not at the top, so each test fails on its own on code from before this change.
const cli = () => import('../scripts/bench/cli.js');

const ok = (stdout: string): Sent => ({ status: 0, stdout, stderr: '' });
const MiB = 1024 * 1024;
/** A blob of zeros: a tiny pack that decodes to many bytes. */
const BOMB = treePack({ 'big.bin': Buffer.alloc(4 * MiB) });

test("a copy-out past its byte cap is refused, nothing kept, and the task's container removed", linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  for (const [cap, stdout, why] of [
    [64, undefined, 'the real pack, over a 64-byte cap'],
    [MiB, 'A'.repeat(4 * MiB), '4 MiB over a 1 MiB cap'],
  ] as const) {
    const b = await bench();
    const out: string[] = [];
    const d = docker(stdout ? { pack: () => ok(stdout) } : {});
    assert.equal(await (pull as (...a: unknown[]) => Promise<number>)(cliDeps(b, out, d), 'smoke', () => parsePins(b.pinsText), { copyOutBytes: cap, treeBytes: 1024 * MiB }), 1, why);
    const text = out.join('\n');
    assert.match(text, new RegExp(`FAIL +t01 +.*over ${cap} bytes`), why);
    assert.doesNotMatch(text, TASKISH, why);
    assert.deepEqual(readdirSync(treesDir(b.layout)), [], `${why}: nothing kept`);
    assert.deepEqual(new Set(verbs(d, 'rm').map((a) => a[2])), new Set(d.containers.keys()), `${why}: its container removed`);
  }
});

test('TaskRunner.exec with a byte cap ends a docker that prints past it and refuses, without taking it all', linux, async () => {
  const { TaskRunner } = await import('../scripts/bench/container.js');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pull-fake-docker-')));
  const fake = join(dir, 'docker');
  // A stand-in docker CLI: 64 MiB of zeros on stdout, whatever it is asked.
  writeFileSync(fake, '#!/bin/sh\nexec /usr/bin/head -c 67108864 /dev/zero\n');
  chmodSync(fake, 0o755);
  const row = { instance_id: 'example__proj-1', repo: 'example/proj', base_commit: '0'.repeat(40), problem_statement: 'p', patch: '', test_patch: '', FAIL_TO_PASS: '[]', PASS_TO_PASS: '[]', hints_text: '', difficulty: '' };
  const run = new TaskRunner({ docker: fake, env: { PATH: '/nonexistent', DOCKER_HOST: 'unix:///nonexistent/docker.sock' } }, { name: 'bench-pull-test-t01', image: `example/img@sha256:${'0'.repeat(64)}` }, row, Buffer.alloc(0));
  const exec = run.exec.bind(run) as (...a: unknown[]) => Promise<Sent>;
  await assert.rejects(exec('/work', ['true'], {}, 60_000, undefined, MiB), /over 1048576 bytes/);
});

test('a small pack that decodes past the tree cap is refused before any checkout, nothing kept', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const run = async (treeBytes: number) => {
    const b = await bench({ base: BOMB.commit });
    const out: string[] = [];
    const d = docker({ head: () => BOMB.commit, tree: BOMB.tree, pack: () => ok(BOMB.b64) });
    const code = await (pull as (...a: unknown[]) => Promise<number>)(cliDeps(b, out, d), 'smoke', () => parsePins(b.pinsText), { copyOutBytes: 64 * MiB, treeBytes });
    return { b, out: out.join('\n'), code, d };
  };
  assert.ok(BOMB.b64.length < 64 * 1024, 'the pack is small');
  const capped = await run(MiB);
  assert.equal(capped.code, 1, capped.out);
  assert.match(capped.out, /FAIL +t01 +.*decode.*over 1048576 bytes/);
  assert.doesNotMatch(capped.out, TASKISH);
  assert.deepEqual(readdirSync(treesDir(capped.b.layout)), [], 'nothing kept, no temporary folder left');
  // Under a cap it fits, the same pack is taken: the cap is what refused it.
  const fits = await run(64 * MiB);
  assert.equal(fits.code, 0, fits.out);
  assert.equal(gitIn(join(treesDir(fits.b.layout), 't01', 'remote.git'), ['rev-parse', 'main^{tree}']), BOMB.tree);
});

test('an image with no git metadata in /testbed is refused by default: nothing binds its tree to base_commit', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const out: string[] = [];
  const d = docker({ noGit: () => true });
  assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1);
  const text = out.join('\n');
  assert.match(text, /FAIL +t01 +.*no git metadata/);
  assert.doesNotMatch(text, /PASS +t01/);
  assert.deepEqual(readdirSync(treesDir(b.layout)), [], 'nothing kept');
  assert.equal(d.calls.filter((a) => a[0] === 'exec' && (a[a.indexOf('-c') + 1] ?? '').includes('write-tree')).length, 0, 'its content is never copied out');
  assert.deepEqual(new Set(verbs(d, 'rm').map((a) => a[2])), new Set(d.containers.keys()), 'its container removed');
});

test("a task image that isn't a digest reference never reaches docker run", linux, async () => {
  const { parsePins } = await pinsMod();
  const { loadTasks } = await import('../scripts/bench/select.js');
  const { Docker } = await import('../scripts/bench/container.js');
  const { baseTree } = await import('../scripts/bench/pull.js');
  const b = await bench();
  const [t] = loadTasks(b.layout, uid, parsePins(b.pinsText), 'smoke');
  const d = docker();
  const o = { docker: '/nonexistent/docker', call: d.call, env: { PATH: '/nonexistent', DOCKER_HOST: 'unix:///nonexistent/docker.sock' } };
  const dk = new Docker(o, { memoryBytes: 8 * 1024 ** 3, cpus: 4, pids: 4096 });
  for (const image of [`${t!.ref.name}:latest`, t!.ref.name, `${t!.ref.name}:latest@${t!.ref.digest}`]) {
    await assert.rejects(baseTree(b.layout, uid, { ...t!, image }, o, dk), /digest/, image.replace(/.*\//, ''));
  }
  assert.equal(verbs(d, 'run').length, 0);
});

test("the agents' lane denies the system journal, where the bench user's dockerd may log the task images", linux, async () => {
  const { benchDenied, benchLane } = await import('../scripts/bench/agent.js');
  const o = { home: '/home/u', runtimeDir: '/run/user/1001', heldOut: '/h', state: '/s', dockerHost: undefined, dataHome: undefined };
  for (const p of ['/var/log/journal', '/run/log/journal']) {
    assert.ok(benchDenied(o).includes(p), p);
    assert.ok(benchLane(o).settings.sandbox.filesystem.denyRead.includes(p), `commands denied ${p}`);
  }
});

test("the README: step 10 refuses an image with no git metadata, and its log hint keeps the daemon's output off disk", linux, () => {
  const text = readFileSync(join(repoRoot, 'scripts', 'bench', 'README.md'), 'utf8');
  assert.doesNotMatch(text, /content hash is recorded instead/);
  assert.match(text, /\/var\/log\/journal/);
  assert.match(text, /never (save|copy)[^.]*journal|journal[^.]*never (save|copy)/i);
});
