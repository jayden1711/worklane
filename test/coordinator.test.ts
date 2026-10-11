import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { parseContract } from '../src/backlog/types.js';
import { BRAND } from '../src/brand.js';
import { claim, claimRef } from '../src/claims.js';
import { resumeAll, slotStatus, stopAll, tryAgentSlot } from '../src/slots.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator, logTail } from '../src/coordinator.js';
import type { InstanceSettings } from '../src/instance.js';
import { liveRuns, sendMessage, stopRun } from '../src/console.js';
import { askChat, chatAnswer } from '../src/chat.js';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { CliRunner, DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { childEnv, which } from '../src/os/index.js';
import { repoRoot, STDIN_LINE } from './helpers.js';

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

test('the core budget: {cores} is filled in for the coordinator\'s checks (env and command) and the agent\'s session', { skip }, async () => {
  const f = fixture();
  f.cfg.tests.env = { WORKERS: '{cores}' };
  f.cfg.tests.cores = { reserve: 0, min: 2, max: 2 }; // exactly 2 on any machine
  const seen = join(mkdtempSync(join(tmpdir(), 'cores-')), 'seen.txt');
  const check = `node -e "require('fs').writeFileSync(process.argv[1], (process.env.WORKERS || 'unset') + ' ' + process.argv[2])" ${JSON.stringify(seen)} {cores}`;
  const body = `Orders with a zero quantity are counted.\n\n\`\`\`done_when\n- command: |-\n    ${check}\n\`\`\`\n`;
  f.backlog.open({ title: 'Totals count zero quantities', body, author: 'example-owner', labels: ['ready'] });
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.equal(readFileSync(seen, 'utf8'), '2 2', 'the check got WORKERS=2 and the argument 2');
  const worker = runner.calls.find((r) => r.role === 'worker');
  assert.equal(worker?.env?.WORKERS, '2', 'the agent session too');
});

test('a refused issue is judged again when its done_when is edited: still invalid gets the new error; valid is claimed', { skip }, async () => {
  const f = fixture();
  const body = (yaml: string) => `Orders with a zero quantity are counted.\r\n\r\n\`\`\`done_when\r\n${yaml}\r\n\`\`\`\r\n`;
  const n = f.backlog.open({ title: 'edited contract', body: body('- command: a: b'), author: 'example-owner', labels: ['ready'] });
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  const refusals = async () => (await f.backlog.comments(n)).map((x) => x.body).filter((b) => /not starting/i.test(b));
  await c.tick();
  await c.idle();
  assert.equal((await refusals()).length, 1);
  assert.match((await refusals())[0]!, /Not starting: done_when is not valid YAML/);
  // Edited, still invalid with a different error: a fresh comment with the new error.
  f.backlog.editBody(n, body('- nonsense: 1'));
  await c.tick();
  await c.idle();
  assert.equal((await refusals()).length, 2);
  assert.match((await refusals())[1]!, /Still not starting after the edit: done_when invalid/);
  // Not edited again: nothing new, however many polls.
  for (let i = 0; i < 3; i++) await c.tick();
  assert.equal((await refusals()).length, 2);
  assert.equal(runner.calls.length, 0);
  // Edited to a valid contract: the next poll claims it.
  f.backlog.editBody(n, BUG);
  await c.tick();
  await c.idle();
  assert.ok(f.log.read(0, ['issue.claimed']).some((e) => (e.payload as { issue: number }).issue === n), 'claimed after the fix');
  assert.ok(runner.calls.length > 0);
});

test('a refusal recorded before block hashes existed is not repeated for an unchanged issue', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'old refusal', body: 'make it better', author: 'example-owner', labels: ['ready'] });
  const why = (parseContract('make it better') as { why: string }).why;
  f.log.append('contract.missing', { issue: n, why }, 'coordinator');
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  for (let i = 0; i < 3; i++) await c.tick();
  assert.equal((await f.backlog.comments(n)).length, 0);
});

test('a worker run that fails at startup is reported with claude\'s error, not retried into "no passing change"', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const normal = agents();
  let workers = 0;
  const runner = new FakeRunner(async (req) => {
    if (req.role !== 'worker') return normal.run(req);
    workers++;
    return { reason: 'failed', detail: 'error_during_execution: sandbox required but unavailable: bubblewrap not found', turns: 0 };
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.equal(workers, 1, 'no further attempts after a startup failure');
  const comments = (await f.backlog.comments(n)).map((x) => x.body);
  const blocked = comments.find((b) => /blocked:/.test(b)) ?? '';
  assert.match(blocked, /claude run failed to start/);
  assert.match(blocked, /sandbox required but unavailable: bubblewrap not found/);
  assert.ok(!comments.some((b) => /no passing change/.test(b)));
  assert.equal(f.log.read(0, ['run.startup_failed']).length, 1);
});

test('a run the runner reports as transient blocks once as auth or transient, not as a failed change', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const normal = agents();
  let workers = 0;
  const runner = new FakeRunner(async (req) => {
    if (req.role !== 'worker') return normal.run(req);
    workers++;
    return { reason: 'failed', transient: true, turns: 0, detail: 'error_during_execution: Failed to refresh OAuth token: another Claude Code process is refreshing it (still failing after 8 tries over 33 min)' };
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.equal(workers, 1);
  const blocked = (await f.backlog.comments(n)).map((x) => x.body).find((b) => /blocked:/.test(b)) ?? '';
  assert.match(blocked, /@example-owner blocked: claude kept failing to start on an auth or transient error/);
  assert.match(blocked, /not on this change/);
  assert.match(blocked, /Failed to refresh OAuth token/);
  assert.equal(f.log.read(0, ['run.startup_failed']).length, 0, 'not reported as a startup failure of the change');
});

test('a worker run that committed work before failing still gets its attempts', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const normal = agents();
  let workers = 0;
  const runner = new FakeRunner(async (req) => {
    if (req.role !== 'worker') return normal.run(req);
    workers++;
    writeFileSync(join(req.cwd, `note-${workers}.txt`), 'partial\n');
    commitAll(req.cwd, `partial ${workers}`);
    return { reason: 'failed', detail: 'error_max_turns: ', turns: 200 };
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.equal(f.log.read(0, ['run.startup_failed']).length, 0);
  assert.ok(workers > 1, 'retried');
});

test('task files the coordinator writes into its state are closed to others, whatever the umask', { skip: skip || (process.platform === 'win32' && 'POSIX modes') }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const old = process.umask(0o022);
  try {
    const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
    await c.tick();
    await c.idle();
  } finally {
    process.umask(old);
  }
  const task = join(f.stateDir, 'tasks', `issue-${n}.json`);
  assert.ok(existsSync(task));
  assert.equal(statSync(task).mode & 0o007, 0, `task file is ${(statSync(task).mode & 0o777).toString(8)}`);
  assert.equal(statSync(join(f.stateDir, 'tasks')).mode & 0o007, 0, 'tasks/ too');
});

test('with separate users, task files go to the agents\' read-only task directory, and the agent is pointed there', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const tasksDir = join(mkdtempSync(join(tmpdir(), 'inst-')), 'tasks');
  const runner = agents();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, agentTasks: { dir: tasksDir, gid: process.getgid?.() ?? 0 } });
  await c.tick();
  await c.idle();
  const task = join(tasksDir, `issue-${n}.json`);
  assert.ok(existsSync(task), 'written to the task directory');
  assert.ok(!existsSync(join(f.stateDir, 'tasks', `issue-${n}.json`)), 'not into the coordinator\'s private state');
  assert.ok(runner.calls.filter((r) => r.taskFile).every((r) => r.taskFile === task), 'every run with a task file is pointed at it');
  if (process.platform !== 'win32') {
    assert.equal(statSync(task).mode & 0o777, 0o640);
    assert.equal(statSync(tasksDir).mode & 0o777, 0o750);
  }
});

// ---- plan mode (size:M/L)

const PLAN = { approach: 'Guard totals against non-positive quantities.', steps: ['Change the totals reducer', 'Run the price tests'], files: ['src/price.js'], risks: ['Callers relying on negative totals'], design_change: false };

/** A size:M issue with a scripted planner; `worker` decides each build attempt. */
function plannedTask(planOf: (req: RunRequest) => object, worker?: (req: RunRequest) => object) {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready', 'size:M'] });
  const runner = agents({ planner: planOf, ...(worker ? { worker } : {}) });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  const run = async () => {
    await c.tick();
    await c.idle();
  };
  const answer = async (text: string) => {
    f.backlog.humanComment(n, 'example-owner', text);
    await c.tick(); // the decision
    await run(); // the task again, if it was put back to ready
  };
  const roles = () => runner.calls.map((r) => r.role);
  return { f, n, c, runner, run, answer, roles };
}

test('plan mode: a size:M issue is planned read-only first, the plan posted, and the build proceeds at once with the plan in its brief', { skip }, async () => {
  const t = plannedTask(() => PLAN);
  await t.run();
  const planner = t.runner.calls.find((r) => r.role === 'planner')!;
  assert.ok(planner, 'a plan run');
  assert.ok(planner.disallowedTools?.includes('Edit') && planner.disallowedTools?.includes('Write') && !planner.allowedTools.includes('Bash'), 'read-only');
  assert.ok(t.roles().indexOf('planner') < t.roles().indexOf('worker'), 'planned before building');
  const posted = lastOf(t.f.log, 'plan.posted') as { held: boolean; reasons: string[] };
  assert.deepEqual([posted.held, posted.reasons], [false, []]);
  assert.ok((await t.f.backlog.comments(t.n)).some((x) => /The build starts now with this plan/.test(x.body)));
  assert.match(t.runner.calls.find((r) => r.role === 'worker')!.prompt, /1\. Change the totals reducer\n2\. Run the price tests/);
  assert.equal(t.f.log.read(0, ['decision.asked']).filter((e) => (e.payload as { kind: string }).kind === 'plan').length, 0);
});

