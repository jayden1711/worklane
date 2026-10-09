import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { BRAND } from '../src/brand.js';
import { claimRef } from '../src/claims.js';
import { slotStatus } from '../src/slots.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { childEnv, which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A "GitHub" remote, the coordinator's clone of the example project, a file backlog and a log. */
function fixture(opts: { redMain?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'coord-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  // A main that is already red, the common real-world case.
  if (opts.redMain) writeFileSync(join(seed, 'test', 'known-red.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('legacy flake', () => { assert.equal(1, 2); });\n");
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
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  // Deterministic machine readings: the governor shouldn't depend on the CI runner's disk or load.
  const machine = { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) };
  return { base, remote, repo, cfg, backlog, log, slotsDir, stateDir: join(base, 'state'), machine };
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
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
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
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
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
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
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
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.equal(runner.calls.length, 0);
  assert.ok((await f.backlog.comments(noContract)).some((x) => /no contract, no build/.test(x.body)));
  // Regression: unchanged issues aren't re-recorded on every tick (the log would grow forever).
  const before = f.log.read(0, ['issue.seen']).length;
  for (let i = 0; i < 3; i++) await c.tick();
  assert.equal(f.log.read(0, ['issue.seen']).length, before);
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
  const alice = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: blocking, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  const bobLog = new EventLog(join(f.base, 'bob.db'));
  const bob = new Coordinator({ cfg: loadConfig(other), log: bobLog, backlog: f.backlog, runner: agents(), repo: other, instance: 'bob', stateDir: join(f.base, 'bob-state'), slotsDir: f.slotsDir, machine: f.machine });
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
  const c1 = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: crashing, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c1.tick();
  await c1.idle();
  // A fresh process: same log, same repo.
  const c2 = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  assert.deepEqual(await c2.recover(), [n]);
  assert.ok((await f.backlog.get(n)).labels.includes('ready'));
  await c2.tick();
  await c2.idle();
  await c2.tick();
  assert.equal((await f.backlog.get(n)).state, 'closed');
  assert.ok(!existsSync(join(f.repo, '.claude', 'worktrees', 'worklane-issue-1')));
});

test('main is red: a fix lands when its only failures were already on main (baseline gate)', { skip }, async () => {
  const f = fixture({ redMain: true });
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG.replace('- test: test/price.test.js', '- suite: changed'), author: 'example-owner', labels: ['ready'] });
  // Record main's baseline from a real run of the red main.
  const { recordBaseline } = await import('../src/baseline.js');
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync('node', ['--test', '--test-reporter=spec'], { cwd: f.repo, encoding: 'utf8', env: childEnv() });
  const main = git(f.repo, 'rev-parse', 'HEAD');
  assert.deepEqual(recordBaseline(f.log, 'test', main, run.status, run.stdout + run.stderr, f.cfg.tests.failures), { ok: true, failing: ['legacy flake'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  const landed = f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string };
  assert.equal(landed.outcome, 'landed');
  const gateNotes = f.log.read(0, ['check.result']).flatMap((e) => (e.payload as { checks: { check: string }[] }).checks.map((x) => x.check)).join('\n');
  assert.match(gateNotes, /no new failures; 1 already failing on main/);
  assert.equal((await f.backlog.get(n)).state, 'closed');
});

test('main is red: a change that adds a new failure does not land', { skip }, async () => {
  const f = fixture({ redMain: true });
  f.backlog.open({ title: 'Refactor totals', body: 'Refactor.\n\n```done_when\n- test: test/price.test.js\n```\n', author: 'example-owner', labels: ['ready'] });
  const { recordBaseline } = await import('../src/baseline.js');
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync('node', ['--test', '--test-reporter=spec'], { cwd: f.repo, encoding: 'utf8', env: childEnv() });
  recordBaseline(f.log, 'test', git(f.repo, 'rev-parse', 'HEAD'), run.status, run.stdout + run.stderr, f.cfg.tests.failures);
  const runner = agents({
    worker: (req) => {
      writeFileSync(join(req.cwd, 'test', 'new-red.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('brand new failure', () => { assert.equal('a', 'b'); });\n");
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8') + '\n// refactored\n');
      commitAll(req.cwd, 'refactor');
      return { summary: 's', lesson: { worked: '', failed: '', fix: '' } };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  const r = f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string; detail: string };
  assert.equal(r.outcome, 'red');
  assert.match(r.detail, /1 new failure\(s\) not in main's baseline.*brand new failure/s);
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], git(f.repo, 'rev-parse', 'origin/main'), 'main did not move');
});

test('main is red and no baseline is recorded: nothing lands', { skip }, async () => {
  const f = fixture({ redMain: true });
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  const r = f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string; detail: string };
  assert.equal(r.outcome, 'red');
  assert.match(r.detail, /no baseline recorded/);
});

test('an investigation posts findings with evidence, lands nothing, and asks the owner', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({
    title: 'Do negative quantities reach totals?',
    body: 'Read-only: confirm with evidence.\n\n```done_when\n- manual: "findings posted with code evidence"\n```\n',
    author: 'example-owner',
    labels: ['ready', 'type:investigation', 'money-path'],
  });
  const runner = agents({
    investigator: (req) => {
      writeFileSync(join(req.cwd, 'scratch.txt'), 'notes'); // a read-only run that writes anyway
      return {
        summary: 'Yes: totalCents multiplies qty without a guard.',
        findings: [{ claim: 'no qty guard', evidence: 'src/price.js:3 sum + cents * qty' }],
        recommendation: 'Fix with a qty > 0 guard and a regression test.',
        confidence: 'high',
      };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.deepEqual(runner.calls.map((r) => r.role), ['investigator']);
  assert.ok(runner.calls[0]!.disallowedTools?.includes('Edit'), 'edits are disallowed');
  const comments = (await f.backlog.comments(n)).map((x) => x.body).join('\n');
  assert.match(comments, /Investigation findings[\s\S]*src\/price\.js:3[\s\S]*Recommendation/);
  assert.match(comments, /modified files despite being read-only; those changes were discarded/);
  assert.equal(f.log.read(0, ['change.proposed', 'land.queued']).length, 0, 'nothing proposed or landed');
  assert.ok((await f.backlog.get(n)).labels.includes('needs:decision'));
  f.backlog.humanComment(n, 'example-owner', '/worklane approve-fix');
  await c.tick();
  const after = (await f.backlog.comments(n)).map((x) => x.body).join('\n');
  assert.match(after, /approved a fix\. Give the fix its own done_when contract/);
  assert.ok(!(await f.backlog.get(n)).labels.includes('ready'), 'not requeued as a code change');
});

const easyIssue = (title: string, file: string) => ({ title, body: `Add ${file}.\n\n\`\`\`done_when\n- test: test/price.test.js\n\`\`\`\n`, author: 'example-owner', labels: ['ready'] });

/** Workers that each add their own file, and record how many ran at once. */
function parallelAgents(gate: Promise<void>, seen: { now: number; max: number }) {
  return new FakeRunner(async (req) => {
    if (req.role === 'worker') {
      seen.now++;
      seen.max = Math.max(seen.max, seen.now);
      await gate;
      seen.now--;
      const name = req.prompt.match(/Add (\S+\.js)/)![1]!;
      writeFileSync(join(req.cwd, 'src', name), `export const x = '${name}';\n`);
      commitAll(req.cwd, `add ${name}`);
      return { structured: { summary: 's', lesson: { worked: '', failed: '', fix: '' } } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '' } };
  });
}

test('parallel workers: several issues build at once, each in its own worktree, and all land', { skip }, async () => {
  const f = fixture();
  for (const name of ['a.js', 'b.js', 'c.js']) f.backlog.open(easyIssue(`Add ${name}`, name));
  f.cfg.agents.roles.workers!.count = 3;
  writeFileSync(join(f.slotsDir, 'config.json'), JSON.stringify({ max_agents: 3 }));
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const seen = { now: 0, max: 0 };
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: parallelAgents(gate, seen), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick(); // one tick fills all three free workers
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(seen.max, 3, 'three workers ran at the same time');
  open();
  await c.idle();
  for (let i = 0; i < 4; i++) await c.tick();
  const landed = f.log.read(0, ['land.result']).filter((e) => (e.payload as { outcome: string }).outcome === 'landed');
  assert.equal(landed.length, 3);
  git(f.repo, 'fetch', '-q', 'origin');
  for (const name of ['a.js', 'b.js', 'c.js']) assert.match(git(f.repo, 'show', `origin/main:src/${name}`), /export const x/);
});

test('the machine-wide slot cap limits workers across harnesses, even when more are configured', { skip }, async () => {
  const f = fixture();
  for (const name of ['a.js', 'b.js', 'c.js']) f.backlog.open(easyIssue(`Add ${name}`, name));
  f.cfg.agents.roles.workers!.count = 3;
  writeFileSync(join(f.slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const seen = { now: 0, max: 0 };
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: parallelAgents(gate, seen), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(seen.max, 2);
  assert.ok(f.log.read(0, ['governor.hold']).some((e) => /agent cap/.test((e.payload as { reason: string }).reason)));
  open();
  await c.idle();
});

test('the governor holds dispatch on high load or low disk, and records it once, not every tick', { skip }, async () => {
  const f = fixture();
  f.backlog.open(easyIssue('Add a.js', 'a.js'));
  let load = 500;
  let freePct = 80;
  const runner = parallelAgents(Promise.resolve(), { now: 0, max: 0 });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: { load: () => load, disk: () => ({ freePct, totalGb: 100 }) } });
  for (let i = 0; i < 3; i++) await c.tick();
  assert.equal(runner.calls.length, 0, 'nothing starts under load');
  const holds = f.log.read(0, ['governor.hold']);
  assert.equal(holds.length, 1, 'recorded once');
  assert.match((holds[0]!.payload as { reason: string }).reason, /machine load 500 > /);
  load = 1;
  freePct = 15.5; // a 1 GB worktree on 100 GB would leave 14.5%
  await c.tick();
  assert.equal(runner.calls.length, 0);
  assert.match((f.log.read(0, ['governor.hold']).at(-1)!.payload as { reason: string }).reason, /free disk would drop to 14\.5%/);
  freePct = 80;
  await c.tick();
  await c.idle();
  assert.ok(runner.calls.length > 0, 'starts once the machine has room');
  assert.equal(f.log.read(0, ['governor.release']).length, 1);
});

/** Workers that write a given file; optionally one that also adds a failing test. */
function fileAgents(redFor?: string) {
  return new FakeRunner(async (req) => {
    if (req.role !== 'worker') return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '' } };
    const name = req.prompt.match(/Add (\S+\.js)/)![1]!;
    writeFileSync(join(req.cwd, 'src', name), `export const x = '${name}';\n`);
    if (name === redFor) writeFileSync(join(req.cwd, 'test', 'new-red.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('brand new failure', () => { assert.equal(1, 2); });\n");
    commitAll(req.cwd, `add ${name}`);
    return { structured: { summary: 's', lesson: { worked: '', failed: '', fix: '' } } };
  });
}

async function queueAll(f: ReturnType<typeof fixture>, names: string[], runner: FakeRunner) {
  for (const name of names) f.backlog.open(easyIssue(`Add ${name}`, name));
  f.cfg.agents.roles.workers!.count = names.length;
  writeFileSync(join(f.slotsDir, 'config.json'), JSON.stringify({ max_agents: names.length }));
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  // Build everything first, without landing, so the land queue sees all of them at once.
  (c as unknown as { landing: boolean }).landing = true;
  await c.tick();
  await c.idle();
  (c as unknown as { landing: boolean }).landing = false;
  assert.equal(f.log.read(0, ['land.queued']).length, names.length);
  return c;
}

const batches = (log: EventLog) => log.read(0, ['land.batch']).map((e) => e.payload as { issues: number[]; outcome: string });

test('batched landing: compatible changes are tested and landed together as one commit', { skip }, async () => {
  const f = fixture();
  const c = await queueAll(f, ['a.js', 'b.js', 'c.js'], fileAgents());
  await c.tick();
  const results = f.log.read(0, ['land.result']).map((e) => e.payload as { outcome: string; landed: string });
  assert.deepEqual(results.map((r) => r.outcome), ['landed', 'landed', 'landed']);
  assert.equal(new Set(results.map((r) => r.landed)).size, 1, 'one tested commit for the batch');
  assert.deepEqual(batches(f.log).map((b) => b.outcome), ['started', 'landed']);
});

test('batched landing: a red batch is split until the culprit is isolated; the rest land', { skip }, async () => {
  const f = fixture();
  const c = await queueAll(f, ['a.js', 'b.js', 'c.js', 'd.js'], fileAgents('c.js'));
  await c.tick();
  const byIssue = Object.fromEntries(f.log.read(0, ['land.result']).map((e) => [(e.payload as { issue: number }).issue, (e.payload as { outcome: string }).outcome]));
  const culprit = Number(Object.entries(byIssue).find(([, o]) => o === 'red')?.[0]);
  const issueTitle = (await f.backlog.get(culprit)).title;
  assert.equal(issueTitle, 'Add c.js', 'the change that added the failure is the one ejected');
  assert.equal(Object.values(byIssue).filter((o) => o === 'landed').length, 3);
  assert.ok(batches(f.log).some((b) => b.outcome === 'split'));
  assert.ok((await f.backlog.get(culprit)).labels.includes('blocked'));
  git(f.repo, 'fetch', '-q', 'origin');
  assert.throws(() => git(f.repo, 'show', 'origin/main:test/new-red.test.js'), 'the failing test never reached main');
});

test('batched landing: changes to the same files go in separate batches', { skip }, async () => {
  const f = fixture();
  // Two workers editing the same file conflict-free in sequence, but must not share a batch.
  const runner = new FakeRunner(async (req) => {
    if (req.role !== 'worker') return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '' } };
    const name = req.prompt.match(/Add (\S+\.js)/)![1]!;
    writeFileSync(join(req.cwd, 'src', 'shared.js'), `export const who = '${name}';\n`);
    commitAll(req.cwd, `touch shared for ${name}`);
    return { structured: { summary: 's', lesson: { worked: '', failed: '', fix: '' } } };
  });
  const c = await queueAll(f, ['a.js', 'b.js'], runner);
  await c.tick();
  const first = batches(f.log).filter((b) => b.outcome === 'started');
  assert.equal(first.length, 1);
  assert.deepEqual(first[0]!.issues.length, 1, 'only one of the overlapping changes in the batch');
});

test('a gate tier that needs the machine-wide full-run slot defers while another full run holds it', { skip }, async () => {
  const f = fixture();
  f.cfg.tests.gates.land = ['changed', 'full'];
  f.cfg.tests.runner.full = 'node --test --test-reporter=spec';
  const c = await queueAll(f, ['a.js'], fileAgents());
  const { fullRunLock } = await import('../src/slots.js');
  const held = await fullRunLock('another session', 1000, f.slotsDir);
  assert.ok('lock' in held);
  await c.tick();
  assert.equal((f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string }).outcome, 'deferred');
  held.lock.release();
  await c.tick();
  assert.equal((f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string }).outcome, 'landed', 'lands once the slot is free');
});

test('nightly: due once a day after the configured time; the coordinator queues it exactly once', { skip }, async () => {
  const { nightlyDue } = await import('../src/nightly.js');
  const at = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  };
  const today = at(12, 0).toLocaleDateString('en-CA');
  assert.equal(nightlyDue('02:00', null, at(1, 59)), false, 'not before the time');
  assert.equal(nightlyDue('02:00', null, at(2, 0)), true);
  assert.equal(nightlyDue('02:00', today, at(3, 0)), false, 'already queued today');
  assert.equal(nightlyDue(undefined, null, at(3, 0)), false, 'off unless configured');
  const f = fixture();
  f.cfg.tests.nightly_at = '00:00';
  const queued: string[] = [];
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, nightly: () => (queued.push('x'), [{ id: `job-${queued.length}` }]) });
  for (let i = 0; i < 3; i++) await c.tick();
  assert.equal(queued.length, 1);
  assert.deepEqual((f.log.read(0, ['nightly.queued'])[0]!.payload as { jobs: string[] }).jobs, ['job-1']);
});

