import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { FileBacklog } from '../src/backlog/file.js';
import { BRAND } from '../src/brand.js';
import { TestsConfig } from '../src/config/schema.js';
import { peakMemoryMb, withPeakMemory } from '../src/os/index.js';
import { DEFAULT_PUSH_LIMITS } from '../src/push-check.js';
import { applyTuning, profileCounts, settingsFor, tune, workerSetting, type SuiteRunner } from '../src/tune.js';

const tests = (env: Record<string, string>, runner = { kind: 'command' as const, changed: 'make test-fast', full: 'make test-full' }) => TestsConfig.parse({ version: 1, runner, env });

test('the worker setting to vary: a {cores} template, else a numeric worker variable, else none', () => {
  assert.deepEqual(workerSetting(tests({ XDIST_AUTO_NUM_WORKERS: '6', OTHER: '1' })), { kind: 'var', name: 'XDIST_AUTO_NUM_WORKERS', value: 6 });
  assert.deepEqual(workerSetting(tests({ WORKERS: '{cores}' })), { kind: 'template' });
  assert.deepEqual(workerSetting(tests({}, { kind: 'command', changed: 'npm test -- --maxWorkers={cores}', full: 'npm test' })), { kind: 'template' });
  assert.equal(workerSetting(tests({ SIM_REALTIME: '1' })), null, 'a number that is not a worker count is left alone');
});

test('worker counts to try, and how each run sets them', () => {
  assert.deepEqual(profileCounts(16), [1, 2, 4, 16]);
  assert.deepEqual(profileCounts(4), [1, 2, 4]);
  assert.deepEqual(profileCounts(1), [1]);
  assert.deepEqual(settingsFor({ kind: 'var', name: 'W', value: 6 }, { W: '6', X: 'a' }, 'make t', 4), { env: { W: '4', X: 'a' }, command: 'make t' });
  assert.deepEqual(settingsFor({ kind: 'template' }, { W: '{cores}' }, 'make -j{cores}', 2), { env: { W: '2' }, command: 'make -j2' });
});

test('the recommendation lands in tests.yaml with its comments kept, and still parses', () => {
  const before = 'version: 1  # tests\nrunner:\n  kind: command\n  changed: make test-fast   # the fast tier\n  full: make test-full\nenv:\n  XDIST_AUTO_NUM_WORKERS: "6"   # fixed for now\n';
  const after = applyTuning(before, 4, { kind: 'var', name: 'XDIST_AUTO_NUM_WORKERS', value: 6 });
  assert.match(after, /# the fast tier/);
  assert.match(after, /# fixed for now/);
  const t = TestsConfig.parse(parse(after));
  assert.equal(t.env.XDIST_AUTO_NUM_WORKERS, '{cores}');
  assert.deepEqual(t.cores, { reserve: 0, min: 1, max: 4 });
});

test('peak memory is recorded on Linux through GNU time, and reads as MB', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'peak-')), 'peak');
  const wrapped = withPeakMemory("echo 'hi'", out);
  if (process.platform === 'linux' && existsSync('/usr/bin/time')) assert.equal(wrapped, `/usr/bin/time -f %M -o '${out}' sh -c 'echo '\\''hi'\\'''`);
  else assert.equal(wrapped, "echo 'hi'", 'elsewhere the command is unchanged');
  writeFileSync(out, '20480\n');
  assert.equal(peakMemoryMb(out), 20);
  assert.equal(peakMemoryMb(join(out, 'missing')), null);
});

function project() {
  const remote = mkdtempSync(join(tmpdir(), 'remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'user.name', 'Ada');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, BRAND.configDir));
  writeFileSync(join(dir, BRAND.configDir, 'tests.yaml'), 'version: 1\nrunner:\n  kind: command\n  changed: make test-fast\n  full: make test-full\nenv:\n  XDIST_AUTO_NUM_WORKERS: "6"   # fixed for now\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  return { dir, remote, head: git('rev-parse', 'HEAD') };
}

/** A suite that is 8x faster with 8 workers, no faster beyond, and 300 MB per worker. */
const fakeSuite = (seen: string[]): SuiteRunner => (_command, env) => {
  const w = Number(env.XDIST_AUTO_NUM_WORKERS);
  seen.push(String(w));
  return { seconds: 800 / Math.min(w, 8), ok: true, peakWorkerMb: 300 };
};

test('tune profiles the suite in a fresh worktree and opens a PR with the recommendation, through the push limits', async () => {
  const p = project();
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const backlog = new FileBacklog(join(state, 'backlog.json'));
  const seen: string[] = [];
  const cfg = tests({ XDIST_AUTO_NUM_WORKERS: '6' });
  const r = await tune({
    wt: { repo: p.dir, root: '.claude/worktrees', stateDir: state, setup: [] },
    tests: cfg,
    base: p.head,
    mainBranch: 'main',
    limits: DEFAULT_PUSH_LIMITS,
    backlog,
    identity: { name: 'harness', email: 'harness@example.com' },
    stateDir: state,
    cores: 16,
    memAvailableMb: 32000,
    run: fakeSuite(seen),
  });
  assert.deepEqual(seen, ['1', '2', '4', '16']);
  assert.equal(r.recommendation?.workers, 16, 'counts are 1, 2, 4, 16: only 16 is within 10% of the fastest');
  assert.ok(r.pr, 'a PR was opened');
  const pr = backlog.prs().find((x) => x.number === r.pr!.number)!;
  assert.match(pr.body ?? '', /\| 16 \| 100 s \| 300 MB \|/);
  // The pushed branch carries the change, by the harness's identity; main is untouched.
  const branch = pr.head;
  const show = (ref: string) => execFileSync('git', ['--git-dir', p.remote, 'show', `${ref}:${BRAND.configDir}/tests.yaml`], { encoding: 'utf8' });
  assert.match(show(branch), /XDIST_AUTO_NUM_WORKERS: "\{cores\}"/);
  assert.match(show(branch), /max: 16/);
  assert.match(show('main'), /XDIST_AUTO_NUM_WORKERS: "6"/);
  assert.equal(execFileSync('git', ['--git-dir', p.remote, 'log', '-1', '--format=%an', branch], { encoding: 'utf8' }).trim(), 'harness');
  // The profile is kept for the tuning proposals, and the worktree is gone.
  assert.equal(JSON.parse(readFileSync(join(state, 'tune-profile.json'), 'utf8')).runs.length, 4);
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: p.dir, encoding: 'utf8' }).trim().split('\n').length, 1);
});

test('tune refuses a project with no worker setting, and a dry run pushes nothing', async () => {
  const p = project();
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const base = { wt: { repo: p.dir, root: '.claude/worktrees', stateDir: state, setup: [] }, base: p.head, mainBranch: 'main', limits: DEFAULT_PUSH_LIMITS, identity: { name: 'h', email: 'h@example.com' }, stateDir: state, cores: 4, run: fakeSuite([]) };
  await assert.rejects(tune({ ...base, tests: tests({}) }), /no test worker setting to tune/);
  const backlog = new FileBacklog(join(state, 'backlog.json'));
  const r = await tune({ ...base, tests: tests({ XDIST_AUTO_NUM_WORKERS: '6' }), backlog, dryRun: true });
  assert.equal(r.changed, true);
  assert.equal(r.pr, undefined);
  assert.equal(backlog.prs().length, 0);
  assert.equal(execFileSync('git', ['--git-dir', p.remote, 'branch', '--list'], { encoding: 'utf8' }).trim(), '* main');
});