test('plan mode: a plan touching an L3 path is held for the owner and builds nothing until approved; then it builds with that plan', { skip }, async () => {
  const t = plannedTask(() => ({ ...PLAN, files: ['migrations/002_orders.sql', 'src/price.js'] }));
  await t.run();
  const posted = lastOf(t.f.log, 'plan.posted') as { held: boolean; reasons: string[]; decision: string };
  assert.deepEqual([posted.held, posted.reasons], [true, ['high-risk: migration (migrations/002_orders.sql)', 'design: new top-level module (migrations/)']]);
  const asked = lastOf(t.f.log, 'decision.asked') as { id: string; kind: string; options: string[] };
  assert.deepEqual([asked.id, asked.kind, asked.options], [posted.decision, 'plan', ['approve', 'revise', 'reject']]);
  assert.ok(!t.roles().includes('worker'), 'nothing built');
  await t.run();
  assert.ok(!t.roles().includes('worker'), 'still nothing built while it waits');
  await t.answer(`/${BRAND.cli} approve`);
  assert.deepEqual((lastOf(t.f.log, 'plan.decided') as { answer: string }).answer, 'approve');
  assert.equal(t.roles().filter((r) => r === 'planner').length, 1, 'the approved plan is built, not planned again');
  assert.match(t.runner.calls.find((r) => r.role === 'worker')!.prompt, /migrations\/002_orders\.sql/);
});

test("plan mode: a design-level plan is held; revise plans again with the owner's note; reject builds nothing", { skip }, async () => {
  let planned = 0;
  const t = plannedTask(() => (++planned === 1 ? { ...PLAN, design_change: true, design_reason: 'adds a public --currency option' } : PLAN));
  await t.run();
  assert.deepEqual((lastOf(t.f.log, 'plan.posted') as { reasons: string[] }).reasons, ['design: the plan flagged a design change: adds a public --currency option']);
  await t.answer(`/${BRAND.cli} revise keep the CLI as it is`);
  assert.deepEqual([(lastOf(t.f.log, 'plan.decided') as { answer: string; note: string }).answer, (lastOf(t.f.log, 'plan.decided') as { note: string }).note], ['revise', 'keep the CLI as it is']);
  const replanned = t.runner.calls.filter((r) => r.role === 'planner')[1]!;
  assert.match(replanned.prompt, /The owner asked for a revised plan: keep the CLI as it is/);
  assert.ok(t.roles().includes('worker'), 'the revised plan was ordinary: built at once');

  const u = plannedTask(() => ({ ...PLAN, files: ['migrations/002_orders.sql'] }));
  await u.run();
  await u.answer(`/${BRAND.cli} reject`);
  await u.run();
  assert.equal((lastOf(u.f.log, 'plan.decided') as { answer: string }).answer, 'reject');
  assert.ok(!u.roles().includes('worker'), 'rejected: nothing built');
});

test("plan mode: the owner's objection to a plan being built stops the task before its next attempt", { skip }, async () => {
  let attempts = 0;
  const t = plannedTask(
    () => PLAN,
    () => {
      attempts++;
      t.f.backlog.humanComment(t.n, 'example-owner', `/${BRAND.cli} object the guard belongs in the caller`);
      return { summary: 'no change yet' }; // nothing committed: the attempt is rejected and another would follow
    },
  );
  await t.run();
  assert.equal(attempts, 1, 'no second attempt after the objection');
  assert.deepEqual(lastOf(t.f.log, 'plan.objected'), { issue: t.n, by: 'example-owner', why: 'the guard belongs in the caller' });
  assert.ok((await t.f.backlog.comments(t.n)).some((x) => /objected to the plan: the guard belongs in the caller/.test(x.body)));
});

// ---- unknown-domain requests

/** A task whose worker was refused a host and stops (blocked), so the owner's answer can be acted on later. */
function refusedTask() {
  const f = fixture();
  const n = f.backlog.open({ title: 'Use the rates API', body: 'Read the rates from new.example.org.\n\n```done_when\n- test: test/price.test.js\n```\n', author: 'example-owner', labels: ['ready'] });
  const refused = [{ host: 'new.example.org', tool: 'WebFetch', what: 'https://new.example.org/rates' }];
  const normal = agents();
  const workers: RunRequest[] = [];
  const runner = new FakeRunner(async (req) => {
    if (req.role !== 'worker') return normal.run(req);
    workers.push(req);
    return { structured: { summary: 's', blocked: 'needs new.example.org' }, refusedHosts: refused };
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  const rerun = async () => {
    f.backlog.removeLabel(n, 'blocked');
    f.backlog.addLabels(n, ['ready']);
    await c.tick();
    await c.idle();
  };
  const answer = async (a: string) => {
    f.backlog.humanComment(n, 'example-owner', `/${BRAND.cli} ${a}`);
    await c.tick();
  };
  return { f, n, c, workers, rerun, answer };
}

test("unknown domain: a refused host is recorded once per task and asked of the owner, deny recommended; nothing is widened", { skip }, async () => {
  const t = refusedTask();
  await t.c.tick();
  await t.c.idle();
  const req = lastOf(t.f.log, 'network.domain_requested') as { issue: number; host: string; role: string; tool: string; decision: string };
  assert.deepEqual([req.issue, req.host, req.role, req.tool], [t.n, 'new.example.org', 'worker', 'WebFetch']);
  const asked = lastOf(t.f.log, 'decision.asked') as { id: string; kind: string; options: string[]; recommendation: string };
  assert.deepEqual([asked.id, asked.kind, asked.options, asked.recommendation], [req.decision, 'domain', ['allow-repo', 'allow-once', 'deny'], 'deny']);
  assert.ok((await t.f.backlog.comments(t.n)).some((x) => /decision needed: \*\*Allow agents to reach new\.example\.org\?\*\*/.test(x.body)));
  await t.rerun(); // refused again on the next run: not asked twice
  assert.equal(t.f.log.read(0, ['network.domain_requested']).length, 1);
  assert.equal(git(t.f.remote, 'branch', '--list', `${BRAND.cli}/allow-*`), '', 'no config change without an answer');
});

test('unknown domain: allow-repo opens the guardrails change as a pull request; main is untouched', { skip }, async () => {
  const t = refusedTask();
  await t.c.tick();
  await t.c.idle();
  const mainBefore = git(t.f.remote, 'rev-parse', 'main');
  await t.answer('allow-repo');
  const d = lastOf(t.f.log, 'network.domain_decided') as { answer: string; pr: string | null; by: string };
  assert.deepEqual([d.answer, d.by], ['allow-repo', 'example-owner']);
  assert.ok(d.pr, 'a pull request');
  const branch = `${BRAND.cli}/allow-new.example.org`;
  assert.match(git(t.f.remote, 'show', `${branch}:${BRAND.configDir}/guardrails.yaml`), /new\.example\.org/);
  assert.equal(git(t.f.remote, 'rev-parse', 'main'), mainBefore, 'never widened in place');
  assert.ok(t.f.backlog.prs().some((p) => p.head === branch && p.title === 'Allow agents to reach new.example.org'));
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['network.domain_decided']).length, 1, 'acted on once');
});

