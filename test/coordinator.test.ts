import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { BRAND } from '../src/brand.js';
import { claimRef } from '../src/claims.js';
import { resumeAll, slotStatus, stopAll, tryAgentSlot } from '../src/slots.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
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
  // As a real agent session commits: with the harness identity its environment sets.
  git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}

/** What a diligent evaluator reports: every file changed since the base named in its prompt. */
function readAll(req: RunRequest): string[] {
  const base = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)?.[1];
  return base ? git(req.cwd, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean) : [];
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
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
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
      return { summary: 's' };
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
      return { summary: 's' };
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
      return { summary: 's' };
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
      return { structured: { summary: 's' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
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
    if (req.role !== 'worker') return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
    const name = req.prompt.match(/Add (\S+\.js)/)![1]!;
    writeFileSync(join(req.cwd, 'src', name), `export const x = '${name}';\n`);
    if (name === redFor) writeFileSync(join(req.cwd, 'test', 'new-red.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('brand new failure', () => { assert.equal(1, 2); });\n");
    commitAll(req.cwd, `add ${name}`);
    return { structured: { summary: 's' } };
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
    if (req.role !== 'worker') return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
    const name = req.prompt.match(/Add (\S+\.js)/)![1]!;
    writeFileSync(join(req.cwd, 'src', 'shared.js'), `export const who = '${name}';\n`);
    commitAll(req.cwd, `touch shared for ${name}`);
    return { structured: { summary: 's' } };
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

test('reports post once per slot to one report issue', { skip }, async () => {
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

});

test('acceptance: two instances, each set to 4 workers, never run more than the shared cap together', { skip }, async () => {
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
  open();
  await Promise.all(coords.map((c) => c.idle()));
  for (let i = 0; i < 6; i++) {
    await Promise.all(coords.map((c) => c.tick()));
    await Promise.all(coords.map((c) => c.idle()));
  }
  assert.ok(seen.max <= 4);
});

test('a worker runs in the lane its issue names with a lane:<name> label', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready', 'lane:eval'] });
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  const worker = runner.calls.find((r) => r.role === 'worker')!;
  assert.equal(worker.lane, 'eval');
  assert.equal(runner.calls.find((r) => r.role === 'evaluator-repro')!.lane, undefined, 'evaluators stay in the default lane');
});

test('regression: the worker is told the coordinator runs the checks and which fast tests to run, not that a removed Stop gate will', { skip }, async () => {
  const f = fixture();
  f.cfg.tests.checks = ['node -e "process.exit(0)"'];
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  const worker = runner.calls.find((r) => r.role === 'worker')!;
  assert.doesNotMatch(worker.appendSystemPrompt ?? '', /Stop gate/);
  assert.match(worker.appendSystemPrompt ?? '', /the coordinator runs each check itself/);
  assert.match(worker.prompt, /Fast tests to run while you work: node --test --test-reporter=spec/);
  assert.match(worker.prompt, /the coordinator runs each done_when check, then: node -e "process\.exit\(0\)"/);
});

test('regression: an approving review that did not read every changed file does not pass; the change waits for a human', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  // The evaluator approves but reports reading only the test, not the source change.
  const runner = agents({ 'evaluator-verdict': () => ({ patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: ['test/repro-qty.test.js'] }) });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  const verdict = f.log.read(0, ['eval.verdict']).at(-1)!.payload as { unread?: string[] };
  assert.deepEqual(verdict.unread, ['src/price.js']);
  const lvl = f.log.read(0, ['review.level_set']).at(-1)!.payload as { level: string; reasons: string[] };
  assert.equal(lvl.level, 'L3');
  assert.ok(lvl.reasons.some((r) => /evaluator did not read: src\/price\.js/.test(r)), lvl.reasons.join(' | '));
  assert.equal(f.log.read(0, ['land.result']).length, 0, 'nothing lands on a partial review');
});

test("the project's checks are skipped once an issue's own check failed, and run when they pass", { skip }, async () => {
  const f = fixture();
  const marker = join(f.base, 'project-check-ran');
  f.cfg.tests.checks = [`touch "${marker}"`];
  f.backlog.open({ title: 'Totals count negative quantities', body: 'Totals.\n\n```done_when\n- command: test -f no-such-file\n```\n', author: 'example-owner', labels: ['ready'] });
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, maxAttempts: 2 });
  await c.tick();
  await c.idle();
  assert.equal(existsSync(marker), false, 'the long check never ran');
  const verify = f.log.read(0, ['check.result']).map((e) => e.payload as { stage: string; checks: { check: string; status: string }[] }).filter((p) => p.stage === 'verify');
  assert.ok(verify.length >= 1);
  for (const v of verify) assert.deepEqual(v.checks.map((x) => x.status), ['fail', 'skipped']);
  const retry = runner.calls.filter((r) => r.role === 'worker')[1]!;
  const feedback = retry.prompt.slice(retry.prompt.indexOf('Independent checks failed'));
  assert.match(feedback, /test -f no-such-file: fail/);
  assert.doesNotMatch(feedback, /project-check-ran/, 'a skipped check is not reported to the worker as a failure');

  const g = fixture();
  const ran = join(g.base, 'project-check-ran');
  g.cfg.tests.checks = [`touch "${ran}"`];
  g.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const d = new Coordinator({ cfg: g.cfg, log: g.log, backlog: g.backlog, runner: agents(), repo: g.repo, instance: 'alice', stateDir: g.stateDir, slotsDir: g.slotsDir, machine: g.machine });
  await d.tick();
  await d.idle();
  assert.equal(existsSync(ran), true, 'with the issue checks green, the project check runs');
});

