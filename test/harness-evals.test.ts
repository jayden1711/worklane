import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload, EventType, StoredEvent } from '../src/events/types.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { BRAND } from '../src/brand.js';
import { BudgetRunner, runSuite, scratchConfig, type SuiteOptions } from '../src/harness-evals/replay.js';
import { harnessEvalDue } from '../src/harness-evals/schedule.js';
import { baselineFor, commentMarkdown, evalRuns, scoreReplay } from '../src/harness-evals/score.js';
import { engineRepo, HarnessTask, issueBody, loadSuite, PUBLIC_TASKS_DIR, readTasks, type LoadedTask } from '../src/harness-evals/tasks.js';
import { publicAllowed, taskFromPr } from '../src/harness-evals/add-task.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let id = 0;
const ev = (type: string, payload: object, ts = '2026-10-12T10:00:00.000Z') => ({ id: ++id, ts, type, payload, actor: 'test', source: 'coordinator' }) as unknown as StoredEvent;
const SHA = 'a'.repeat(40);
const checks = (status: 'pass' | 'fail') => [{ check: 'node --test test/price.test.js', status, exitCode: status === 'pass' ? 0 : 1 }];

test('the scorer: success is the done_when checks passing and the evaluator approving; cost is every run.cost; interventions are asks, blocks and holds', () => {
  const good = scoreReplay(
    [
      ev('run.cost', { issue: 1, role: 'worker', model: 'm', usd: 0.42, turns: 3 }),
      ev('check.result', { issue: 1, head: SHA, stage: 'verify', checks: checks('pass') }),
      ev('run.cost', { issue: 1, role: 'evaluator-verdict', model: 'm', usd: 0.18, turns: 1 }),
      ev('eval.verdict', { issue: 1, head: SHA, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '' }),
      ev('decision.asked', { id: 'd1', kind: 'land', issue: 1, owner: 'o', question: 'q', options: [], recommendation: 'approve', receipts: [] }),
    ],
    1,
  );
  assert.deepEqual({ ...good }, { success: true, doneWhen: true, verdict: true, outcome: 'asked', costUsd: 0.6, turns: 4, interventions: 1, detail: '' });

  const red = scoreReplay(
    [
      ev('check.result', { issue: 1, head: SHA, stage: 'verify', checks: checks('pass') }),
      ev('check.result', { issue: 1, head: SHA, stage: 'verify', checks: checks('fail') }),
      ev('issue.blocked', { issue: 1, owner: 'o', why: 'no passing change after 3 attempts' }),
      ev('run.cost', { issue: 1, role: 'worker', model: 'm', usd: 1, turns: 3 }),
    ],
    1,
  );
  assert.equal(red.success, false, 'the last verify decides');
  assert.equal(red.doneWhen, false);
  assert.equal(red.verdict, null);
  assert.equal(red.outcome, 'blocked');
  assert.equal(red.interventions, 1);
  assert.match(red.detail, /no passing change/);

  const rejected = scoreReplay([ev('check.result', { issue: 1, head: SHA, stage: 'verify', checks: checks('pass') }), ev('eval.verdict', { issue: 1, head: SHA, patch_hash: 'h', patch_correct: false, test_correct: true, confidence: 'high', advice: 'wrong file' }), ev('land.queued', { issue: 1, head: SHA, level: 'L1' })], 1);
  assert.equal(rejected.success, false, 'checks alone are not success: the evaluator must approve');
  assert.equal(rejected.outcome, 'queued');
  assert.match(rejected.detail, /evaluator: wrong file/);
});

const runEv = (rid: string, o: Partial<EventPayload<'harness_eval.run'>>, ts: string) => ev('harness_eval.run', { id: rid, trigger: 'change', engine: SHA, pr: null, tasks: 1, samples: 2, runs: 2, passed: 2, cost_usd: 2, wall_ms: 240_000, interventions: 0, budget_usd: 10, stopped: null, ...o }, ts);
const taskEv = (rid: string, task: string, ok: boolean, held = false) => ev('harness_eval.task', { run: rid, task, held_out: held, sample: 1, success: ok, done_when: ok, verdict: ok, outcome: ok ? 'queued' : 'blocked', cost_usd: 1, wall_ms: 120_000, interventions: ok ? 0 : 1, detail: '' });