test("unknown domain: allow-once lets the task's next run reach the host, and only that run; deny changes nothing", { skip }, async () => {
  const t = refusedTask();
  await t.c.tick();
  await t.c.idle();
  await t.answer('allow-once');
  await t.rerun();
  assert.deepEqual(t.workers.at(-1)!.allowOnce, ['new.example.org']);
  await t.rerun();
  assert.equal(t.workers.at(-1)!.allowOnce, undefined, 'used up by the run it was for');

  const u = refusedTask();
  await u.c.tick();
  await u.c.idle();
  await u.answer('deny');
  assert.equal((lastOf(u.f.log, 'network.domain_decided') as { answer: string; pr: string | null }).pr, null);
  await u.rerun();
  assert.equal(u.workers.at(-1)!.allowOnce, undefined);
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

test('hotspots: a task that would change the same hotspot as a running one waits; other ready work takes the slot', { skip }, async () => {
  const f = fixture();
  f.cfg.project.hotspots = ['src/price.js'];
  const a = f.backlog.open({ ...easyIssue('Add a.js', 'a.js'), body: `Add a.js and register it in src/price.js.\n\n\`\`\`done_when\n- test: test/price.test.js\n\`\`\`\n` });
  const b = f.backlog.open({ ...easyIssue('Add b.js', 'b.js'), body: `Add b.js and register it in \`src/price.js\`.\n\n\`\`\`done_when\n- test: test/price.test.js\n\`\`\`\n` });
  f.backlog.open(easyIssue('Add c.js', 'c.js'));
  f.cfg.agents.roles.workers!.count = 2;
  writeFileSync(join(f.slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const seen = { now: 0, max: 0 };
  const runner = parallelAgents(gate, seen);
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(seen.max, 2, 'both slots in use');
  assert.deepEqual(f.log.read(0, ['hotspot.held']).map((e) => e.payload), [{ issue: b, by: a, files: ['src/price.js'], reason: `waits for #${a}: both change src/price.js` }]);
  await c.tick(); // still held: recorded once, not every tick
  assert.equal(f.log.read(0, ['hotspot.held']).length, 1);
  open();
  await c.idle();
  await c.tick();
  await c.idle();
  const released = f.log.read(0, ['hotspot.released']).map((e) => e.payload as { issue: number; started: boolean; files: string[]; waited_ms: number });
  assert.deepEqual(released.map((r) => [r.issue, r.started, r.files]), [[b, true, ['src/price.js']]]);
  assert.ok(released[0]!.waited_ms >= 250, `waited ${released[0]!.waited_ms} ms`);
  assert.equal(runner.calls.filter((r) => r.role === 'worker').length, 3, 'the held task ran once the slot and the file were free');
});

test('hotspots: tasks touching no hotspot run in parallel as before, and an empty list turns holds off', { skip }, async () => {
  const f = fixture();
  f.cfg.project.hotspots = [];
  const body = `Add x and change src/price.js.\n\n\`\`\`done_when\n- test: test/price.test.js\n\`\`\`\n`;
  f.backlog.open({ ...easyIssue('Add a.js', 'a.js'), body: body.replace('Add x', 'Add a.js') });
  f.backlog.open({ ...easyIssue('Add b.js', 'b.js'), body: body.replace('Add x', 'Add b.js') });
  f.cfg.agents.roles.workers!.count = 2;
  writeFileSync(join(f.slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const seen = { now: 0, max: 0 };
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: parallelAgents(gate, seen), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  await c.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(seen.max, 2);
  assert.equal(f.log.read(0, ['hotspot.held']).length, 0);
  open();
  await c.idle();
});

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

test('the weekly report links run records and puts a fix for a repeated failure in the owner\'s Inbox, once', { skip }, async () => {
  const f = fixture();
  f.cfg.project.reports = { times: ['08:00', '18:00'], to: ['example-owner'] };
  // Three worker runs that ended within seconds with nothing committed, on Monday morning after the 08:00 slot.
  const t = (m: number, s: number) => new Date(2026, 9, 5, 8, m, s).toISOString();
  let id = 0;
  const ev = (ts: string, type: string, payload: object) => ({ id: --id, ts, type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
  const history: StoredEvent[] = [];
  mkdirSync(join(f.stateDir, 'runs'), { recursive: true });
  for (const [i, m] of [30, 31, 32].entries()) {
    history.push(ev(t(m, 0), 'run.started', { issue: 7, role: 'worker', model: 'm', worktree: 'w', pid: 1, pgid: 1, attempt: i + 1 }));
    history.push(ev(t(m, 8), 'run.finished', { issue: 7, role: 'worker', reason: 'failed', detail: 'error_during_execution: ' }));
    history.push(ev(t(m, 9), 'change.rejected', { issue: 7, why: 'no changes committed' }));
    writeFileSync(join(f.stateDir, 'runs', `run-${i + 1}.json`), JSON.stringify({ v: 1, id: `run-${i + 1}`, issue: 7, role: 'worker', model: 'm', startedAt: t(m, 0), endedAt: t(m, 8), reason: 'failed', costUsd: 0, turns: 0, steps: [], files: [], otherTools: 0, final: '', truncated: false }));
  }
  history.push(ev(t(33, 0), 'issue.blocked', { issue: 7, owner: 'example-owner', why: 'no passing change after 3 attempts' }));
  class WithHistory extends EventLog {
    override read(afterId = 0, types?: Parameters<EventLog['read']>[1]) {
      return [...history.filter((e) => !types || types.includes(e.type)), ...super.read(afterId, types)];
    }
  }
  const log = new WithHistory(f.log.path);
  const c = new Coordinator({ cfg: f.cfg, log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.maybeReport(new Date(2026, 9, 5, 9, 0)); // Monday, the first slot: the weekly section is due
  const asked = () => log.read(0, ['decision.asked']).map((e) => e.payload as { owner: string; issue: number | null; question: string; options: string[]; recommendation: string; receipts: string[] });
  assert.equal(asked().length, 1);
  const d = asked()[0]!;
  assert.equal(d.owner, f.cfg.project.owners.default);
  assert.equal(d.issue, null, 'an Inbox decision, not tied to an issue');
  assert.match(d.question, /^Repeated failure \(3 runs this week, startup failure\)/);
  assert.deepEqual(d.options, ['make it impossible', 'test or lint', 'written rule', 'leave it']);
  assert.equal(d.recommendation, 'make it impossible');
  assert.ok(d.receipts[0]!.startsWith('key: failure-mode:startup failure:'));
  assert.ok(d.receipts.some((r) => r.includes('/runs/run-1')), 'examples link their run records');
  const report = (await f.backlog.comments((await f.backlog.list('report'))[0]!.number))[0]!.body;
  assert.match(report, /\[#7 worker attempt 1 \(8s\)\]\(\/runs\/run-1\)/);
  // A week later the same runs are still in the window: the report lists them, but the decision isn't asked again.
  await c.maybeReport(new Date(2026, 9, 12, 8, 10));
  assert.equal(asked().length, 1);
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

// ---- CI fix runs

/** The latest event of a type; a clear failure (not a TypeError) when there is none. */
function lastOf(log: EventLog, type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never): unknown {
  const e = log.read(0, [type]).at(-1);
  assert.ok(e, `no ${type} event (got: ${[...new Set(log.read().map((x) => x.type))].join(', ')})`);
  return e.payload;
}

const failing = (id: number) => [{ name: 'ci', source: 'check_run' as const, status: 'completed', conclusion: 'failure', id }];
const passing = [{ name: 'ci', source: 'check_run' as const, status: 'completed', conclusion: 'success', id: 1 }];

/** PR mode with one required check and fix runs on; runs the task until its PR is open. */
async function openPr(over: Partial<Record<string, (r: RunRequest) => object>> = {}, opts: { fixes?: boolean; autoMerge?: () => boolean; edit?: (cfg: ReturnType<typeof fixture>['cfg']) => void } = {}) {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  if (opts.fixes !== false) f.cfg.agents.roles.ci_repair = { enabled: true, model: 'sonnet', max_fixes_per_pr: 2 };
  opts.edit?.(f.cfg);
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const runner = agents(over);
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 0, ...(opts.autoMerge ? { autoMerge: opts.autoMerge } : {}) });
  await c.tick();
  await c.idle();
  await c.tick();
  const opened = f.log.read(0, ['pr.opened']).at(-1)!.payload as { number: number; head: string };
  const remoteHead = () => git(f.repo, 'ls-remote', 'origin', `refs/heads/${BRAND.cli}/issue-${n}`).split('\t')[0]!;
  const pr = () => f.backlog.prs().find((p) => p.number === opened.number)!;
  /** What GitHub would do after a push: the PR's head follows the branch. */
  const sync = () => f.backlog.setPr(opened.number, { headSha: remoteHead() });
  return { f, n, c, runner, opened, remoteHead, pr, sync };
}

/** A fix-run worker that commits a small real change and says what it did. */
const fixer = (req: RunRequest) => {
  if (!/CI fix run/.test(req.prompt)) return null;
  const p = join(req.cwd, 'src', 'price.js');
  writeFileSync(p, `${readFileSync(p, 'utf8')}// checked by CI fix\n`);
  commitAll(req.cwd, 'Fix the CI failure');
  return { summary: 'fixed the failing check' };
};

/** The default worker for the first run, the fixer for fix runs. */
function workerWith(fix: (req: RunRequest) => object | null) {
  return (req: RunRequest) => {
    const out = fix(req);
    if (out) return out;
    const p = join(req.cwd, 'src', 'price.js');
    writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
    commitAll(req.cwd, 'Ignore non-positive quantities in totals');
    return { summary: 'fixed' };
  };
}

test('CI fix run: a failed required check gets a fix on the same branch, with the job log; re-verified and re-evaluated; never merged', { skip }, async () => {
  const t = await openPr({ worker: workerWith(fixer) });
  t.f.backlog.setChecks(t.opened.head, failing(11));
  t.f.backlog.setJobLog(11, '2026-10-10T07:44:38.786Z FAILED test/price.test.js - expected 5, got 3\n');
  await t.c.tick();
  await t.c.idle();
  const fixPrompt = t.runner.calls.find((r) => /CI fix run 1/.test(r.prompt))?.prompt ?? '';
  assert.ok(fixPrompt, 'a CI fix run started');
  assert.match(fixPrompt, /FAILED test\/price\.test\.js - expected 5, got 3/, 'the brief carries the log');
  assert.doesNotMatch(fixPrompt, /2026-10-10T07:44/, 'without the runner timestamps');
  const started = t.f.log.read(0, ['ci_fix.started']).map((e) => e.payload as { head: string; checks: string[]; attempt: number });
  assert.deepEqual(started.map((s) => [s.head, s.checks, s.attempt]), [[t.opened.head, ['ci'], 1]]);
  const done = lastOf(t.f.log, 'ci_fix.finished') as { outcome: string; head: string };
  assert.equal(done.outcome, 'pushed');
  assert.equal(t.remoteHead(), done.head, 'pushed to the PR branch');
  assert.equal(git(t.f.repo, 'merge-base', '--is-ancestor', t.opened.head, done.head), '', 'added commits, history kept');
  const verdicts = t.f.log.read(0, ['eval.verdict']).map((e) => (e.payload as { head: string }).head);
  assert.ok(verdicts.includes(done.head), 'the evaluator judged the fixed head');
  assert.ok(t.f.log.read(0, ['check.result']).some((e) => (e.payload as { head: string }).head === done.head), 'the coordinator re-ran its checks on it');
  assert.ok(t.pr().comments.some((x) => /CI fix run 1 pushed/.test(x.body)));
  assert.equal(git(t.f.repo, 'ls-remote', 'origin', claimRef(t.n)), '', 'claim released');
  // GitHub moves the PR head; CI passes on the fix: ready, and still nothing merged.
  t.sync();
  t.f.backlog.setChecks(done.head, passing);
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['pr.ready']).length, 1);
  assert.equal(t.pr().merged, false);
  assert.equal(t.f.log.read(0, ['ci_fix.gave_up']).length, 0);
});

test('CI fix runs stop at max_fixes_per_pr, then ask the owner: comment, ci-failing label, review request', { skip }, async () => {
  const t = await openPr({ worker: workerWith(fixer) });
  for (let i = 0; i < 3; i++) {
    t.f.backlog.setChecks(t.pr().headSha, failing(20 + i));
    t.f.backlog.setJobLog(20 + i, `still red ${i}\n`);
    await t.c.tick();
    await t.c.idle();
    t.sync();
  }
  assert.equal(t.f.log.read(0, ['ci_fix.started']).length, 2, 'two fix runs, not three');
  const gave = t.f.log.read(0, ['ci_fix.gave_up']).map((e) => e.payload as { reason: string });
  assert.equal(gave.length, 1);
  assert.match(gave[0]!.reason, /2 fix run\(s\) already, the limit/);
  assert.ok(t.pr().labels.includes('ci-failing'));
  assert.deepEqual(t.pr().reviewers, ['example-owner']);
  assert.ok(t.pr().comments.some((x) => /^\[[^\]]+\] @example-owner required check\(s\) failing .*No more CI fix runs on this PR: 2 fix run/.test(x.body)));
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['ci_fix.gave_up']).length, 1, 'asked once');
});

test("CI fix run: a log the credential can't read (no Actions: read) gives up with that reason instead of guessing", { skip }, async () => {
  const t = await openPr({ worker: workerWith(fixer) });
  t.f.backlog.setChecks(t.opened.head, failing(31));
  t.f.backlog.setJobLog(31, 403);
  await t.c.tick();
  await t.c.idle();
  assert.equal(t.f.log.read(0, ['ci_fix.started']).length, 0, 'no run started');
  assert.ok(!t.runner.calls.some((r) => /CI fix run/.test(r.prompt)));
  const gave = lastOf(t.f.log, 'ci_fix.gave_up') as { reason: string };
  assert.match(gave.reason, /no Actions: read permission, and a fix without the log would be a guess/);
  assert.ok(t.pr().labels.includes('ci-failing'));
  assert.deepEqual(t.pr().reviewers, ['example-owner']);
});

test('CI fix run: a check without a readable log (not an Actions job) also gives up', { skip }, async () => {
  const t = await openPr({ worker: workerWith(fixer) });
  t.f.backlog.setChecks(t.opened.head, [{ name: 'ci', source: 'status', status: 'completed', conclusion: 'failure' }]);
  await t.c.tick();
  assert.match((lastOf(t.f.log, 'ci_fix.gave_up') as { reason: string }).reason, /has no job log the harness can read/);
});

test('CI fix run: never on a branch someone else pushed to', { skip }, async () => {
  const t = await openPr({ worker: workerWith(fixer) });
  const theirs = 'c'.repeat(40);
  t.f.backlog.setPr(t.opened.number, { headSha: theirs });
  t.f.backlog.setChecks(theirs, failing(41));
  t.f.backlog.setJobLog(41, 'red\n');
  await t.c.tick();
  await t.c.idle();
  assert.equal(t.f.log.read(0, ['ci_fix.started']).length, 0);
  assert.match((lastOf(t.f.log, 'ci_fix.gave_up') as { reason: string }).reason, /someone else pushed to the branch/);
});

test("CI fix run: the worker's evidence that the failure isn't caused by the change means no push, and the owner is asked", { skip }, async () => {
  const t = await openPr({ worker: workerWith((req) => (/CI fix run/.test(req.prompt) ? { summary: 'looked', no_change_needed: 'test/flaky.test.js fails on main too (run it on the base: same error)' } : null)) });
  t.f.backlog.setChecks(t.opened.head, failing(51));
  t.f.backlog.setJobLog(51, 'flaky\n');
  await t.c.tick();
  await t.c.idle();
  assert.equal(t.remoteHead(), t.opened.head, 'nothing pushed');
  assert.equal((lastOf(t.f.log, 'ci_fix.finished') as { outcome: string }).outcome, 'no_push');
  assert.match((lastOf(t.f.log, 'ci_fix.gave_up') as { reason: string }).reason, /isn't caused by this change: test\/flaky\.test\.js fails on main too/);
  assert.ok(t.pr().comments.some((x) => /@example-owner .*fails on main too/.test(x.body)));
});

test('CI fix run: if the branch moves while the fix runs, the push is refused (compare-and-swap) and the human commit stays', { skip }, async () => {
  let human = '';
  const t = await openPr({
    worker: workerWith((req) => {
      if (!/CI fix run/.test(req.prompt)) return null;
      // Someone pushes to the PR branch meanwhile, from their own clone.
      const other = mkdtempSync(join(tmpdir(), 'human-'));
      const branch = /branch (\S+), head/.exec(req.prompt)![1]!;
      git(other, 'clone', '-q', '-b', branch, git(req.cwd, 'remote', 'get-url', 'origin'), 'c');
      writeFileSync(join(other, 'c', 'NOTES.md'), 'mine\n');
      git(join(other, 'c'), 'add', 'NOTES.md');
      git(join(other, 'c'), '-c', 'user.email=h@example.com', '-c', 'user.name=H', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'human');
      git(join(other, 'c'), 'push', '-q', 'origin', branch);
      human = git(join(other, 'c'), 'rev-parse', 'HEAD');
      return fixer(req);
    }),
  });
  t.f.backlog.setChecks(t.opened.head, failing(61));
  t.f.backlog.setJobLog(61, 'red\n');
  await t.c.tick();
  await t.c.idle();
  assert.ok(human);
  assert.equal(t.remoteHead(), human, "the human's commit is still the branch head");
  assert.match((lastOf(t.f.log, 'ci_fix.gave_up') as { reason: string }).reason, /the branch moved while the fix ran/);
});

test('CI fix runs off (roles.ci_repair disabled): a failure asks the owner straight away', { skip }, async () => {
  const t = await openPr({}, { fixes: false });
  t.f.backlog.setChecks(t.opened.head, failing(71));
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['ci_fix.started']).length, 0);
  assert.match((lastOf(t.f.log, 'ci_fix.gave_up') as { reason: string }).reason, /CI fix runs are off/);
});

test('a CI fix run cut off by a restart is recorded as interrupted and its claim released', async () => {
  const f = fixture();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  const lease = { instance: 'alice', run_id: 'r', issue: 7, expires_at: new Date(Date.now() + 3600_000).toISOString(), base: git(f.repo, 'rev-parse', 'HEAD') };
  const won = claim(lease, { repo: f.repo });
  assert.ok(won.won);
  f.log.append('ci_fix.started', { issue: 7, number: 8, head: lease.base, checks: ['ci'], attempt: 1, lease: won.sha }, 'alice');
  await c.recover();
  assert.deepEqual((lastOf(f.log, 'ci_fix.finished') as { outcome: string }).outcome, 'interrupted');
  assert.equal(git(f.repo, 'ls-remote', 'origin', claimRef(7)), '', 'claim released');
  await c.recover();
  assert.equal(f.log.read(0, ['ci_fix.finished']).length, 1, 'once');
});

test('logTail: the last lines of a job log, runner timestamps stripped, bounded', () => {
  assert.equal(logTail('2026-10-10T07:44:38.7864502Z a\r\n2026-10-10T07:44:38.7Z b\nc', 2), 'b\nc');
  assert.equal(logTail('x'.repeat(50), 150, 10).length, 10);
});

// ---- merge policy

/** A diligent evaluator that approves with high confidence and answers the design question. */
const approve = (design = false) => (req: RunRequest) => ({ patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req), design_change: design, ...(design ? { design_reason: 'adds a public option' } : {}) });

/** Required check green on the PR's head, then one poll. */
async function green(t: Awaited<ReturnType<typeof openPr>>) {
  t.f.backlog.setChecks(t.pr().headSha, passing);
  await t.c.tick();
}

/** Merges for real on the test remote (a --no-ff merge commit of the PR head), as GitHub would. */
function realMerges(t: Awaited<ReturnType<typeof openPr>>) {
  t.f.backlog.mergeWith = (pr) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gh-merge-')), 'c');
    git(t.f.base, 'clone', '-q', t.f.remote, dir);
    git(dir, 'fetch', '-q', 'origin', pr.head);
    git(dir, '-c', 'user.email=gh@example.com', '-c', 'user.name=GitHub', '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.headSha);
    git(dir, 'push', '-q', 'origin', 'main');
    return git(dir, 'rev-parse', 'HEAD');
  };
}

const reasonsOf = (t: Awaited<ReturnType<typeof openPr>>) => (lastOf(t.f.log, 'merge.decided') as { auto: boolean; reasons: string[] });

test('auto-merge: a clean ready PR is merged with a merge commit pinned to the evaluated head', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  const calls: { sha: string; title: string }[] = [];
  const merge = t.f.backlog.mergePr.bind(t.f.backlog);
  t.f.backlog.mergePr = async (n, sha, title) => {
    calls.push({ sha, title });
    return merge(n, sha, title);
  };
  await green(t);
  assert.deepEqual([reasonsOf(t).auto, reasonsOf(t).reasons], [true, []]);
  assert.deepEqual(calls, [{ sha: t.opened.head, title: `Totals count negative quantities (#${t.n}) (#${t.opened.number})` }]);
  const done = lastOf(t.f.log, 'merge.done') as { head: string; sha: string };
  assert.equal(done.head, t.opened.head);
  assert.ok(t.pr().merged);
  assert.ok(t.pr().comments.some((x) => /Auto-merged as `.{8}` \(a merge commit of the evaluated head/.test(x.body)));
  assert.ok(!t.pr().labels.includes('needs-owner'));
  await t.c.tick();
  assert.deepEqual(lastOf(t.f.log, 'pr.closed'), { issue: t.n, number: t.opened.number, merged: true });
});

test('auto-merge off (the instance kill switch, the default): a ready PR waits, with the reason, a label and a review request, once', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() });
  await green(t);
  assert.deepEqual([reasonsOf(t).auto, reasonsOf(t).reasons], [false, ['auto-merge is off for this instance (policy.yaml auto_merge)']]);
  assert.ok(!t.pr().merged);
  assert.ok(t.pr().labels.includes('needs-owner'));
  assert.deepEqual(t.pr().reviewers, ['example-owner']);
  const pings = () => t.pr().comments.filter((x) => /waits for you to review and merge/.test(x.body)).length;
  assert.equal(pings(), 1);
  await t.c.tick();
  await t.c.tick();
  assert.equal(pings(), 1, 'asked once per head');
});

test('auto-merge: the kill switch is read at decision time, and a throwing or unreadable policy counts as off', { skip }, async () => {
  let on = true;
  const t = await openPr({ 'evaluator-verdict': approve() }, {
    autoMerge: () => {
      if (!on) throw new Error('policy.yaml unreadable');
      return on;
    },
  });
  on = false;
  await green(t);
  assert.match(reasonsOf(t).reasons.join(), /auto-merge is off for this instance/);
  assert.ok(!t.pr().merged);
});

test("auto-merge: the repo's own high-risk category waits, naming the path", { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, {
    autoMerge: () => true,
    edit: (cfg) => {
      cfg.review!.categories = { ...cfg.review!.categories, pricing: ['src/price.js'] };
      cfg.review!.merge.wait_categories = ['pricing'];
    },
  });
  await green(t);
  assert.deepEqual(reasonsOf(t).reasons, ['high-risk: pricing (src/price.js)']);
  assert.ok(!t.pr().merged && t.pr().labels.includes('needs-owner'));
});

test("auto-merge: the evaluator's design-change flag is binding", { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve(true) }, { autoMerge: () => true });
  await green(t);
  assert.deepEqual(reasonsOf(t).reasons, ['design: the evaluator flagged a design change: adds a public option']);
  assert.ok(!t.pr().merged);
});