test('regression: a failing tick step (GitHub down during reconcile) does not stop landing', { skip }, async () => {
  const f = fixture();
  const c = await queueAll(f, ['a.js'], fileAgents());
  const realGet = f.backlog.get.bind(f.backlog);
  f.backlog.get = async () => {
    throw Object.assign(new Error('GitHub 502'), { kind: 'server_error' });
  };
  await c.tick();
  f.backlog.get = realGet;
  assert.equal((f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string }).outcome, 'landed');
  const errs = f.log.read(0, ['coordinator.error']).map((e) => e.payload as { where: string; kind: string });
  assert.ok(errs.some((e) => e.where === 'reconcile' && e.kind === 'server_error'), JSON.stringify(errs));
});

test('trust: a healthy streak asks the owner to promote; approval changes stage; a regression demotes on its own', { skip }, async () => {
  const f = fixture();
  f.cfg.agents.trust = { window_days: 7, promote_after_days: 2, min_tasks: 1, min_evaluator_pass_rate: 0.8, max_unverified_claim_rate: 0.5, max_reverts: 0, max_baseline_growth: 0 };
  f.cfg.review = { version: 1, stages: [{ stage: 2, relax: [{ category: 'app-non-money-large', to: 'L1' }] }], levels: { L0_auto: { when: ['docs-only'], max_lines: 200 }, L1_evaluator: { when: ['app-non-money'], max_lines: 400, max_files: 10 }, L2_notify: { when: ['app-non-money-large'] }, L3_human: { when: ['money-path'], over_lines: 800 } } };
  // One good finished task and yesterday's healthy evaluation already in the log.
  const sha = 'd'.repeat(40);
  f.log.append('issue.seen', { issue: 99, title: 't', labels: [], author: 'example-owner', owner: null, actionable: true, why: '' }, 'c');
  f.log.append('eval.verdict', { issue: 99, head: sha, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '' }, 'c');
  f.log.append('land.result', { issue: 99, outcome: 'landed', landed: sha, detail: '' }, 'c');
  f.log.append('issue.released', { issue: 99, instance: 'alice', why: 'landed' }, 'c');
  f.log.append('trust.evaluated', { day: '2000-01-01', stage: 1, healthy: true, why: [], card: {} }, 'c');
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  const asked = f.log.read(0, ['decision.asked']).map((e) => e.payload as { id: string; kind: string; question: string });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.kind, 'stage');
  assert.match(asked[0]!.question, /Promote to trust stage 2/);
  assert.equal(c.stage(), 1, 'never promoted without the owner');
  f.log.append('decision.answered', { id: asked[0]!.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  await c.tick();
  assert.equal(c.stage(), 2);
  // Regression: a rejected patch drops the pass rate below the floor; tomorrow's evaluation demotes.
  f.log.append('eval.verdict', { issue: 98, head: sha, patch_hash: 'h', patch_correct: false, test_correct: true, confidence: 'high', advice: 'wrong' }, 'c');
  f.log.append('eval.verdict', { issue: 97, head: sha, patch_hash: 'h', patch_correct: false, test_correct: true, confidence: 'high', advice: 'wrong' }, 'c');
  await (c as unknown as { maybeTrust(now: Date): Promise<void> }).maybeTrust(new Date(Date.now() + 86_400_000));
  assert.equal(c.stage(), 1);
  const change = f.log.read(0, ['stage.changed']).at(-1)!.payload as { by: string; reason: string };
  assert.equal(change.by, 'auto');
  assert.match(change.reason, /evaluator pass rate/);
});

test('reports post once per slot to one report issue; lessons go out as a PR branch, once a day', { skip }, async () => {
  const f = fixture();
  f.cfg.project.reports = { times: ['08:00', '18:00'], to: ['example-owner'] };
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  const morning = new Date(2026, 9, 8, 9, 0);
  await c.maybeReport(morning);
  await c.maybeReport(new Date(2026, 9, 8, 10, 0));
  const reports = await f.backlog.list('report');
  assert.equal(reports.length, 1);
  let comments = await f.backlog.comments(reports[0]!.number);
  assert.equal(comments.length, 1, 'same slot: posted once');
  assert.match(comments[0]!.body, /report: .*2026-10-08 08:00[\s\S]*@example-owner/);
  await c.maybeReport(new Date(2026, 9, 8, 18, 5));
  comments = await f.backlog.comments(reports[0]!.number);
  assert.equal(comments.length, 2, 'evening slot posts to the same issue');

  f.log.append('lesson.proposed', { issue: 5, worked: 'ran one test first', failed: '', fix: 'read the runner config before editing' }, 'c');
  await c.maybeLessons(morning);
  await c.maybeLessons(morning);
  const prs = f.backlog.prs();
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.base, 'main');
  const file = execFileSync('git', ['show', `${prs[0]!.head}:${BRAND.configDir}/lessons/2026-10-08.md`], { cwd: f.remote, encoding: 'utf8' });
  assert.match(file, /\*\*Fix:\*\* read the runner config before editing/);
  assert.ok(!execFileSync('git', ['log', '--format=%s', 'main'], { cwd: f.remote, encoding: 'utf8' }).includes('Lessons'), 'main is untouched: lessons only land when the owner merges the PR');
});