test('the PR comment: this run beside the last finished baseline, with the change in each score; held-out tasks counted, never named', () => {
  const events = [
    taskEv('r1', 'repo-1', true),
    taskEv('r1', 'repo-1', true),
    runEv('r1', { engine: 'b'.repeat(40) }, '2026-10-01T03:00:00.000Z'),
    runEv('r-stopped', { passed: 0, runs: 1, stopped: 'budget' }, '2026-10-05T03:00:00.000Z'),
    taskEv('r2', 'repo-1', true),
    taskEv('r2', 'secret-task', false, true),
    runEv('r2', { passed: 1, cost_usd: 3, interventions: 1, pr: 7, turns: 30 }, '2026-10-08T03:00:00.000Z'),
  ];
  const runs = evalRuns(events);
  const cur = runs.find((r) => r.run.id === 'r2')!;
  const base = baselineFor(runs, 'r2');
  assert.equal(base?.run.id, 'r1', 'a run stopped by its budget is never the baseline');
  const md = commentMarkdown(cur, base, 'Brand');
  assert.match(md, /1\/2 replays passed/);
  assert.match(md, /baseline \(`bbbbbbbb`, 2026-10-01\)/);
  assert.match(md, /\| success rate \| 50% \| 100% \| −50% \(worse\) \|/);
  assert.match(md, /\| cost per replay \| \$1\.50 \| \$1\.00 \| \+\$0\.50 \(worse\) \|/);
  assert.match(md, /\| human interventions per replay \| 0\.50 \| 0\.00 \| \+0\.50 \(worse\) \|/);
  assert.match(md, /\| turns per replay \| 15\.0 \| – \| – \|/, 'a baseline recorded before turns were counted has none to compare');
  const withTurns = evalRuns([...events, runEv('r3', { turns: 40 }, '2026-10-09T03:00:00.000Z')]);
  assert.match(commentMarkdown(withTurns.at(-1)!, baselineFor(withTurns, 'r3'), 'Brand'), /\| turns per replay \| 20\.0 \| 15\.0 \| \+5\.0 \(worse\) \|/);
  assert.match(md, /\| repo-1 \| 1\/1 \|/);
  assert.doesNotMatch(md, /secret-task/);
  assert.match(md, /Held-out tasks \(private, not named\): 0\/1/);
  assert.match(commentMarkdown(runs[0]!, null, 'Brand'), /No baseline yet/);
});

test('schedule: in the nightly window, at most once a day; a change to src/ first, else weekly; the first run is weekly', () => {
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0);
  const o = { at: '02:00', weekly: true, onChange: true, lastRunDay: null, lastWeekly: null, lastEngine: null, engine: 'b'.repeat(40), changed: () => true };
  assert.equal(harnessEvalDue({ ...o, now: at(12, 1) }), null, 'before the nightly time');
  assert.equal(harnessEvalDue({ ...o, now: at(12, 3) }), 'weekly', 'first run: weekly (a change needs a run to compare with)');
  const after = { ...o, lastWeekly: at(12, 3).toISOString(), lastEngine: SHA };
  assert.equal(harnessEvalDue({ ...after, now: at(12, 4), lastRunDay: '2026-10-12' }), null, 'once a day');
  assert.equal(harnessEvalDue({ ...after, now: at(13, 3), lastRunDay: '2026-10-12' }), 'change');
  assert.equal(harnessEvalDue({ ...after, now: at(13, 3), lastRunDay: '2026-10-12', changed: () => false }), null, 'src/ unchanged, and the week is not up');
  assert.equal(harnessEvalDue({ ...after, now: at(19, 3), lastRunDay: '2026-10-18', changed: () => false }), 'weekly');
  assert.equal(harnessEvalDue({ ...after, now: at(13, 3), lastRunDay: '2026-10-12', onChange: false }), null);
  assert.equal(harnessEvalDue({ ...after, now: at(19, 3), lastRunDay: '2026-10-18', changed: () => false, weekly: false }), null);
});

/** A seed repository from the example project, and a past task on it: negative quantities counted in totals. */
function seedRepo() {
  const base = mkdtempSync(join(tmpdir(), 'harness-eval-'));
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const task: LoadedTask = {
    ...HarnessTask.parse({ id: 'example-1', repo: 'example/shop', base: git(seed, 'rev-parse', 'HEAD'), title: 'Totals count negative quantities', body: 'totalCents() adds items with qty <= 0.', done_when: [{ test: 'test/price.test.js' }], outcome: { pr: 1, merge: SHA } }),
    heldOut: false,
    file: 'x',
  };
  const work = join(base, 'work');
  mkdirSync(work);
  return { base, seed, task, work };
}