test('auto-merge: an evaluator that gives no design answer is doubt', { skip }, async () => {
  const t = await openPr({}, { autoMerge: () => true });
  await green(t);
  assert.deepEqual(reasonsOf(t).reasons, ['doubt: the evaluator gave no design-change answer']);
});

test('auto-merge: over the configured size waits', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true, edit: (cfg) => void (cfg.review!.merge.max_lines = 2) });
  await green(t);
  assert.match(reasonsOf(t).reasons.join(), /^big: \d+ changed lines \(over 2\)$/);
});

test('auto-merge: a PR that needed a CI fix run waits, even once green', { skip }, async () => {
  const t = await openPr({ worker: workerWith(fixer), 'evaluator-verdict': approve() }, { autoMerge: () => true });
  t.f.backlog.setChecks(t.opened.head, failing(81));
  t.f.backlog.setJobLog(81, 'red\n');
  await t.c.tick();
  await t.c.idle();
  t.sync();
  await green(t);
  assert.deepEqual(reasonsOf(t).reasons, ['doubt: 1 CI fix run(s) on this PR']);
  assert.ok(!t.pr().merged);
});

test("auto-merge: GitHub's merge check decides too: still computing waits a poll, and so does a stale conflict on a branch that already has its base", { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'unknown' });
  await green(t);
  assert.equal(t.f.log.read(0, ['merge.decided']).length, 0, 'no decision while GitHub computes');
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'dirty' });
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['merge.decided']).length, 0);
  assert.equal(t.f.log.read(0, ['conflict_fix.detected']).length, 0, 'main has not moved: nothing to fix, no run spent');
  assert.ok(!t.pr().merged);
});

