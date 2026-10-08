import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { claimRef } from '../src/claims.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A "GitHub" remote, the coordinator's clone of the example project, a file backlog and a log. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'coord-'));
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
  const repo = join(base, 'coordinator-clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test';
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  return { base, remote, repo, cfg, backlog, log, slotsDir, stateDir: join(base, 'state') };
}

const BUG = 'Orders with a zero or negative quantity are counted in totals.\n\n```done_when\n- test: test/price.test.js\n- repro: true\n```\n';
const REPRO = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('ignores non-positive quantities', () => { assert.equal(totalCents([{ cents: 100, qty: -2 }, { cents: 5, qty: 1 }]), 5); });\n`;

function commitAll(cwd: string, msg: string) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=agent@example.com', '-c', 'user.name=agent', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}

/** Scripted agents: the evaluator writes a failing repro; the worker fixes the bug; the verdict approves. */
function agents(over: Partial<Record<string, (r: RunRequest) => object>> = {}) {
  return new FakeRunner((req) => {
    const custom = over[req.role];
    if (custom) return { structured: custom(req) };
    if (req.role === 'evaluator-repro') {
      writeFileSync(join(req.cwd, 'test', 'repro-qty.test.js'), REPRO);
      commitAll(req.cwd, 'repro');
      return { structured: { test_path: 'test/repro-qty.test.js', explanation: 'negative qty subtracts' } };
    }
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      commitAll(req.cwd, 'Ignore non-positive quantities in totals');
      return { structured: { summary: 'fixed', lesson: { worked: 'repro first', failed: '', fix: '' } } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '' } };
  });
}

const types = (log: EventLog) => log.read().map((e) => e.type).filter((t) => !t.startsWith('coordinator.'));

test('end to end: a writer files an issue; it is reproduced, fixed, verified, evaluated, landed and closed', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir });
  await c.tick();
  await c.idle();
  await c.tick(); // lands
  const t = types(f.log);
  for (const want of ['issue.claimed', 'repro.frozen', 'run.started', 'run.finished', 'change.proposed', 'check.result', 'eval.verdict', 'review.level_set', 'land.queued', 'land.result', 'issue.released']) {
    assert.ok(t.includes(want as never), `${want} in ${t.join(', ')}`);
  }
  const landed = f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string; landed: string };
  assert.equal(landed.outcome, 'landed');
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], landed.landed, 'remote main is the landed, tested sha');
  const onMain = git(f.repo, 'show', `${landed.landed}:src/price.js`);
  assert.match(onMain, /qty > 0/);
  assert.equal(git(f.repo, 'ls-remote', 'origin', claimRef(n)), '', 'claim released');
  const issue = await f.backlog.get(n);
  assert.equal(issue.state, 'closed');
  assert.ok(!issue.labels.includes('agent:working') && !issue.labels.includes('in-review'));
  assert.ok((await f.backlog.comments(n)).some((x) => /Landed/.test(x.body)));
  assert.equal(git(f.repo, 'worktree', 'list').split('\n').length, 1, 'all worktrees removed');
  assert.deepEqual(runner.calls.map((r) => r.role), ['evaluator-repro', 'worker', 'evaluator-verdict']);
  const level = f.log.read(0, ['review.level_set']).at(-1)!.payload as { level: string };
  assert.equal(level.level, 'L1');
  const cost = f.log.read(0, ['run.cost']).length;
  assert.equal(cost, 3, 'every run records its cost');
});

test('the worker sees the frozen repro; editing it gets the attempt rejected and retried', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  let attempt = 0;
  const runner = agents({
    worker: (req) => {
      attempt++;
      assert.match(req.prompt, /Frozen reproduction test.*test\/repro-qty\.test\.js/);
      if (attempt === 1) {
        writeFileSync(join(req.cwd, 'test', 'repro-qty.test.js'), "import { test } from 'node:test';\ntest('x', () => {});\n");
        commitAll(req.cwd, 'weaken the test');
      } else {
        assert.match(req.prompt, /modified the frozen reproduction test/);
        git(req.cwd, 'checkout', 'HEAD~1', '--', 'test/repro-qty.test.js');
        const p = join(req.cwd, 'src', 'price.js');
        writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
        commitAll(req.cwd, 'real fix');
      }
      return { summary: 's', lesson: { worked: '', failed: '', fix: '' } };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir });
  await c.tick();
  await c.idle();
  assert.equal(attempt, 2);
  assert.ok(f.log.read(0, ['change.rejected']).some((e) => /frozen reproduction test/.test((e.payload as { why: string }).why)));
  assert.ok(f.log.read(0, ['land.queued']).length === 1);
});

test('a high-risk change waits for the owner; a writer\'s /approve comment releases it to land', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Add an orders table', body: 'Add the orders migration.\n\n```done_when\n- command: node --test\n```\n', author: 'example-owner', labels: ['ready'] });
  const runner = agents({
    worker: (req) => {
      mkdirSync(join(req.cwd, 'migrations'), { recursive: true });
      writeFileSync(join(req.cwd, 'migrations', '001_orders.sql'), 'CREATE TABLE orders (id int);\n');
      commitAll(req.cwd, 'orders migration');
      return { summary: 's', lesson: { worked: '', failed: '', fix: '' } };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir });
  await c.tick();
  await c.idle();
  await c.tick();
  assert.equal((f.log.read(0, ['review.level_set']).at(-1)!.payload as { level: string }).level, 'L3');
  assert.equal(f.log.read(0, ['land.result']).length, 0, 'nothing lands without approval');
  assert.ok((await f.backlog.get(n)).labels.includes('needs:decision'));
  f.backlog.humanComment(n, 'stranger', '/worklane approve');
  await c.tick();
  assert.equal(f.log.read(0, ['land.result']).length, 0, 'a non-writer cannot approve');
  f.backlog.humanComment(n, 'example-owner', 'looks right\n/worklane approve');
  await c.tick(); // records the answer and queues landing
  await c.tick(); // lands
  assert.equal((f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string }).outcome, 'landed');
  assert.equal((await f.backlog.get(n)).state, 'closed');
});

test('issues without a contract, or from outsiders, are never started', { skip }, async () => {
  const f = fixture();
  const noContract = f.backlog.open({ title: 'vague', body: 'make it better', author: 'example-owner', labels: ['ready'] });
  f.backlog.open({ title: 'outsider', body: BUG, author: 'stranger', labels: ['ready'] });
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir });
  await c.tick();
  await c.idle();
  assert.equal(runner.calls.length, 0);
  assert.ok((await f.backlog.comments(noContract)).some((x) => /no contract, no build/.test(x.body)));
});

test('two coordinators on one repo: only one claims the issue', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const other = join(f.base, 'bob-clone');
  git(f.base, 'clone', '-q', f.remote, other);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const slow = agents({
    'evaluator-repro': () => ({ not_reproducible: 'skip for this test' }),
    worker: () => {
      throw new Error('unused');
    },
  });
  const blocking = new FakeRunner(async (req) => {
    await gate;
    return slow.run(req);
  });
  const alice = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: blocking, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir });
  const bobLog = new EventLog(join(f.base, 'bob.db'));
  const bob = new Coordinator({ cfg: loadConfig(other), log: bobLog, backlog: f.backlog, runner: agents(), repo: other, instance: 'bob', stateDir: join(f.base, 'bob-state'), slotsDir: f.slotsDir });
  await alice.tick(); // alice claims and is now busy in the repro run
  await new Promise((r) => setTimeout(r, 200));
  // Bob's tick sees the issue no longer ready (alice moved it), and even if it were, the claim ref would refuse him.
  await bob.tick();
  await bob.idle();
  assert.equal(bobLog.read(0, ['issue.claimed']).length, 0);
  release();
  await alice.idle();
});

test('after a restart mid-task, the task is requeued rather than left stuck', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const crashing = new FakeRunner(() => {
    throw new Error('simulated crash');
  });
  const c1 = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: crashing, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir });
  await c1.tick();
  await c1.idle();
  // A fresh process: same log, same repo.
  const c2 = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir });
  assert.deepEqual(await c2.recover(), [n]);
  assert.ok((await f.backlog.get(n)).labels.includes('ready'));
  await c2.tick();
  await c2.idle();
  await c2.tick();
  assert.equal((await f.backlog.get(n)).state, 'closed');
  assert.ok(!existsSync(join(f.repo, '.claude', 'worktrees', 'worklane-issue-1')));
});