/**
 * Agents for the example task: the worker fixes it, the evaluator approves what it read. `turns`: what each run
 * reports (the stand-in's turn counts); `onWorker` sees the worker's workspace before it changes anything.
 */
function agents(o: { fix?: boolean; turns?: { worker: number; evaluator: number }; onWorker?: (req: RunRequest) => void } = {}) {
  return new FakeRunner((req: RunRequest) => {
    if (req.role === 'evaluator-verdict') {
      const b = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)?.[1];
      const files_reviewed = b ? git(req.cwd, 'diff', '--name-only', `${b}..HEAD`).split('\n').filter(Boolean) : [];
      return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed }, costUsd: 0.18, ...(o.turns ? { turns: o.turns.evaluator } : {}) };
    }
    o.onWorker?.(req);
    if (o.fix !== false) {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      git(req.cwd, 'add', '-A');
      // As a real agent session commits: with the harness identity its environment sets.
      if (git(req.cwd, 'status', '--porcelain')) git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Ignore non-positive quantities');
    }
    return { structured: { summary: 'Guarded qty.' }, costUsd: 0.42, ...(o.turns ? { turns: o.turns.worker } : {}) };
  });
}

function suite(s: ReturnType<typeof seedRepo>, runner: FakeRunner, o: Partial<SuiteOptions> = {}) {
  const events: { type: EventType; payload: unknown }[] = [];
  const opts: SuiteOptions = { tasks: [s.task], samples: 1, budgetUsd: 10, runner, trigger: 'manual', engine: SHA, pr: null, workDir: s.work, source: () => s.seed, emit: (type, payload) => void events.push({ type, payload }), ...o };
  return { events, run: () => runSuite(opts), of: <T extends EventType>(t: T) => events.filter((e) => e.type === t).map((e) => e.payload as EventPayload<T>) };
}

test('a replay goes through the real coordinator in a scratch instance at the base commit, is scored from its own log, and its scratch clone is deleted', async () => {
  const s = seedRepo();
  const runner = agents();
  const t = suite(s, runner);
  const run = await t.run();
  const [task] = t.of('harness_eval.task');
  assert.equal(task?.success, true, task?.detail);
  assert.equal(task?.done_when, true);
  assert.equal(task?.verdict, true);
  assert.equal(task?.cost_usd, 0.6);
  assert.ok(['queued', 'asked'].includes(task!.outcome));
  assert.deepEqual([run.runs, run.passed, run.cost_usd, run.stopped], [1, 1, 0.6, null]);
  assert.deepEqual(t.of('run.cost').map((c) => [c.role, c.usd]), [['harness-eval', 0.6]], "the spend counts toward the instance's daily budget");
  const worker = runner.calls.find((c) => c.role !== 'evaluator-verdict')!;
  assert.match(worker.prompt, /Totals count negative quantities/);
  assert.doesNotMatch(worker.prompt, new RegExp(SHA), 'the merged outcome is never shown to the agents');
  assert.deepEqual(readdirSync(s.work), [], 'scratch clone deleted');
  assert.equal(git(s.seed, 'log', '--oneline').split('\n').length, 1, 'nothing pushed to the source');
});

test('the budget stops the run: every agent run is capped at what is left, and once it is spent nothing more starts', async () => {
  const s = seedRepo();
  const runner = agents();
  const t = suite(s, runner, { samples: 3, budgetUsd: 1 });
  const run = await t.run();
  assert.equal(run.stopped, 'budget');
  assert.ok(run.runs < 3, `stopped before the third replay (${run.runs} ran)`);
  assert.ok(run.cost_usd <= 1.1, `spent ${run.cost_usd}`);
  // The second replay's worker ran with only what was left of the dollar after the first (0.6 spent).
  const caps = runner.calls.map((c) => c.maxBudgetUsd);
  assert.ok(caps.every((c) => c <= 1), `caps ${caps.join(', ')}`);
  assert.ok(caps.some((c) => Math.abs(c - 0.4) < 1e-9), `a run was capped at the $0.40 left: ${caps.join(', ')}`);
  const b = new BudgetRunner(new FakeRunner(() => ({ costUsd: 5 })), 1);
  await b.run({ role: 'worker', prompt: '', cwd: '.', model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 5, stallMs: 1, timeoutMs: 1 });
  const refused = await b.run({ role: 'worker', prompt: '', cwd: '.', model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 5, stallMs: 1, timeoutMs: 1 });
  assert.equal(refused.reason, 'budget_exhausted');
});