// ---- combined-state check

/** Someone else's change lands on main (no conflict with the PR). */
function changeOnMain(t: Awaited<ReturnType<typeof openPr>>, file: string, edit: (text: string) => string) {
  const dir = join(mkdtempSync(join(tmpdir(), 'other-')), 'c');
  git(t.f.base, 'clone', '-q', t.f.remote, dir);
  writeFileSync(join(dir, file), edit(existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : ''));
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=o@example.com', '-c', 'user.name=Other', '-c', 'commit.gpgsign=false', 'commit', '-qm', `Change ${file} on main`);
  git(dir, 'push', '-q', 'origin', 'main');
  return git(dir, 'rev-parse', 'HEAD');
}

/** The combined-state check runs in the background: wait for its result. */
async function lightDone(t: Awaited<ReturnType<typeof openPr>>) {
  for (let i = 0; i < 200 && !t.f.log.read(0, ['light_check.finished']).length; i++) await new Promise((r) => setTimeout(r, 50));
  return lastOf(t.f.log, 'light_check.finished') as { outcome: string; overlap: string[]; main_sha: string; head: string; detail: string };
}

test('combined check: main moved, but not on anything the PR touches or imports: the PR merges at once', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  changeOnMain(t, 'README.md', (s) => `${s}\nA note.\n`);
  await green(t);
  assert.ok(t.pr().merged);
  assert.equal(t.f.log.read(0, ['light_check.started']).length, 0, 'no extra test run');
});

test('combined check: main changed a file the PR changes: the fast tier runs on the combination off the PR, then the unchanged green head merges', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  const mainSha = changeOnMain(t, 'src/price.js', (s) => `${s}\n// a note from main\n`);
  await green(t);
  assert.ok(!t.pr().merged, 'not before the combination is checked');
  const done = await lightDone(t);
  assert.deepEqual([done.outcome, done.overlap, done.main_sha, done.head], ['merge', ['src/price.js'], mainSha, t.opened.head]);
  await t.c.tick();
  assert.ok(t.pr().merged);
  assert.equal((lastOf(t.f.log, 'merge.done') as { head: string }).head, t.opened.head, 'the head that passed CI, unchanged');
  assert.equal(t.remoteHead(), t.opened.head, 'nothing was pushed to the PR');
});

test("combined check: main's change breaks the fast tests together with the PR: it waits for the owner with the failure; off, it merges at once", { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  changeOnMain(t, 'src/price.js', (s) => s.replace('return Math.round(cents * (100 - pct) / 100);', 'return cents;'));
  await green(t);
  const done = await lightDone(t);
  assert.equal(done.outcome, 'hold');
  await t.c.tick();
  assert.equal(reasonsOf(t).auto, false);
  assert.match(reasonsOf(t).reasons.join(), /^combined with main at [0-9a-f]{8} \(which changed src\/price\.js\), the fast tests fail: /);
  assert.ok(!t.pr().merged);

  const off = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true, edit: (cfg) => void (cfg.project.combined_check = false) });
  changeOnMain(off, 'src/price.js', (s) => s.replace('return Math.round(cents * (100 - pct) / 100);', 'return cents;'));
  await green(off);
  assert.ok(off.pr().merged);
  assert.equal(off.f.log.read(0, ['light_check.started']).length, 0);
});

// ---- conflict fix runs

/** Someone else's change lands on main on the very line the PR changed: a real conflict for the PR. */
function conflictOnMain(t: Awaited<ReturnType<typeof openPr>>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'other-')), 'c');
  git(t.f.base, 'clone', '-q', t.f.remote, dir);
  const p = join(dir, 'src', 'price.js');
  writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty, 0);', 'sum + cents * qty, 0); // audited'));
  git(dir, '-c', 'user.email=o@example.com', '-c', 'user.name=Other', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'Mark the totals line as audited');
  git(dir, 'push', '-q', 'origin', 'main');
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'dirty' });
  return git(dir, 'rev-parse', 'HEAD');
}

/** A conflict-fix worker: keeps both sides of the totals line; `stray` also edits a line outside the hunk. */
const resolver = (o: { stray?: boolean } = {}) => (req: RunRequest) => {
  if (!/Conflict fix \d/.test(req.prompt)) return null;
  const p = join(req.cwd, 'src', 'price.js');
  let text = readFileSync(p, 'utf8').replace(/<<<<<<<[\s\S]*?>>>>>>>[^\n]*\n/, '  return items.reduce((sum, { cents, qty }) => sum + (qty > 0 ? cents * qty : 0), 0); // audited\n');
  if (o.stray) text = text.replace("throw new RangeError('pct must be 0-100')", "throw new RangeError('pct must be between 0 and 100')");
  writeFileSync(p, text);
  commitAll(req.cwd, 'Merge main into the branch, keeping both changes');
  return { summary: 'kept the quantity guard and the audit note' };
};

/** An evaluator that also answers the conflict question. */
const approveBoth = (kept: boolean, confidence = 'high') => (req: RunRequest) => ({ ...approve()(req), confidence, ...(/both_sides_kept/.test(req.prompt) ? { both_sides_kept: kept } : {}) });

test('conflict fix: a PR GitHub reports as conflicting gets its base merged in and the hunk resolved; re-verified, evaluated against the new base, pushed, then auto-merged', { skip }, async () => {
  const t = await openPr({ worker: workerWith(resolver()), 'evaluator-verdict': approveBoth(true) }, { autoMerge: () => true });
  const mainSha = conflictOnMain(t);
  await t.c.tick();
  await t.c.idle();
  const brief = t.runner.calls.find((r) => /Conflict fix 1/.test(r.prompt))?.prompt ?? '';
  assert.match(brief, /1 hunk\(s\) in 1 file\(s\) conflict/);
  assert.match(brief, /What this PR is for: this pull request/);
  assert.match(brief, /What changed on main: Mark the totals line as audited/);
  assert.match(brief, /\/\/ audited/, 'the base side of the hunk');
  const evalPrompt = t.runner.calls.filter((r) => r.role === 'evaluator-verdict').at(-1)!.prompt;
  assert.match(evalPrompt, /both_sides_kept/);
  assert.match(evalPrompt, /How the conflicts were resolved/, 'the resolution diff, separately');
  assert.ok(t.f.log.read(0, ['conflict_fix.detected']).length === 1);
  const done = lastOf(t.f.log, 'conflict_fix.finished') as { outcome: string; head: string; files: string[]; waits_owner: boolean; reasons: string[]; base_sha: string; strategy: string };
  assert.deepEqual([done.outcome, done.files, done.waits_owner, done.reasons, done.base_sha, done.strategy], ['pushed', ['src/price.js'], false, [], mainSha, 'merge']);
  assert.equal(done.head, t.remoteHead(), 'pushed to the PR branch');
  assert.equal(git(t.f.repo, 'rev-parse', `${done.head}^1`), t.opened.head, 'a merge commit on top of the PR head');
  assert.equal(git(t.f.repo, 'rev-parse', `${done.head}^2`), mainSha);
  // GitHub now sees the new head, mergeable; CI passes on it: the merge policy decides from scratch.
  t.sync();
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'clean' });
  await green(t);
  assert.deepEqual([reasonsOf(t).auto, reasonsOf(t).reasons], [true, []]);
  assert.ok(t.pr().merged);
});

test('conflict fix: a resolution that changes lines outside the conflicted hunks, or an evaluator short of sure, waits for the owner', { skip }, async () => {
  const t = await openPr({ worker: workerWith(resolver({ stray: true })), 'evaluator-verdict': approveBoth(true) }, { autoMerge: () => true });
  conflictOnMain(t);
  await t.c.tick();
  await t.c.idle();
  const done = lastOf(t.f.log, 'conflict_fix.finished') as { outcome: string; waits_owner: boolean; reasons: string[] };
  assert.equal(done.outcome, 'pushed');
  assert.deepEqual(done.reasons, ['conflict fix: changed outside the conflicted hunks: src/price.js (lines outside the conflicted hunks changed)']);
  t.sync();
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'clean' });
  await green(t);
  assert.equal(reasonsOf(t).auto, false);
  assert.ok(reasonsOf(t).reasons.includes(done.reasons[0]!));
  assert.ok(!t.pr().merged);

  const u = await openPr({ worker: workerWith(resolver()), 'evaluator-verdict': approveBoth(false) }, { autoMerge: () => true });
  conflictOnMain(u);
  await u.c.tick();
  await u.c.idle();
  assert.deepEqual((lastOf(u.f.log, 'conflict_fix.finished') as { reasons: string[] }).reasons, ['conflict fix: the evaluator found a side whose behavior was lost']);
});