test('emergency stop: one command halts every agent across instances; their tasks requeue; nothing starts until resumed', { skip }, async () => {
  const a = fixture();
  const b = fixture();
  writeFileSync(join(a.slotsDir, 'config.json'), JSON.stringify({ max_agents: 4 }));
  const running = { now: 0, aborted: 0 };
  // Workers that run until they're aborted, like a real agent mid-task.
  const longRunning = () =>
    new FakeRunner(async (req) => {
      if (req.role !== 'worker') return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
      running.now++;
      await new Promise<void>((res) => req.signal?.addEventListener('abort', () => res()));
      running.now--;
      running.aborted++;
      return { reason: 'canceled_by_reconciliation' };
    });
  const coords = [a, b].map((f, k) => {
    for (const name of ['a.js', 'b.js']) f.backlog.open(easyIssue(`Add ${name}`, name));
    f.cfg.agents.roles.workers!.count = 2;
    return new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: longRunning(), repo: f.repo, instance: k ? 'beta' : 'alpha', stateDir: f.stateDir, slotsDir: a.slotsDir, machine: f.machine });
  });
  await Promise.all(coords.map((c) => c.tick()));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(running.now, 4, 'four agents running across two instances');
  stopAll('operator', 'testing the stop', a.slotsDir);
  for (const c of coords) c.checkEmergency();
  await Promise.all(coords.map((c) => c.idle()));
  assert.equal(running.now, 0, 'every agent halted');
  assert.equal(running.aborted, 4);
  assert.equal(slotStatus(a.slotsDir).agents.length, 0, 'their slots are free');
  for (const f of [a, b]) {
    assert.equal(f.log.read(0, ['emergency.stop']).length, 1);
    const released = f.log.read(0, ['issue.released']).map((e) => (e.payload as { why: string }).why);
    assert.deepEqual(released, ['emergency stop', 'emergency stop'], 'tasks requeue rather than fail');
    assert.equal(f.log.read(0, ['issue.blocked']).length, 0);
  }
  await Promise.all(coords.map((c) => c.tick()));
  assert.equal(running.now, 0, 'nothing starts while the stop is in force');
  assert.equal(tryAgentSlot('another harness', a.slotsDir), null, 'other harnesses on the slot protocol are held too');
  assert.ok(resumeAll(a.slotsDir));
  await Promise.all(coords.map((c) => c.tick()));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(running.now, 4, 'resumed: the requeued tasks start again');
  stopAll('operator', 'cleanup', a.slotsDir);
  for (const c of coords) c.checkEmergency();
  await Promise.all(coords.map((c) => c.idle()));
});