test("a replay's score counts the turns its agents reported (not 0), per replay, in its spend and in the run's total", async () => {
  const s = seedRepo();
  const runner = agents({ turns: { worker: 7, evaluator: 2 } });
  const t = suite(s, runner);
  const run = await t.run();
  const reported = runner.calls.reduce((n, c) => n + (c.role === 'evaluator-verdict' ? 2 : 7), 0);
  assert.ok(reported >= 9, `a worker and an evaluator ran (${runner.calls.map((c) => c.role).join(', ')})`);
  const [task] = t.of('harness_eval.task');
  assert.equal(task?.success, true, task?.detail);
  assert.equal(task?.turns, reported, "the replay's turns are its agents' reported turns");
  assert.equal(run.turns, reported, "the run's total");
  assert.deepEqual(t.of('run.cost').map((c) => [c.role, c.turns]), [['harness-eval', reported]], 'the spend recorded with its turns');
});

/** A checkout of the harness under test: its own principles, and project history that must never reach a replay. */
function harnessUnderTest(o: { principles?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-head-'));
  const dir = join(root, BRAND.configDir);
  mkdirSync(join(dir, 'lessons'), { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), 'project: { name: head }\n');
  writeFileSync(join(dir, 'lessons', 'from-the-merged-fix.md'), 'qty <= 0 is guarded in price.js\n');
  if (o.principles !== false) {
    mkdirSync(join(dir, 'principles', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'principles', 'fail-closed.md'), '# fail-closed\nA missing input refuses.\n');
    writeFileSync(join(dir, 'principles', 'nested', 'index.md'), 'fail-closed: refuse on missing input\n');
  }
  return root;
}

/** The seed's base with principles of its own (the task's era), as a task's base commit. */
function withOwnPrinciples(s: ReturnType<typeof seedRepo>) {
  const dir = join(s.seed, BRAND.configDir, 'principles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task-era.md'), '# task-era\nan older rule\n');
  git(s.seed, 'add', '-A');
  git(s.seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'principles of its era');
  return { ...s, task: { ...s.task, base: git(s.seed, 'rev-parse', 'HEAD') } };
}

test("a replay runs with the harness under test's principles in place of the task's own, at the task's base; the task's repo is otherwise unchanged and nothing else of the present comes in", async () => {
  const s = withOwnPrinciples(seedRepo());
  const head = harnessUnderTest();
  const seen: Record<string, unknown>[] = [];
  const runner = agents({
    onWorker: (req) => {
      const cfg = join(req.cwd, BRAND.configDir);
      seen.push({
        principle: readFileSync(join(cfg, 'principles', 'fail-closed.md'), 'utf8'),
        nested: readFileSync(join(cfg, 'principles', 'nested', 'index.md'), 'utf8'),
        committed: git(req.cwd, 'show', `HEAD:${BRAND.configDir}/principles/fail-closed.md`),
        taskEra: existsSync(join(cfg, 'principles', 'task-era.md')),
        lessons: existsSync(join(cfg, 'lessons', 'from-the-merged-fix.md')),
        parent: git(req.cwd, 'rev-parse', 'HEAD~1'),
        outsideConfig: git(req.cwd, 'diff', '--name-only', s.task.base, 'HEAD', '--', '.', `:!${BRAND.configDir}`),
        config: git(req.cwd, 'diff', '--name-only', s.task.base, 'HEAD', '--', BRAND.configDir).split('\n').filter(Boolean).sort(),
      });
    },
  });
  const t = suite(s, runner, { harnessConfig: head });
  await t.run();
  const [task] = t.of('harness_eval.task');
  assert.equal(task?.success, true, task?.detail);
  assert.ok(seen.length >= 1, 'the worker ran');
  const w = seen[0]!;
  assert.equal(w.principle, '# fail-closed\nA missing input refuses.\n', "the harness under test's principle is in the replay's workspace");
  assert.equal(w.nested, 'fail-closed: refuse on missing input\n');
  assert.equal(w.committed, '# fail-closed\nA missing input refuses.', 'committed on the default branch the agents start from, not just on disk');
  assert.equal(w.taskEra, false, "the task's own principles are replaced, not merged: the replay sees exactly the harness under test's");
  assert.equal(w.lessons, false, "only harness config comes in: the present's lessons (which may describe the task's fix) never do");
  assert.equal(w.parent, s.task.base, "the scratch config commit sits directly on the task's base: no later history");
  assert.equal(w.outsideConfig, '', "the task's repo content outside the config folder is the base's, unchanged");
  const cfgChanged = (w.config as string[]).map((f) => f.slice(BRAND.configDir.length + 1));
  assert.deepEqual(cfgChanged.filter((f) => f.startsWith('principles/')), ['principles/fail-closed.md', 'principles/nested/index.md', 'principles/task-era.md']);
  assert.deepEqual(cfgChanged.filter((f) => !f.startsWith('principles/') && !['config.yaml', 'tests.yaml', 'agents.yaml'].includes(f)), [], 'in the config folder only the scratch config and the principles differ from the base');
  assert.equal(readFileSync(join(head, BRAND.configDir, 'principles', 'fail-closed.md'), 'utf8'), '# fail-closed\nA missing input refuses.\n', 'the harness checkout is only read');
});