test('conflict fix: the cap (default 1, a run cut short by a restart counts), runs off, or a branch someone else pushed to: the owner is asked, once', { skip }, async () => {
  const t = await openPr({ worker: workerWith(resolver()), 'evaluator-verdict': approveBoth(true) }, { autoMerge: () => true });
  conflictOnMain(t);
  // A run that a restart cut off: recovered as interrupted, and it used the one allowed run.
  t.f.log.append('conflict_fix.started', { issue: t.n, number: t.opened.number, head: t.opened.head, base_sha: t.opened.head, strategy: 'merge', attempt: 1, lease: t.opened.head }, 'test');
  await t.c.recover();
  assert.equal((lastOf(t.f.log, 'conflict_fix.finished') as { outcome: string }).outcome, 'interrupted');
  await t.c.tick();
  await t.c.idle();
  const gave = lastOf(t.f.log, 'conflict_fix.finished') as { outcome: string; detail: string };
  assert.equal(gave.outcome, 'gave_up');
  assert.match(gave.detail, /1 conflict fix run\(s\) already, the limit \(config\.yaml conflicts\.max_fixes_per_pr: 1\)/);
  assert.ok(!t.runner.calls.some((r) => /Conflict fix/.test(r.prompt)), 'no new run');
  assert.ok(t.pr().labels.includes('needs-owner'));
  assert.deepEqual(t.pr().reviewers, ['example-owner']);
  const asks = () => t.pr().comments.filter((x) => /this PR conflicts with its base/.test(x.body)).length;
  assert.equal(asks(), 1);
  await t.c.tick();
  await t.c.tick();
  assert.equal(asks(), 1, 'asked once per head and base');

  const off = await openPr({}, { autoMerge: () => true, edit: (cfg) => void (cfg.project.conflicts.fix = false) });
  conflictOnMain(off);
  await off.c.tick();
  assert.match((lastOf(off.f.log, 'conflict_fix.finished') as { detail: string }).detail, /conflict fix runs are off/);

  const theirs = await openPr({}, { autoMerge: () => true });
  conflictOnMain(theirs);
  theirs.f.backlog.setPr(theirs.opened.number, { headSha: 'c'.repeat(40), mergeableState: 'dirty' });
  await theirs.c.tick();
  assert.match((lastOf(theirs.f.log, 'conflict_fix.finished') as { detail: string }).detail, /someone else pushed to the branch/);
});

test('conflict fix: only a real conflict starts one; behind, blocked and still-computing states never do', { skip }, async () => {
  const t = await openPr({ worker: workerWith(resolver()), 'evaluator-verdict': approveBoth(true) }, { autoMerge: () => true });
  conflictOnMain(t);
  for (const state of ['behind', 'blocked', 'unknown']) {
    t.f.backlog.setPr(t.opened.number, { mergeableState: state });
    await t.c.tick();
    await t.c.idle();
  }
  assert.equal(t.f.log.read(0, ['conflict_fix.detected', 'conflict_fix.started']).length, 0);
  assert.ok(!t.runner.calls.some((r) => /Conflict fix/.test(r.prompt)));
});

/**
 * Two harness PRs that change the same line differently: once the first merges, the second conflicts.
 * Polls every tick until both are open; the caller then sets a slow poll to see what brings PR 2 back.
 */
async function twoPrs() {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  const body = (what: string) => `${what}.\n\n\`\`\`done_when\n- test: test/price.test.js\n\`\`\`\n`;
  const a = f.backlog.open({ title: 'Guard totals against negative quantities', body: body('Ignore non-positive quantities in totals'), author: 'example-owner', labels: ['ready'] });
  const b = f.backlog.open({ title: 'Clamp quantities in totals', body: body('Clamp quantities at zero in totals'), author: 'example-owner', labels: ['ready'] });
  const line = 'sum + cents * qty, 0);';
  const runner = agents({
    worker: (req) => {
      const p = join(req.cwd, 'src', 'price.js');
      if (/Conflict fix \d/.test(req.prompt)) {
        writeFileSync(p, readFileSync(p, 'utf8').replace(/<<<<<<<[\s\S]*?>>>>>>>[^\n]*\n/, '  return items.reduce((sum, { cents, qty }) => sum + cents * Math.max(qty, 0), 0);\n'));
        commitAll(req.cwd, 'Merge main into the branch, keeping both changes');
        return { summary: 'both clamp the quantity' };
      }
      const guard = /Guard totals/.test(req.prompt);
      writeFileSync(p, readFileSync(p, 'utf8').replace(line, guard ? 'sum + (qty > 0 ? cents * qty : 0), 0);' : 'sum + cents * Math.max(qty, 0), 0);'));
      commitAll(req.cwd, guard ? 'Guard totals' : 'Clamp quantities');
      return { summary: 'done' };
    },
    'evaluator-verdict': approveBoth(true),
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 0, autoMerge: () => true });
  for (let i = 0; i < 12 && f.log.read(0, ['pr.opened']).length < 2; i++) {
    await c.tick();
    await c.idle();
  }
  const opened = f.log.read(0, ['pr.opened']).map((e) => e.payload as { issue: number; number: number; head: string });
  assert.equal(opened.length, 2, 'both PRs open');
  const prA = opened.find((o) => o.issue === a)!;
  const prB = opened.find((o) => o.issue === b)!;
  f.backlog.mergeWith = (pr) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gh-merge-')), 'c');
    git(f.base, 'clone', '-q', f.remote, dir);
    git(dir, 'fetch', '-q', 'origin', pr.head);
    git(dir, '-c', 'user.email=gh@example.com', '-c', 'user.name=GitHub', '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.headSha);
    git(dir, 'push', '-q', 'origin', 'main');
    return git(dir, 'rev-parse', 'HEAD');
  };
  // From here, the slow poll: PR 2 isn't due for an hour on its own.
  const inner = c as unknown as { d: { prPollMs: number }; prPolled: Map<number, number>; tipCheckedAt: number };
  inner.d.prPollMs = 3_600_000;
  inner.prPolled.set(prB.number, Date.now());
  return { f, c, prA, prB, inner, conflictStarted: () => f.log.read(0, ['conflict_fix.started']).some((e) => (e.payload as { number: number }).number === prB.number) };
}

test('conflict fix: right after an auto-merge, the other open PRs are looked at again on the next pass, so a new conflict is fixed at once', { skip }, async () => {
  const t = await twoPrs();
  t.inner.tipCheckedAt = Date.now(); // only the merge itself may bring PR 2 back here
  t.inner.prPolled.set(t.prA.number, 0);
  t.f.backlog.setChecks(t.prA.head, passing);
  await t.c.tick();
  assert.ok(t.f.log.read(0, ['merge.done']).some((e) => (e.payload as { number: number }).number === t.prA.number), 'PR 1 auto-merged');
  // GitHub now reports PR 2 as conflicting with the new main.
  t.f.backlog.setPr(t.prB.number, { mergeableState: 'dirty' });
  t.inner.tipCheckedAt = Date.now();
  await t.c.tick();
  await t.c.idle();
  assert.ok(t.conflictStarted(), "PR 2's conflict fix started on the next pass, not after the hour-long poll");
});

test('conflict fix: when the default branch moves (anyone merged), the open PRs are looked at again within seconds', { skip }, async () => {
  const t = await twoPrs();
  t.inner.prPolled.set(t.prA.number, Date.now());
  // Someone merges PR 1 by hand on GitHub: the harness didn't merge it, so only the branch tip shows it.
  t.inner.tipCheckedAt = 0;
  await t.c.tick(); // records main's current tip
  const pr = t.f.backlog.prs().find((p) => p.number === t.prA.number)!;
  t.f.backlog.mergeWith!({ number: t.prA.number, head: pr.head, headSha: t.prA.head, base: 'main' });
  t.f.backlog.setPr(t.prB.number, { mergeableState: 'dirty' });
  t.inner.tipCheckedAt = 0; // the 15 s since the last tip check have passed
  await t.c.tick();
  await t.c.idle();
  assert.ok(t.conflictStarted(), "PR 2's conflict fix started once main's tip moved");
});

test('auto-merge stop: main red after an auto-merge (green before it) stops auto-merge, opens a revert PR that never auto-merges, and asks the owner; only the operator resumes it', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  realMerges(t);
  const before = git(t.f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!;
  t.f.backlog.setChecks(before, passing);
  await green(t);
  const done = lastOf(t.f.log, 'merge.done') as { sha: string };
  assert.equal(git(t.f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], done.sha);
  t.f.backlog.setChecks(done.sha, failing(91));
  await t.c.tick();
  assert.deepEqual(lastOf(t.f.log, 'merge.main_result'), { issue: t.n, number: t.opened.number, sha: done.sha, outcome: 'red', failed: ['ci'] });
  const stop = lastOf(t.f.log, 'merge.stopped') as { reason: string; revert: string | null };
  assert.ok(stop.revert, stop.reason);
  assert.ok(existsSync(join(t.f.stateDir, 'auto-merge-stopped.json')), 'persisted');
  const revert = t.f.backlog.prs().find((p) => p.head === `${BRAND.cli}/revert-pr-${t.opened.number}`)!;
  assert.ok(revert, 'a revert PR');
  assert.equal(revert.title, `Revert "Totals count negative quantities (#${t.n})" (#${t.opened.number})`);
  assert.doesNotMatch(git(t.f.repo, 'show', `${revert.headSha}:src/price.js`), /qty > 0/, 'the revert undoes the change');
  assert.ok(revert.labels.includes('needs-owner'));
  assert.deepEqual(revert.reviewers, ['example-owner']);
  assert.ok(t.pr().comments.some((x) => /@example-owner main's required checks failed \(ci\).*Auto-merge is stopped on this instance until the operator deletes/.test(x.body)));
  assert.ok(!t.c.watchedPrs().some((w) => w.number === revert.number), 'the revert PR is never watched, so never auto-merged (and never reverted)');
  // A new PR now waits, however clean.
  assert.match(String(t.c.autoMergeStopped()), /after auto-merging/);
  // Survives a restart: a new coordinator still sees the stop.
  const again = new Coordinator({ cfg: t.f.cfg, log: t.f.log, backlog: t.f.backlog, runner: agents(), repo: t.f.repo, instance: 'alice', stateDir: t.f.stateDir, slotsDir: t.f.slotsDir, machine: t.f.machine, prPollMs: 0, autoMerge: () => true });
  assert.ok(again.autoMergeStopped());
  rmSync(join(t.f.stateDir, 'auto-merge-stopped.json'));
  await again.tick();
  assert.ok(t.f.log.read(0, ['merge.resumed']).length === 1, 'the operator cleared it');
  assert.equal(again.autoMergeStopped(), null);
});

test('auto-merge stop: main red after an auto-merge but already red before it: stopped and told, nothing reverted', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  realMerges(t);
  const before = git(t.f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0]!;
  t.f.backlog.setChecks(before, failing(92));
  await green(t);
  const done = lastOf(t.f.log, 'merge.done') as { sha: string };
  t.f.backlog.setChecks(done.sha, failing(93));
  await t.c.tick();
  const stop = lastOf(t.f.log, 'merge.stopped') as { reason: string; revert: string | null };
  assert.equal(stop.revert, null);
  assert.match(stop.reason, /was not green before it/);
  assert.ok(!t.f.backlog.prs().some((p) => p.head.includes('revert')));
});

test('auto-merge: main green after it is recorded and nothing stops', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  realMerges(t);
  await green(t);
  const done = lastOf(t.f.log, 'merge.done') as { sha: string };
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['merge.main_result']).length, 0, 'pending: nothing yet');
  t.f.backlog.setChecks(done.sha, passing);
  await t.c.tick();
  assert.equal((lastOf(t.f.log, 'merge.main_result') as { outcome: string }).outcome, 'green');
  assert.equal(t.f.log.read(0, ['merge.stopped']).length, 0);
});