test('security role in the pipeline: a change in its category that it blocks goes to the owner as L3, with the finding', { skip }, async () => {
  const f = fixture();
  f.cfg.agents.roles.security = { enabled: true, model: 'opus', applies_to: ['app-non-money'] };
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const runner = agents({ security: () => ({ verdict: 'block', findings: [{ severity: 'critical', file: 'src/price.js', issue: 'trusts a client-supplied price', evidence: 'src/price.js:2' }] }) });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  assert.equal(runner.calls.filter((r) => r.role === 'security').length, 1);
  const lvl = f.log.read(0, ['review.level_set']).at(-1)!.payload as { level: string; reasons: string[] };
  assert.equal(lvl.level, 'L3');
  assert.ok(lvl.reasons.some((r) => /security critical: src\/price\.js: trusts a client-supplied price/.test(r)), lvl.reasons.join(' | '));
  const asked = f.log.read(0, ['decision.asked']).at(-1)!.payload as { kind: string; receipts: string[] };
  assert.equal(asked.kind, 'land');
  assert.ok(asked.receipts.some((r) => /trusts a client-supplied price/.test(r)));
  assert.equal(f.log.read(0, ['land.result']).length, 0, 'nothing lands without the owner');
});

test('acceptance: two instances, each set to 4 workers, never run more than the shared cap together, even when it drops', { skip }, async () => {
  const a = fixture();
  const b = fixture();
  // Two separate instances (own repos, logs and backlogs) on one machine, sharing the slot directory.
  writeFileSync(join(a.slotsDir, 'config.json'), JSON.stringify({ max_agents: 4 }));
  const seen = { now: 0, max: 0 };
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const coords = [a, b].map((f, k) => {
    for (const name of ['a.js', 'b.js', 'c.js', 'd.js']) f.backlog.open(easyIssue(`Add ${name}`, name));
    f.cfg.agents.roles.workers!.count = 4;
    return new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: parallelAgents(gate, seen), repo: f.repo, instance: k ? 'beta' : 'alpha', stateDir: f.stateDir, slotsDir: a.slotsDir, machine: f.machine });
  });
  await Promise.all(coords.map((c) => c.tick()));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(seen.max, 4, 'four running in total, not eight');
  assert.equal(slotStatus(a.slotsDir).agents.length, 4);
  // The adaptive cap drops to 3 while 4 run: nobody is killed, and nobody new starts until below 3.
  writeFileSync(join(a.slotsDir, 'cap.json'), JSON.stringify({ cap: 3 }));
  await Promise.all(coords.map((c) => c.tick()));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(seen.max, 4);
  assert.equal(slotStatus(a.slotsDir).agents.length, 4, 'running agents are never stopped by a lower cap');
  open();
  await Promise.all(coords.map((c) => c.idle()));
  for (let i = 0; i < 6; i++) {
    await Promise.all(coords.map((c) => c.tick()));
    await Promise.all(coords.map((c) => c.idle()));
  }
  assert.ok(seen.max <= 4);
});