test('a harness under test without principles: the replay runs with none (base and head compare like for like); one that is not a project, or holds a link, refuses the run before any replay or agent', async () => {
  const s = withOwnPrinciples(seedRepo());
  let taskEra: boolean | null = null;
  const t = suite(s, agents({ onWorker: (req) => void (taskEra = existsSync(join(req.cwd, BRAND.configDir, 'principles', 'task-era.md'))) }), { harnessConfig: harnessUnderTest({ principles: false }) });
  await t.run();
  assert.equal(taskEra, false, "the task's own principles are not what is under test");

  const none = mkdtempSync(join(tmpdir(), 'harness-none-'));
  const r1 = agents();
  const t1 = suite(s, r1, { harnessConfig: none });
  const run1 = await t1.run();
  assert.match(run1.error ?? '', /has no \S+ folder/);
  assert.equal(run1.runs, 0);
  assert.equal(t1.of('harness_eval.task').length, 0, 'no replay');
  assert.equal(r1.calls.length, 0, 'no agent ran');

  const linked = harnessUnderTest();
  const outside = mkdtempSync(join(tmpdir(), 'harness-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'not harness config\n');
  symlinkSync(join(outside, 'secret.txt'), join(linked, BRAND.configDir, 'principles', 'linked.md'));
  const r2 = agents();
  const t2 = suite(s, r2, { harnessConfig: linked });
  const run2 = await t2.run();
  assert.match(run2.error ?? '', /principles\/linked\.md .* not a regular file/);
  assert.equal(t2.of('harness_eval.task').length, 0, 'no replay');
  assert.equal(r2.calls.length, 0, 'no agent ran');
});

function coordinatorFixture(enabled: boolean, replay = false) {
  const base = mkdtempSync(join(tmpdir(), 'harness-eval-coord-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  const commit = (msg: string) => git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg);
  git(seed, 'add', '-A');
  commit('init');
  const before = git(seed, 'rev-parse', 'HEAD');
  commit('Merge #7: a harness change');
  const engine = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  const cfg = loadConfig(repo);
  cfg.project.project.repo = engineRepo()!;
  cfg.project.harness_evals = { enabled, weekly: true, on_change: true, budget_usd: 5, samples: 2 };
  cfg.tests.nightly_at = '02:00';
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  for (let i = 0; i < 7; i++) backlog.open({ title: `t${i}`, body: 'x', author: 'example-owner' });
  const log = new EventLog(join(base, 'events.db'));
  const calls: SuiteOptions[] = [];
  // Two days on, in the nightly window: the baseline the test records now is from another day.
  const later = new Date(Date.now() + 2 * 86_400_000);
  later.setHours(3, 0, 0, 0);
  const fakeSuite = async (o: SuiteOptions) => {
    calls.push(o);
    o.emit('harness_eval.task', { run: 'r2', task: 'repo-1', held_out: false, sample: 1, success: false, done_when: false, verdict: null, outcome: 'blocked', cost_usd: 1, wall_ms: 60_000, interventions: 1, detail: '' });
    const run: EventPayload<'harness_eval.run'> = { id: 'r2', trigger: o.trigger, engine: o.engine, pr: o.pr, tasks: 1, samples: 1, runs: 1, passed: 0, cost_usd: 1, wall_ms: 60_000, interventions: 1, budget_usd: o.budgetUsd, stopped: null };
    o.emit('harness_eval.run', run);
    return run;
  };
  const c = new Coordinator({ cfg, log, backlog, runner: new FakeRunner(() => ({})), repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, now: () => later, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) }, harnessEvals: { ...(replay ? { replay: true as const } : {}), suite: fakeSuite, engine: () => engine, changed: () => true } });
  return { c, log, backlog, calls, before, engine };
}

test('disabled (the default): nothing runs, nothing is recorded', async () => {
  const f = coordinatorFixture(false);
  await f.c.checkHarnessEvals();
  await f.c.idle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.log.read(0, ['harness_eval.run', 'harness_eval.task', 'harness_eval.commented']).length, 0);
  assert.equal(loadConfig(join(repoRoot, 'examples', 'basic')).project.harness_evals.enabled, false, 'off by default');
});

test('on a change to src/: the coordinator runs the suite within its budget and posts the scores on the PR whose merge it is, against the baseline', async () => {
  const f = coordinatorFixture(true);
  // The baseline: a weekly run on the engine before the change.
  f.log.append('harness_eval.task', { run: 'r1', task: 'repo-1', held_out: false, sample: 1, success: true, done_when: true, verdict: true, outcome: 'queued', cost_usd: 0.5, wall_ms: 60_000, interventions: 0, detail: '' }, 'alice');
  f.log.append('harness_eval.run', { id: 'r1', trigger: 'weekly', engine: f.before, pr: null, tasks: 1, samples: 1, runs: 1, passed: 1, cost_usd: 0.5, wall_ms: 60_000, interventions: 0, budget_usd: 5, stopped: null }, 'alice');
  await f.c.checkHarnessEvals();
  await f.c.idle();
  assert.equal(f.calls.length, 1, 'one run started');
  const o = f.calls[0]!;
  assert.equal(o.trigger, 'change');
  assert.equal(o.engine, f.engine);
  assert.equal(o.pr, 7);
  assert.equal(o.samples, 2);
  assert.equal(o.budgetUsd, 5);
  const comments = await f.backlog.comments(7);
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /0\/1 replays passed/);
  assert.match(comments[0]!.body, /\| success rate \| 0% \| 100% \| −100% \(worse\) \|/);
  assert.deepEqual(f.log.read(0, ['harness_eval.commented']).map((e) => e.payload), [{ run: 'r2', pr: 7, baseline: 'r1' }]);
  // Once a day: a second check the same day starts nothing.
  await f.c.checkHarnessEvals();
  await f.c.idle();
  assert.equal(f.calls.length, 1);
});

