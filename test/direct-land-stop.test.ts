import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopFilePath } from '../src/auto-merge-stop.js';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// #808: the auto-merge stop holds direct landing too. A stop left from PR mode (its file, or a logged stop whose file
// was deleted by hand) survives a switch to land_mode direct, and an approved direct land waits; it never lands.

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The example project with a bare remote, in direct mode, with review levels that land the change at once. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'direct-stop-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  // Switched to direct after PR mode (the stop below is what PR mode left).
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } } });
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir };
}

const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';

/** A worker that makes a real fix; an evaluator that approves it. */
const runner = () =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: 'looks right', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: ['src/price.js'], design_change: false } };
  });

async function run(stop: (f: ReturnType<typeof fixture>) => void) {
  return runWith(stop, { autoMerge: () => true });
}

/**
 * The same, with the instance policy's auto-merge switch as `o.autoMerge` (absent: off), and with `o.l3` the change
 * raised to L3 so the owner is asked, then (`o.approve`) answers approve.
 */
async function runWith(stop: (f: ReturnType<typeof fixture>) => void, o: { autoMerge?: () => boolean; l3?: boolean; approve?: boolean }) {
  const f = fixture();
  if (o.l3) f.cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: ['app-non-money'] } } });
  stop(f);
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const mainBefore = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) }, ...(o.autoMerge ? { autoMerge: o.autoMerge } : {}) });
  for (let i = 0; i < 3; i++) {
    await c.tick();
    await c.idle();
    const asked = f.log.read(0, ['decision.asked']).at(-1)?.payload as { id: string } | undefined;
    if (o.approve && asked && !f.log.read(0, ['decision.answered']).length) f.log.append('decision.answered', { id: asked.id, by: 'example-owner', answer: 'approve', role: 'owner' }, 'alice');
  }
  const mainAfter = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  const landed = f.log.read(0, ['land.result']).filter((e) => (e.payload as { outcome: string }).outcome === 'landed');
  return { f, mainBefore, mainAfter, landed, queued: f.log.read(0, ['land.queued']).length };
}

test('direct mode (#808): a stop file left from PR mode holds an approved land: queued, never pushed', { skip }, async () => {
  const r = await run((f) => writeFileSync(stopFilePath(f.stateDir), JSON.stringify({ reason: 'main went red after #12 (set in PR mode)' })));
  assert.equal(r.queued, 1, 'the change was approved and queued');
  assert.equal(r.landed.length, 0, 'never landed');
  assert.equal(r.mainAfter, r.mainBefore, 'main untouched');
});

test('direct mode (#808): a logged stop from a red main whose file was deleted by hand holds it too', { skip }, async () => {
  const r = await run((f) => f.log.append('merge.stopped', { reason: 'main went red after #12', number: null, sha: null, revert: null, by: 'red_main' }, 'alice'));
  assert.equal(r.queued, 1);
  assert.equal(r.landed.length, 0, 'never landed');
  assert.equal(r.mainAfter, r.mainBefore, 'main untouched');
});

test('direct mode, control: with no stop the same approved change lands', { skip }, async () => {
  const r = await run(() => {});
  assert.equal(r.landed.length, 1, 'landed');
  assert.notEqual(r.mainAfter, r.mainBefore, 'main moved');
});

// The owner's (c), 2026-11-07: policy.yaml auto_merge off stops automatic direct landing (L0 to L2) only; an L3 the
// owner approved still lands.
test("direct mode (#808 (c)): with the policy's auto-merge off, an automatic land (below L3) waits queued, never pushed", { skip }, async () => {
  for (const [what, autoMerge] of [['off', () => false], ['unreadable', () => { throw new Error('policy.yaml unreadable'); }]] as const) {
    const r = await runWith(() => {}, { autoMerge });
    assert.equal(r.queued, 1, `${what}: queued`);
    assert.equal(r.landed.length, 0, `${what}: never landed`);
    assert.equal(r.mainAfter, r.mainBefore, `${what}: main untouched`);
  }
});

test('direct mode (#808 (c)), control: a local site, with no instance policy and so no switch, lands as before', { skip }, async () => {
  const r = await runWith(() => {}, {});
  assert.equal(r.landed.length, 1, 'landed');
  assert.notEqual(r.mainAfter, r.mainBefore, 'main moved');
});

test("direct mode (#808 (c)): with the policy's auto-merge off, an L3 the owner approved still lands", { skip }, async () => {
  const r = await runWith(() => {}, { autoMerge: () => false, l3: true, approve: true });
  assert.equal(r.f.log.read(0, ['decision.answered']).length, 1, 'the owner answered');
  assert.equal(r.landed.length, 1, 'landed');
  assert.notEqual(r.mainAfter, r.mainBefore, 'main moved');
});