test('land_mode pr: an approved change goes out as a PR on its own branch; the default branch is never pushed and nothing merges', { skip }, async () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  const mainBefore = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  const r = f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string; detail: string; landed: string | null };
  assert.equal(r.outcome, 'pr_opened');
  assert.equal(r.landed, null);
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], mainBefore, 'main untouched');
  const branchHead = git(f.repo, 'ls-remote', 'origin', `refs/heads/${BRAND.cli}/issue-${n}`).split('\t')[0];
  assert.ok(branchHead, 'the task branch is pushed');
  assert.match(git(f.repo, 'show', `${branchHead}:src/price.js`), /qty > 0/);
  const prs = f.backlog.prs();
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.base, 'main');
  assert.match(prs[0]!.body, new RegExp(`^Closes #${n}`));
  assert.match(prs[0]!.body, /Independent evaluator:\*\* approves/);
  assert.equal((await f.backlog.get(n)).state, 'open', 'the issue closes when a human merges the PR');
  assert.equal(git(f.repo, 'ls-remote', 'origin', claimRef(n)), '', 'claim released');
  // A second tick doesn't open another PR.
  await c.tick();
  assert.equal(f.backlog.prs().length, 1);
});

test('PR watch: a draft until the required checks pass on the evaluated commit, then ready and labelled; a moved head takes it back; a merge ends the watch', { skip }, async () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci', 'lint'];
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 0 });
  await c.tick();
  await c.idle();
  await c.tick(); // opens the PR, then polls it: nothing reported yet
  const opened = f.log.read(0, ['pr.opened']).at(-1)!.payload as { number: number; head: string; draft: boolean };
  assert.equal(opened.draft, true);
  const pr = () => f.backlog.prs().find((p) => p.number === opened.number)!;
  assert.equal(pr().draft, true, 'opened as a draft');
  assert.equal(pr().headSha, opened.head);
  const status = () => f.log.read(0, ['pr.status']).map((e) => e.payload as { ready: boolean; reasons: string[]; checks: { name: string; outcome: string }[] });
  assert.deepEqual(status().at(-1)!.checks, [{ name: 'ci', outcome: 'missing' }, { name: 'lint', outcome: 'missing' }]);

  const check = (name: string, conclusion: string | null) => ({ name, source: 'check_run' as const, status: conclusion ? 'completed' : 'in_progress', conclusion });
  f.backlog.setChecks(opened.head, [check('ci', null), check('lint', 'success')]);
  await c.tick();
  assert.deepEqual(status().at(-1)!.checks.map((x) => x.outcome), ['pending', 'pass']);
  assert.equal(f.log.read(0, ['pr.ready']).length, 0);
  const before = status().length;
  await c.tick();
  assert.equal(status().length, before, 'an unchanged state is not recorded again');

  f.backlog.setChecks(opened.head, [check('ci', 'success'), check('lint', 'success')]);
  await c.tick();
  assert.equal(f.log.read(0, ['pr.ready']).length, 1);
  assert.equal(pr().draft, false, 'out of draft');
  assert.ok(pr().labels.includes('merge-ready'));
  await c.tick();
  assert.equal(f.log.read(0, ['pr.ready']).length, 1, 'marked once');

  // Someone pushes to the branch: the new head isn't what the evaluator approved.
  f.backlog.setPr(opened.number, { headSha: 'b'.repeat(40) });
  f.backlog.setChecks('b'.repeat(40), [check('ci', 'success'), check('lint', 'success')]);
  await c.tick();
  const unready = f.log.read(0, ['pr.unready']).at(-1)?.payload as { why: string } | undefined;
  assert.match(unready?.why ?? '', /not the commit the evaluator approved/);
  assert.ok(!pr().labels.includes('merge-ready'));

  f.backlog.setPr(opened.number, { merged: true });
  await c.tick();
  assert.deepEqual(f.log.read(0, ['pr.closed']).map((e) => e.payload), [{ issue: n, number: opened.number, merged: true }]);
  assert.deepEqual(c.watchedPrs(), [], 'no longer watched');
});