test('the scratch config turns off everything scheduled, paid or networked beyond the agents, whatever the base enabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-cfg-'));
  cpSync(join(repoRoot, 'examples', 'basic'), root, { recursive: true });
  const dir = join(root, BRAND.configDir);
  const add = (file: string, text: string) => writeFileSync(join(dir, file), `${readFileSync(join(dir, file), 'utf8')}\n${text}\n`);
  add('config.yaml', 'gardener: { enabled: true }\nharness_evals: { enabled: true }\noptimize: { enabled: true }\nchecks_from_feedback: { enabled: true }');
  add('tests.yaml', 'nightly_at: "02:00"\npreview: { enabled: false }');
  const before = loadConfig(root);
  assert.deepEqual([before.project.gardener.enabled, before.project.harness_evals.enabled, before.project.optimize.enabled, before.project.checks_from_feedback.enabled], [true, true, true, true]);
  scratchConfig(root, 2);
  const cfg = loadConfig(root);
  assert.deepEqual([cfg.project.gardener.enabled, cfg.project.harness_evals.enabled, cfg.project.optimize.enabled, cfg.project.checks_from_feedback.enabled], [false, false, false, false]);
  assert.deepEqual([cfg.project.backlog, cfg.project.land_mode, cfg.tests.nightly_at, cfg.tests.preview, cfg.tests.test_run], ['file', 'direct', undefined, undefined, undefined]);
  assert.ok(cfg.agents.daily_budget_usd <= 2);
});