// ---- instruction evals

const AGENTS_CASES = '## 1. Ledger alert\n**Situation**\n- An alert fires on the ledger.\n\n**Correct**\n- Reads the alert row first.\n\n**Wrong**\n- Edits the ledger by hand.\n';

/**
 * PR mode with auto-merge on, where the change also rewrites AGENTS.md. `base` is AGENTS.md on main
 * before the task (with its eval cases unless `cases` is false). The scripted model under test plans
 * badly when its instructions say BAD; the judge passes only a good plan.
 */
async function instructionsPr(o: { base: string | null; head: string; cases?: boolean; enabled?: boolean; cap?: number }) {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  if (o.enabled === false) f.cfg.agents.instruction_evals.enabled = false;
  if (o.cap) f.cfg.agents.instruction_evals.cap_usd = o.cap;
  if (o.base !== null) writeFileSync(join(f.repo, 'AGENTS.md'), o.base);
  if (o.cases !== false) {
    mkdirSync(join(f.repo, BRAND.configDir, 'evals'), { recursive: true });
    writeFileSync(join(f.repo, BRAND.configDir, 'evals', 'AGENTS.md'), AGENTS_CASES);
  }
  if (o.base !== null || o.cases !== false) {
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', 'agent instructions and their evals');
    git(f.repo, 'push', '-q', 'origin', 'main');
  }
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const runner = agents({
    worker: workerWith((req) => {
      writeFileSync(join(req.cwd, 'AGENTS.md'), o.head);
      return null;
    }),
    'evaluator-verdict': approve(),
    'instruction-eval': (req) => {
      if ('plan' in ((req.jsonSchema as { properties: object }).properties ?? {})) return { plan: req.appendSystemPrompt?.includes('BAD') ? 'edit the ledger by hand' : 'read the alert row first' };
      const good = /<plan>\nread the alert row/.test(req.prompt);
      return { notes: '', correct: [good], wrong: [!good] };
    },
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, prPollMs: 0, autoMerge: () => true });
  await c.tick();
  await c.idle();
  await c.tick();
  const opened = lastOf(f.log, 'pr.opened') as { number: number; head: string };
  f.backlog.setChecks(opened.head, passing);
  await c.tick();
  const pr = f.backlog.prs().find((p) => p.number === opened.number)!;
  return { f, n, runner, opened, pr, decided: lastOf(f.log, 'merge.decided') as { auto: boolean; reasons: string[] } };
}

test('instruction evals: a change that makes AGENTS.md score lower waits for the owner, with the per-case diff and the cost', { skip }, async () => {
  const t = await instructionsPr({ base: 'Read before you act.\n', head: 'BAD: act first.\n' });
  const e = lastOf(t.f.log, 'instructions.eval') as { target: string; base: object; result: object; dropped: boolean; changes: object[]; cost_usd: number };
  assert.deepEqual([e.target, e.base, e.result, e.dropped], ['AGENTS.md', { passed: 1, total: 1 }, { passed: 0, total: 1 }, true]);
  assert.deepEqual(e.changes, [{ id: '1', title: 'Ledger alert', base: 'pass', head: 'fail' }]);
  assert.ok(e.cost_usd > 0);
  assert.equal(t.decided.auto, false);
  assert.deepEqual(t.decided.reasons, [`eval: AGENTS.md scored lower, 1/1 → 0/1 (~$${e.cost_usd.toFixed(2)}):\n  - case 1 "Ledger alert": pass → fail`]);
  assert.ok(!t.pr.merged);
  assert.ok(t.pr.comments.some((x) => /waits for you[\s\S]*case 1 "Ledger alert": pass → fail/.test(x.body)), 'the waiting comment carries the diff');
  assert.match(t.pr.body, /\*\*Instruction evals\*\* \(base → head; ~\$[\d.]+, the CLI's cost estimate\):\n- AGENTS\.md: 1\/1 → 0\/1, \*\*lower\*\*; case 1 pass → fail/);
  assert.equal(t.f.log.read(0, ['run.cost']).filter((x) => (x.payload as { role: string }).role === 'instruction-eval').length, 4, 'base and head, each a plan and a judgement');
  // The agent under test never saw the rubric, and was a different model from the judge.
  const evalRuns = t.runner.calls.filter((r) => r.role === 'instruction-eval');
  const underTest = evalRuns.filter((r) => r.appendSystemPrompt);
  assert.ok(underTest.length === 2 && underTest.every((r) => !/Reads the alert row first|Edits the ledger by hand/.test(r.prompt) && r.model === 'sonnet'));
  assert.ok(evalRuns.filter((r) => !r.appendSystemPrompt).every((r) => r.model === 'opus'));
});

test('instruction evals: no drop, no reason: the change auto-merges', { skip }, async () => {
  const t = await instructionsPr({ base: 'Read before you act.\n', head: 'Read the alert, then act.\n' });
  assert.equal((lastOf(t.f.log, 'instructions.eval') as { dropped: boolean }).dropped, false);
  assert.equal(t.decided.auto, true, t.decided.reasons.join('; '));
  assert.ok(t.pr.merged);
});

test('instruction evals: instructions without eval cases, or evals turned off, wait for the owner (fail closed)', { skip }, async () => {
  const none = await instructionsPr({ base: 'Read before you act.\n', head: 'Changed.\n', cases: false });
  assert.deepEqual(none.decided.reasons, [`eval: AGENTS.md was not evaluated: no eval cases (${BRAND.configDir}/evals/AGENTS.md)`]);
  assert.ok(!none.runner.calls.some((r) => r.role === 'instruction-eval'), 'nothing to run');
  const off = await instructionsPr({ base: 'Read before you act.\n', head: 'Changed.\n', enabled: false });
  assert.deepEqual(off.decided.reasons, ['eval: AGENTS.md was not evaluated: instruction evals are off (agents.yaml instruction_evals)']);
});

test('instruction evals: the spend cap bounds an eval; cut short, the PR waits', { skip }, async () => {
  // Each scripted call costs $0.01: a $0.015 cap stops it inside the base run.
  const t = await instructionsPr({ base: 'Read before you act.\n', head: 'Read the alert, then act.\n', cap: 0.015 });
  const e = lastOf(t.f.log, 'instructions.eval') as { incomplete: boolean; cost_usd: number };
  assert.equal(e.incomplete, true);
  assert.ok(e.cost_usd <= 0.015 + 0.01 + 1e-9, `${e.cost_usd}: never more than one call past the cap`);
  assert.match(t.decided.reasons.join(), /incomplete: the cost cap was reached/);
  assert.ok(!t.pr.merged);
});

// ---- health data

test('every check records how long it ran, at verify and at landing', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  await c.tick();
  const results = f.log.read(0, ['check.result']).map((e) => e.payload as { stage: string; checks: { status: string; duration_ms?: number }[] });
  const verify = results.find((r) => r.stage === 'verify')!;
  const land = results.find((r) => r.stage === 'land')!;
  assert.ok(verify && land, results.map((r) => r.stage).join());
  for (const ch of [...verify.checks, ...land.checks].filter((x) => x.status !== 'skipped')) assert.ok(Number.isInteger(ch.duration_ms) && ch.duration_ms! > 0, JSON.stringify(ch));
});

test('waits on the Claude login (a second or more) and transient retries are recorded with the run’s issue and role', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const base = agents();
  const runner = new FakeRunner(async (req) => {
    if (req.role === 'worker') {
      req.onLockWait?.(4_200);
      req.onTransientRetry?.({ attempt: 1, cause: 'rate_limit', waitMs: 60_000, detail: 'API Error: 429' });
    } else req.onLockWait?.(12); // too short to record
    return (await base.run(req)) as never;
  });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await c.idle();
  assert.deepEqual(f.log.read(0, ['run.lock_waited']).map((e) => e.payload), [{ issue: n, role: 'worker', model: 'sonnet', wait_ms: 4200 }]);
  assert.deepEqual(f.log.read(0, ['run.transient_retry']).map((e) => e.payload), [{ issue: n, role: 'worker', model: 'sonnet', attempt: 1, cause: 'rate_limit', wait_ms: 60000, detail: 'API Error: 429' }]);
});

// ---- instance settings

test("instance settings apply on the next tick, without a restart: they win over the repo's, and refused ones fall back to it", { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  let current: { settings: InstanceSettings; error: string | null } = { settings: { workers: 0 }, error: null };
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, settings: () => current });
  await c.tick();
  await c.idle();
  assert.equal(f.log.read(0, ['issue.claimed']).length, 0, 'workers 0 (the instance setting): nothing starts');
  assert.deepEqual(f.log.read(0, ['settings.applied']).map((e) => e.payload), [{ settings: { workers: 0 }, error: null }]);
  await c.tick();
  assert.equal(f.log.read(0, ['settings.applied']).length, 1, 'recorded once per change');
  current = { settings: {}, error: 'settings refused: workers 9 is outside 1-8 (machine limits)' };
  await c.tick();
  await c.idle();
  assert.equal(f.log.read(0, ['issue.claimed']).length, 1, "refused: the repo's worker count applies again");
  assert.match(String((f.log.read(0, ['settings.applied']).at(-1)!.payload as { error: string }).error), /refused/);
});

test('instance settings: a lower daily budget and run windows hold new work', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  let current: { settings: InstanceSettings; error: string | null } = { settings: { run_windows: [{ from: '08:00', to: '09:00' }] }, error: null };
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: agents(), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, settings: () => current, now: () => new Date(2026, 9, 10, 12, 0) });
  await c.tick();
  assert.equal(f.log.read(0, ['issue.claimed']).length, 0);
  assert.match((f.log.read(0, ['governor.hold']).at(-1)!.payload as { reason: string }).reason, /outside the run windows \(08:00-09:00\)/);
  f.log.append('run.cost', { issue: null, role: 'x', model: 'm', usd: 1, turns: 1 }, 'alice');
  current = { settings: { daily_budget_usd: 0.5 }, error: null };
  await c.tick();
  assert.equal(f.log.read(0, ['issue.claimed']).length, 0);
  assert.match((f.log.read(0, ['governor.hold']).at(-1)!.payload as { reason: string }).reason, /daily budget \$0\.5 reached/);
  current = { settings: {}, error: null };
  await c.tick();
  await c.idle();
  assert.equal(f.log.read(0, ['issue.claimed']).length, 1, "back to the repo's values: it starts");
});