test('PR watch: with no required checks configured, a PR is never marked ready, whatever passes', { skip }, async () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 0 });
  await c.tick();
  await c.idle();
  await c.tick();
  const opened = f.log.read(0, ['pr.opened']).at(-1)!.payload as { number: number; head: string };
  f.backlog.setChecks(opened.head, [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'success' }]);
  await c.tick();
  assert.equal(f.log.read(0, ['pr.ready']).length, 0);
  assert.match((f.log.read(0, ['pr.status']).at(-1)!.payload as { reasons: string[] }).reasons.join(), /no required checks are configured/);
  assert.equal(f.backlog.prs()[0]!.draft, true);
});

test('PR watch: polls each PR at most once per interval', { skip }, async () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  let polls = 0;
  const pullRequest = f.backlog.pullRequest.bind(f.backlog);
  f.backlog.pullRequest = async (n: number) => {
    polls++;
    return pullRequest(n);
  };
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 3_600_000 });
  await c.tick();
  await c.idle();
  await c.tick();
  await c.tick();
  await c.tick();
  assert.equal(polls, 1);
});

test('push limits on the change: refused before any check runs, the worker is told why, and the block lists every reason', { skip }, async () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.guardrails.push.refuse_paths = ['data/**'];
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const prompts: string[] = [];
  const runner = agents({
    worker: (req) => {
      prompts.push(req.prompt);
      // Fixes the bug, but also commits a data dump and then deletes it: still in the pushed history.
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      mkdirSync(join(req.cwd, 'data'), { recursive: true });
      writeFileSync(join(req.cwd, 'data', 'dump.json'), '{}\n');
      commitAll(req.cwd, 'fix, with a dump');
      git(req.cwd, 'rm', '-q', 'data/dump.json');
      commitAll(req.cwd, 'drop the dump');
      return { summary: 'fixed' };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  const refused = f.log.read(0, ['push.refused']).map((e) => e.payload as { stage: string; reasons: string[] });
  assert.equal(refused.length, 3, 'once per attempt');
  assert.ok(refused.every((r) => r.stage === 'change' && /data\/dump\.json/.test(r.reasons.join(''))));
  assert.match(prompts[1]!, /can't be pushed: .*data\/dump\.json/, 'the next attempt is told why');
  assert.equal(f.log.read(0, ['check.result']).length, 0, 'no checks spent on a change that cannot be pushed');
  assert.equal(f.log.read(0, ['land.queued']).length, 0);
  assert.equal(git(f.repo, 'ls-remote', 'origin', `refs/heads/${BRAND.cli}/issue-${n}`), '', 'nothing pushed');
  const issue = await f.backlog.get(n);
  assert.ok(issue.labels.includes('blocked'));
  const comment = (await f.backlog.comments(n)).map((x) => x.body).find((b) => /blocked/.test(b)) ?? '';
  assert.match(comment, /the push was refused:\n- touches paths that are never pushed \(data\/dump\.json\)/);
});

test('push limits at the push: a pre-land step that adds a refused file stops the landing; main is untouched and the issue blocked', { skip }, async () => {
  const f = fixture();
  f.cfg.guardrails.push.refuse_paths = ['gen/**'];
  f.cfg.tests.land.pre = ['mkdir -p gen && echo generated > gen/out.txt'];
  const mainBefore = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  const refused = f.log.read(0, ['push.refused']).map((e) => e.payload as { issue: number; stage: string; reasons: string[] });
  assert.equal(refused.length, 1, f.log.read().map((e) => e.type).join(', '));
  assert.equal(refused[0]!.stage, 'push');
  assert.equal(refused[0]!.issue, n);
  assert.match(refused[0]!.reasons.join(''), /gen\/out\.txt/);
  assert.equal((f.log.read(0, ['land.result']).at(-1)!.payload as { outcome: string }).outcome, 'rejected');
  assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], mainBefore, 'main untouched');
  assert.ok((await f.backlog.get(n)).labels.includes('blocked'));
  assert.ok((await f.backlog.comments(n)).some((x) => /the push was refused:\n- touches paths that are never pushed \(gen\/out\.txt\)/.test(x.body)));
});

test('no change needed: confirmed by the coordinator\'s own checks on the clean base, reported with evidence, not retried', async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals use cents', body: 'Make totals use integer cents.\n\n```done_when\n- command: grep -q totalCents src/price.js\n- manual: the dashboard shows cents\n```\n', author: 'example-owner', labels: ['ready'] });
  const runner = agents({
    worker: (req) => {
      // It ran a build that rewrote an output, then found nothing to change (the live case: a regenerated sitemap).
      writeFileSync(join(req.cwd, 'README.md'), 'rebuilt\n');
      writeFileSync(join(req.cwd, 'build-output.txt'), 'x\n');
      return { summary: 'checked', no_change_needed: 'src/price.js already computes totals in cents (totalCents).' };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.deepEqual(runner.calls.map((r) => r.role), ['worker'], 'one attempt, no evaluator, no retries');
  const e = f.log.read(0, ['issue.no_change']).at(-1)?.payload as { why: string; checks: { check: string; status: string }[] } | undefined;
  assert.ok(e, types(f.log).join(', '));
  assert.match(e.why, /already computes totals in cents/);
  assert.deepEqual(e.checks.map((x) => x.status), ['pass']);
  assert.equal(f.log.read(0, ['change.rejected']).length, 0, 'leftover build output is not "uncommitted changes" here: the checks ran on the clean base');
  const issue = await f.backlog.get(n);
  assert.equal(issue.state, 'open', 'the owner decides whether to close');
  assert.ok(issue.labels.includes('no-change-needed') && !issue.labels.includes('ready') && !issue.labels.includes('agent:working') && !issue.labels.includes('blocked'));
  const comment = (await f.backlog.comments(n)).map((x) => x.body).find((b) => /no change needed/.test(b)) ?? '';
  assert.match(comment, /pass: `grep -q totalCents src\/price\.js`/);
  assert.match(comment, /Still for you to check by hand: the dashboard shows cents/);
  assert.equal(git(f.repo, 'ls-remote', 'origin', claimRef(n)), '', 'claim released');
  assert.equal(git(f.repo, 'worktree', 'list').split('\n').length, 1, 'worktree removed');
});

test('a worker that claims no change is needed when the checks fail on the base is told so and retried', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Ignore non-positive quantities', body: 'Totals count negative quantities.\n\n```done_when\n- command: grep -q "qty > 0" src/price.js\n```\n', author: 'example-owner', labels: ['ready'] });
  let attempt = 0;
  const runner = agents({
    worker: (req) => {
      attempt++;
      if (attempt === 1) return { summary: 's', no_change_needed: 'looks fine to me' };
      assert.match(req.prompt, /no change needed, but on the unchanged base these checks don't pass:[\s\S]*grep -q "qty > 0" src\/price\.js: fail/);
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      commitAll(req.cwd, 'Ignore non-positive quantities');
      return { summary: 'fixed' };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.equal(attempt, 2);
  assert.equal(f.log.read(0, ['issue.no_change']).length, 0);
  assert.equal(f.log.read(0, ['land.queued']).length, 1);
});

test('regression: a retry that finds the work already committed is judged as a change against the base; failing checks keep their output', { skip }, async () => {
  const f = fixture();
  const flag = join(f.base, 'flag');
  // The check runs in bash, which reads backslashes as escapes: give it the path with forward slashes (Windows too).
  const flagForShell = flag.split('\\').join('/');
  f.backlog.open({ title: 'Ignore non-positive quantities', body: `Totals count negative quantities.\n\n\`\`\`done_when\n- command: grep -q "qty > 0" src/price.js\n- command: test -f ${flagForShell} || { echo "flag missing here"; exit 3; }\n\`\`\`\n`, author: 'example-owner', labels: ['ready'] });
  let attempt = 0;
  const runner = agents({
    worker: (req) => {
      attempt++;
      if (attempt === 1) {
        const p = join(req.cwd, 'src', 'price.js');
        writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
        commitAll(req.cwd, 'Ignore non-positive quantities');
        return { summary: 'fixed' };
      }
      // The second attempt finds its predecessor's work on the branch and nothing left to change.
      writeFileSync(flag, '');
      return { summary: 'already done', no_change_needed: 'the fix is already committed on this branch' };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.equal(attempt, 2);
  const first = f.log.read(0, ['check.result']).at(0)!.payload as { checks: { check: string; status: string; exitCode: number | null; tail?: string }[] };
  const failed = first.checks.find((x) => x.status === 'fail')!;
  assert.equal(failed.exitCode, 3);
  assert.match(failed.tail ?? '', /flag missing here/, 'the event says why the check failed');
  assert.equal(first.checks.find((x) => x.status === 'pass')?.tail, undefined, 'passing checks keep no output');
  assert.ok(!f.log.read(0, ['change.rejected']).some((e) => /committed 1 commit/.test((e.payload as { why: string }).why)), 'not rejected for its predecessor\'s commit');
  assert.equal(f.log.read(0, ['issue.no_change']).length, 0);
  assert.equal(f.log.read(0, ['land.queued']).length, 1);
});

test('regression: a commit with any identity but the harness\'s is rejected before review, and never lands', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Ignore non-positive quantities', body: 'Totals count negative quantities.\n\n```done_when\n- command: grep -q "qty > 0" src/price.js\n```\n', author: 'example-owner', labels: ['ready'] });
  let attempt = 0;
  const runner = agents({
    worker: (req) => {
      attempt++;
      const p = join(req.cwd, 'src', 'price.js');
      if (attempt === 1) {
        // The live case: the agent set a person's name and email for its commit.
        writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
        git(req.cwd, 'add', '-A');
        git(req.cwd, '-c', 'user.name=Ada Example', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
        return { summary: 'fixed' };
      }
      assert.match(req.prompt, /commits must carry the harness identity .*Ada Example <ada@example\.com>/s);
      git(req.cwd, 'reset', '-q', '--soft', 'HEAD~1');
      commitAll(req.cwd, 'fix');
      return { summary: 'recommitted' };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.equal(attempt, 2);
  assert.ok(f.log.read(0, ['change.rejected']).some((e) => /harness identity/.test((e.payload as { why: string }).why)));
  const queued = f.log.read(0, ['land.queued']).at(-1)!.payload as { head: string };
  assert.equal(git(f.repo, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', queued.head), `${DEFAULT_COMMIT_IDENTITY.name} <${DEFAULT_COMMIT_IDENTITY.email}> / ${DEFAULT_COMMIT_IDENTITY.name} <${DEFAULT_COMMIT_IDENTITY.email}>`);
});

test("the project's own variables reach its agents, its worktree setup and its checks", { skip }, async () => {
  const f = fixture();
  f.cfg.tests.env = { PROJECT_PROBE: 'yes' };
  f.cfg.tests.worktree.setup = ['test "$PROJECT_PROBE" = yes'];
  f.cfg.tests.checks = ['test "$PROJECT_PROBE" = yes'];
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  for (const role of ['evaluator-repro', 'worker', 'evaluator-verdict']) assert.deepEqual(runner.calls.find((r) => r.role === role)?.env, { PROJECT_PROBE: 'yes' }, role);
  const verify = f.log.read(0, ['check.result']).map((e) => e.payload as { stage: string; checks: { check: string; status: string }[] }).find((p) => p.stage === 'verify')!;
  assert.deepEqual(verify.checks.find((x) => x.check.includes('PROJECT_PROBE')), { check: 'test "$PROJECT_PROBE" = yes', status: 'pass', exitCode: 0 });
  assert.equal(f.log.read(0, ['coordinator.error']).length, 0, 'worktree setup saw the variable');
});