test("a replay's scratch coordinator never runs harness evals itself, even with them on in its config (no recursion)", async () => {
  const f = coordinatorFixture(true, true);
  await f.c.checkHarnessEvals();
  await f.c.idle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.log.read(0, ['harness_eval.run']).length, 0);
});

test('templates/evals/tasks holds only tasks from the engine\'s own (public) repository; private tasks go to the held-out store', () => {
  const own = engineRepo();
  assert.ok(own, 'the engine names its repository in package.json');
  const tasks = readTasks(PUBLIC_TASKS_DIR, false);
  assert.ok(tasks.length >= 5, `${tasks.length} public tasks`);
  for (const t of tasks) {
    assert.equal(t.repo, own, `${t.file}: a task from ${t.repo} in the public suite`);
    assert.equal(t.outcome.pr > 0, true);
    assert.equal('repo' in parseYaml(readFileSync(t.file, 'utf8')), false, `${t.file}: a public task names no repository`);
  }
  // A public task file that names a repository (any, even the engine's own) is refused: it can't come from elsewhere.
  const pubDir = mkdtempSync(join(tmpdir(), 'pub-'));
  writeFileSync(join(pubDir, 'x.yaml'), `repo: someone/private-app\n${readFileSync(tasks[0]!.file, 'utf8')}`);
  assert.throws(() => readTasks(pubDir, false), /a public task names no repo/);
  // Writing a public task is refused for any other repository, and for the engine's own while it is private.
  const gh = (priv: boolean) => (args: string[]) => (args[0] === 'api' ? String(priv) : '');
  assert.deepEqual(publicAllowed('someone/private-app', gh(false), own), { ok: false, why: `someone/private-app is not the engine's own repository (${own}); its tasks stay in the held-out store` });
  assert.deepEqual(publicAllowed(own!, gh(true), own), { ok: false, why: `${own} is not public` });
  assert.deepEqual(publicAllowed(own!, gh(false), own), { ok: true });
  // The suite reads the held-out store too, and never lets an id appear twice.
  const held = mkdtempSync(join(tmpdir(), 'held-'));
  writeFileSync(join(held, 'private-1.yaml'), readFileSync(tasks[0]!.file, 'utf8').replace(/^id: .*$/m, 'id: private-1\nrepo: someone/private-app'));
  const s = loadSuite({ publicDirs: [PUBLIC_TASKS_DIR], heldOutDir: held });
  assert.deepEqual(s.tasks.filter((t) => t.heldOut).map((t) => t.id), ['private-1']);
  writeFileSync(join(held, 'dup.yaml'), `repo: someone/private-app\n${readFileSync(tasks[0]!.file, 'utf8')}`);
  assert.throws(() => loadSuite({ publicDirs: [PUBLIC_TASKS_DIR], heldOutDir: held }), /two tasks have the id/);
});

test('a task from a merged PR: its merge parent, its closing issue and done_when (or the PR\'s test files); the issue text never carries the outcome', () => {
  const merge = 'c'.repeat(40);
  const gh = (args: string[]) => {
    if (args[0] === 'pr') return JSON.stringify({ title: 'Fix totals', body: 'Closes #3\n\nIt was wrong.', state: 'MERGED', mergeCommit: { oid: merge }, files: [{ path: 'src/price.js' }, { path: 'test/helpers.ts' }, { path: 'test/price.test.ts' }], closingIssuesReferences: [], labels: [] });
    if (args[0] === 'api') return JSON.stringify({ parents: [{ sha: SHA }] });
    throw new Error(args.join(' '));
  };
  const t = taskFromPr('example/shop', 12, { gh });
  assert.equal(t.base, SHA);
  assert.deepEqual(t.done_when, [{ test: 'test/price.test.ts' }], 'a helper beside the tests is not a test');
  assert.deepEqual(t.outcome, { pr: 12, merge });
  assert.match(issueBody(t), /```done_when\n- test: test\/price\.test\.ts\n```/);
  assert.doesNotMatch(issueBody(t), new RegExp(merge));
});