// ---- the console

/** A worker that stays live, holding a console handle, until it's stopped or released. */
function liveWorker() {
  const sent: { id: string; text: string }[] = [];
  let finish!: (reason: 'succeeded' | 'stopped') => void;
  const done = new Promise<'succeeded' | 'stopped'>((r) => (finish = r));
  let req!: RunRequest;
  const runner = agents({});
  const fake = new FakeRunner(async (r) => {
    if (r.role !== 'worker') return (await runner.run(r)) as never;
    req = r;
    r.onControl?.({
      runId: 'run-w1',
      send: (id, text) => {
        sent.push({ id, text });
        r.onMessage?.({ id, state: 'queued' });
        return { queued: true };
      },
      stop: () => finish('stopped'),
    });
    const why = await done;
    if (why === 'stopped') return { reason: 'stopped', detail: 'killed: stopped' };
    return (await runner.run(r)) as never;
  });
  return { fake, sent, finish, deliver: (id: string) => req.onMessage?.({ id, state: 'delivered' }) };
}

const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), 'timed out');
};

test('console: the owner messages a live run; it is queued, then delivered, each an event; the live list follows', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const w = liveWorker();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: w.fake, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await waitFor(() => liveRuns(f.stateDir).some((r) => r.run === 'run-w1'));
  assert.deepEqual(liveRuns(f.stateDir).find((r) => r.run === 'run-w1')!.role, 'worker');
  sendMessage({ stateDir: f.stateDir, cfg: f.cfg, run: 'run-w1', text: 'Use the cents helper.', by: 'example-owner' });
  c.checkConsole();
  assert.deepEqual(w.sent.map((x) => x.text), ['Use the cents helper.']);
  const q = lastOf(f.log, 'console.message_queued') as { run: string; by: string; text: string; id: string };
  assert.deepEqual([q.run, q.by, q.text], ['run-w1', 'example-owner', 'Use the cents helper.']);
  assert.equal(liveRuns(f.stateDir)[0]!.pending.length, 1, 'shown as pending');
  w.deliver(q.id);
  assert.equal((lastOf(f.log, 'console.message_delivered') as { id: string }).id, q.id);
  assert.equal(liveRuns(f.stateDir)[0]!.pending.length, 0);
  w.finish('succeeded');
  await c.idle();
  assert.deepEqual(liveRuns(f.stateDir), [], 'gone once it ends');
});

test('console: the owner stops a live run; the task is blocked saying who stopped it', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const w = liveWorker();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: w.fake, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await waitFor(() => liveRuns(f.stateDir).length > 0);
  stopRun({ stateDir: f.stateDir, cfg: f.cfg, run: 'run-w1', by: 'example-owner' });
  c.checkConsole();
  await c.idle();
  assert.deepEqual(lastOf(f.log, 'console.run_stopped'), { run: 'run-w1', issue: n, role: 'worker', by: 'example-owner' });
  const issue = await f.backlog.get(n);
  assert.ok(issue.labels.includes('blocked'));
  assert.ok((await f.backlog.comments(n)).some((x) => /blocked: stopped by @example-owner from the console/.test(x.body)));
  assert.equal(f.log.read(0, ['change.proposed']).length, 0, 'nothing after the stop');
  assert.equal(git(f.repo, 'ls-remote', 'origin', claimRef(n)), '', 'claim released');
});

test("console: a request that isn't the owner's, or for a run that isn't live, is refused and recorded", { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const w = liveWorker();
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: w.fake, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  await c.tick();
  await waitFor(() => liveRuns(f.stateDir).length > 0);
  // Written past the library, as anything with write access to the state dir could.
  mkdirSync(join(f.stateDir, 'console', 'requests'), { recursive: true });
  writeFileSync(join(f.stateDir, 'console', 'requests', '1.json'), JSON.stringify({ v: 1, id: 'x1', at: '', by: 'mallory', run: 'run-w1', kind: 'stop' }));
  writeFileSync(join(f.stateDir, 'console', 'requests', '2.json'), JSON.stringify({ v: 1, id: 'x2', at: '', by: 'example-owner', run: 'run-gone', kind: 'message', text: 'hi' }));
  c.checkConsole();
  assert.deepEqual(f.log.read(0, ['console.request_refused']).map((e) => [(e.payload as { request: string }).request, (e.payload as { why: string }).why]), [
    ['x1', 'only the owner (@example-owner) may use the console'],
    ['x2', "run run-gone isn't live"],
  ]);
  assert.equal(f.log.read(0, ['console.run_stopped']).length, 0);
  w.finish('succeeded');
  await c.idle();
});

// ---- the dashboard chat

test('chat: a question from the dashboard is answered by a chief_of_staff turn; the answer is written, its cost counted, the turn recorded', { skip }, async () => {
  const f = fixture();
  f.log.append('issue.seen', { issue: 3, title: 'Totals', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, 'alice');
  const runner = new FakeRunner((req) => (req.role === 'chat' ? { structured: { answer: 'Issue #3 is waiting.', citations: [{ kind: 'issue', id: '3' }] }, costUsd: 0.2 } : {}));
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  const { id } = askChat({ stateDir: f.stateDir, question: 'what is waiting?', by: 'example-owner' });
  assert.equal(chatAnswer(f.stateDir, id)!.state, 'pending');
  await c.checkChat();
  const a = chatAnswer(f.stateDir, id)!;
  assert.equal(a.state, 'answered');
  const answered = a as { answer: { answer: string; citations: { href: string }[] } };
  assert.equal(answered.answer.answer, 'Issue #3 is waiting.');
  assert.deepEqual(answered.answer.citations.map((x) => x.href), [`https://github.com/${f.cfg.project.project.repo}/issues/3`]);
  assert.deepEqual(f.log.read(0, ['run.cost']).map((e) => [(e.payload as { role: string }).role, (e.payload as { usd: number }).usd]), [['chat', 0.2]]);
  assert.deepEqual(lastOf(f.log, 'chat.turn'), { id, by: 'example-owner', read_only: false, citations: 1, draft: 'none', actions: 0, cost_usd: 0.2, refused: null });
  const req = runner.calls[0]!;
  assert.deepEqual([req.role, req.allowedTools], ['chat', ['Read', 'Glob', 'Grep']]);
  assert.match(req.prompt, /Context files for instance alice: /);
});

test("chat: someone who isn't the owner gets a read-only answer; a spent budget or a disabled chat is refused", { skip }, async () => {
  const f = fixture();
  const runner = new FakeRunner((req) => (req.role === 'chat' ? { structured: { answer: 'here', citations: [], actions: [{ kind: 'pause' }] } } : {}));
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine });
  const other = askChat({ stateDir: f.stateDir, question: 'pause it all', by: 'collaborator' });
  await c.checkChat();
  const a = chatAnswer(f.stateDir, other.id)!;
  assert.ok(a.state === 'answered' && a.answer.readOnly && a.answer.actions.length === 0, JSON.stringify(a));
  f.log.append('run.cost', { issue: null, role: 'worker', model: 'm', usd: 1000, turns: 1 }, 'alice');
  const spent = askChat({ stateDir: f.stateDir, question: 'q', by: 'example-owner' });
  await c.checkChat();
  assert.deepEqual([chatAnswer(f.stateDir, spent.id)!.state, (chatAnswer(f.stateDir, spent.id) as { why: string }).why], ['refused', `the daily budget ($${f.cfg.agents.daily_budget_usd}) is spent`]);
  assert.equal(runner.calls.length, 1, 'no run for a refused question');
});

test('chat: a chat turn and a worker run on the same Claude login never overlap (the chat holds the login lock too)', { skip: (skip || process.platform === 'win32') && 'POSIX stand-in for claude' }, async () => {
  const f = fixture();
  f.cfg.tests.runner.changed = 'true';
  const dir = mkdtempSync(join(tmpdir(), 'claude-stub-'));
  const log = join(dir, 'runs.log');
  const bin = join(dir, 'claude');
  // A stand-in claude: logs when each run starts and ends (with its role), takes 400 ms, and answers per role.
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
${STDIN_LINE};
const role = process.env[${JSON.stringify(`${BRAND.envPrefix}_ROLE`)}];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, start: Date.now() }) + '\\n');
const end = Date.now() + 400; while (Date.now() < end) {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, end: Date.now() }) + '\\n');
const structured = role === 'chat' ? { answer: 'ok', citations: [] } : { summary: 'looked; changed nothing' };
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', structured_output: structured, num_turns: 1, total_cost_usd: 0.01 }));
`,
  );
  chmodSync(bin, 0o755);
  const runner = new CliRunner('cli', { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: join(dir, 'login') }, bin);
  f.backlog.open({ title: 'Look at totals', body: 'Check the totals.\n\n```done_when\n- command: |\n    true\n```\n', author: 'example-owner', labels: ['ready'] });
  const c = new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, maxAttempts: 2 });
  await c.tick(); // starts the worker
  await new Promise((r) => setTimeout(r, 100));
  askChat({ stateDir: f.stateDir, question: 'anything?', by: 'example-owner' });
  const chat = c.checkChat(); // asked while the worker runs
  await chat;
  await c.idle();
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { role: string; start?: number; end?: number });
  const spans: { role: string; start: number; end: number }[] = [];
  for (const l of lines) {
    if (l.start !== undefined) spans.push({ role: l.role, start: l.start, end: Infinity });
    else spans.filter((s) => s.role === l.role && s.end === Infinity).at(-1)!.end = l.end!;
  }
  assert.ok(spans.some((s) => s.role === 'chat') && spans.some((s) => s.role === 'worker'), JSON.stringify(spans));
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i]!.start >= sorted[i - 1]!.end, `overlap: ${JSON.stringify(sorted[i - 1])} and ${JSON.stringify(sorted[i])}`);
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
  const { duration_ms: _ms, ...probe } = verify.checks.find((x) => x.check.includes('PROJECT_PROBE')) as { check: string; duration_ms?: number };
  assert.deepEqual(probe, { check: 'test "$PROJECT_PROBE" = yes', status: 'pass', exitCode: 0 });
  assert.equal(f.log.read(0, ['coordinator.error']).length, 0, 'worktree setup saw the variable');
});
