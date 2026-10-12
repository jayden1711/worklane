// Stage labels wired in: before the weekly report the coordinator labels the week's failed worker runs (code first,
// then capped judge calls that count against the daily budget), records each as run.stage_labeled, and the report
// groups them by stage and instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventSchemas, type EventPayload, type StoredEvent } from '../src/events/types.js';
import { buildReport } from '../src/reports.js';
import { RUNS_DIR, type RunRecord, type RunStep } from '../src/run-record.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { doneWhenCommands } from '../src/stage-label.js';
import { asFailedRun, labelWeek, STAGE_JUDGE_MAX, STAGE_JUDGE_USD, unlabelledFailures } from '../src/coordinator/stage-labels.js';
import { coordinator, fixture } from './repro-state-graph/harness.js';

const T0 = Date.parse('2026-10-05T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let id = 0;
const ev = (s: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: at(s), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });
const step = (what: string, status: RunStep['status'] = 'error'): RunStep => ({ kind: 'command', tool: 'Bash', what, status, exitCode: status === 'ok' ? 0 : 1, output: '' });
const record = (runId: string, issue: number, s: number, e: number, steps: RunStep[]): RunRecord => ({ v: 1, id: runId, issue, role: 'worker', model: 'm', startedAt: at(s), endedAt: at(e), reason: 'succeeded', costUsd: 0, turns: 0, steps, files: ['src/a.js'], otherTools: 0, final: 'done', truncated: false });

/** A worker attempt on `issue` from `s` to `s + 300`, whose checks then failed; `extra` events land inside it. */
function failedAttempt(issue: number, s: number, extra: StoredEvent[] = []): StoredEvent[] {
  return [
    ev(s, 'run.started', { issue, role: 'worker', model: 'm', worktree: `/w/issue-${issue}`, pid: 1, pgid: 1, attempt: 1 }),
    ...extra,
    ev(s + 300, 'run.finished', { issue, role: 'worker', reason: 'succeeded', detail: 'done' }),
    ev(s + 310, 'change.proposed', { issue, base: 'b'.repeat(40), head: 'c'.repeat(40), files: ['src/a.js'], patch_hash: 'h' }),
    ev(s + 320, 'check.result', { issue, head: 'c'.repeat(40), stage: 'verify', checks: [{ check: 'npm test', status: 'fail', seconds: 1 }] }),
  ];
}

const week = { since: new Date(T0 - 86_400_000), until: new Date(T0 + 86_400_000) };

/** A judge that answers per run id and records each call. */
function judge(answers: Record<string, unknown>) {
  return new FakeRunner((req: RunRequest) => {
    const run = /Run (\S+) \(/.exec(req.prompt)![1]!;
    return { structured: answers[run], costUsd: 0.03 };
  });
}

test("done_when as command lines: commands, test files, the project's suite; manual and repro run nothing", () => {
  assert.deepEqual(doneWhenCommands([{ command: 'npm run typecheck' }, { test: 'test/a.test.js' }, { suite: 'full' }, { suite: 'changed' }, { manual: 'look at it' }, { repro: true }], { changed: 'npm run test:changed', full: 'npm test' }), ['npm run typecheck', 'test/a.test.js', 'npm test', 'npm run test:changed']);
});

test("the week's failed worker runs with a record and no label; each with its own events, commands and steps", () => {
  const events = [
    ...failedAttempt(1, 0, [ev(100, 'run.transient_retry', { issue: 1, role: 'worker', model: 'm', attempt: 1, cause: 'network', wait_ms: 1, detail: 'x' })]),
    ...failedAttempt(2, 1000),
    ...failedAttempt(3, 2000),
    ev(2500, 'run.stage_labeled', { run: 'r3', issue: 3, role: 'worker', instance: 'alice', stage: 'wrong files', reason: 'x', by: 'judge' }),
    ...failedAttempt(4, 3000), // no run record: nothing to show the labeller
  ];
  const records = [record('r1', 1, 0, 300, [step('npm test')]), record('r2', 2, 1000, 1300, [step('git status', 'ok')]), record('r3', 3, 2000, 2300, [])];
  const got = unlabelledFailures(events, records, week.since, week.until);
  assert.deepEqual(got.map((g) => g.record.id), ['r1', 'r2']);
  const f = asFailedRun(got[0]!.run, got[0]!.record, events, ['npm test']);
  assert.ok(f.events.includes('run.transient_retry'));
  assert.deepEqual(f.commands, ['npm test']);
  assert.match(f.steps, /\$ npm test: error \(exit 1\)/);
  assert.equal(f.ended, 'checks failed');
  assert.ok(!asFailedRun(got[1]!.run, got[1]!.record, events, []).events.includes('run.transient_retry'), "another run's events stay out");
});

test('labelWeek: code labels with no judge call, judge calls for the rest, each label an event and each call a cost', async () => {
  const events = [...failedAttempt(1, 0, [ev(100, 'run.transient_retry', { issue: 1, role: 'worker', model: 'm', attempt: 1, cause: 'network', wait_ms: 1, detail: 'x' })]), ...failedAttempt(2, 1000), ...failedAttempt(3, 2000)];
  const records = [record('r1', 1, 0, 300, [step('npm test')]), record('r2', 2, 1000, 1300, [step('git status', 'ok')]), record('r3', 3, 2000, 2300, [step('npm test')])];
  const runner = judge({ r3: { stage: 'verification', reason: 'npm test failed and it said it passed' } });
  const out: [string, unknown][] = [];
  const n = await labelWeek({ events, records, ...week, instance: 'alice', runner, cwd: '/tmp', doneWhenOf: async () => ['npm test'], spentToday: () => 0, dailyBudgetUsd: 10, emit: (type, payload) => out.push([type, payload]) });
  assert.equal(n, 3);
  assert.equal(runner.calls.length, 1, 'only r3 needed the judge');
  const labels = out.filter(([t]) => t === 'run.stage_labeled').map(([, p]) => p as EventPayload<'run.stage_labeled'>);
  assert.deepEqual(labels.map((l) => [l.run, l.stage, l.by]), [['r1', 'environment/harness', 'code'], ['r2', 'verification', 'code'], ['r3', 'verification', 'judge']]);
  for (const l of labels) assert.ok(EventSchemas['run.stage_labeled'].safeParse(l).success);
  assert.deepEqual(out.filter(([t]) => t === 'run.cost').map(([, p]) => p), [{ issue: 3, role: 'stage-judge', model: 'sonnet', usd: 0.03, turns: 0 }]);
});

test('labelWeek: no judge call without the daily budget left for one, and at most STAGE_JUDGE_MAX per report; code labels still apply', async () => {
  const events: StoredEvent[] = [];
  const records: RunRecord[] = [];
  for (let i = 0; i < STAGE_JUDGE_MAX + 3; i++) {
    events.push(...failedAttempt(10 + i, i * 1000));
    records.push(record(`j${i}`, 10 + i, i * 1000, i * 1000 + 300, [step('npm test')]));
  }
  const answers = Object.fromEntries(records.map((r) => [r.id, { stage: 'wrong files', reason: 'x' }]));
  const capped = judge(answers);
  const out: string[] = [];
  await labelWeek({ events, records, ...week, instance: 'alice', runner: capped, cwd: '/tmp', doneWhenOf: async () => ['npm test'], spentToday: () => 0, dailyBudgetUsd: 100, emit: (t) => out.push(t) });
  assert.equal(capped.calls.length, STAGE_JUDGE_MAX);
  const broke = judge(answers);
  const out2: [string, unknown][] = [];
  // The budget has less than one judge call left: the runs that need the judge wait; one that ran nothing is labelled in code.
  events.push(...failedAttempt(99, 50_000));
  records.push(record('k1', 99, 50_000, 50_300, [step('git status', 'ok')]));
  await labelWeek({ events, records, ...week, instance: 'alice', runner: broke, cwd: '/tmp', doneWhenOf: async () => ['npm test'], spentToday: () => 10 - STAGE_JUDGE_USD / 2, dailyBudgetUsd: 10, emit: (type, payload) => out2.push([type, payload]) });
  assert.equal(broke.calls.length, 0);
  assert.deepEqual(out2.map(([t, p]) => [t, (p as { run?: string }).run]), [['run.stage_labeled', 'k1']]);
});

test('the weekly report groups the labels by stage and instance; without labels the section is left out', () => {
  const f = fixture();
  const events = [
    ev(0, 'run.stage_labeled', { run: 'r1', issue: 1, role: 'worker', instance: 'alice', stage: 'wrong files', reason: 'edited the client, the bug is in the server', by: 'judge' }),
    ev(1, 'run.stage_labeled', { run: 'r2', issue: 2, role: 'worker', instance: 'alice', stage: 'verification', reason: "the run didn't run any of the issue's done_when commands", by: 'code' }),
  ];
  const md = buildReport(events, f.cfg, { since: new Date(T0 - 3600_000), now: new Date(T0 + 3600_000), weekly: true }).markdown;
  assert.match(md, /Where failed runs first went wrong, last 7 days\*\* \(2 labelled\)/);
  assert.match(md, /- wrong files: 1 \(alice 1\)/);
  assert.match(md, /\/runs\/r1: edited the client/);
  assert.doesNotMatch(buildReport([], f.cfg, { since: new Date(T0 - 3600_000), now: new Date(T0 + 3600_000), weekly: true }).markdown, /Where failed runs first went wrong/);
});

test('the coordinator labels before the Monday report: events recorded, the judge counted as spend, the section posted; once per run', async () => {
  const f = fixture();
  f.cfg.project.reports.times = ['00:00'];
  const n = f.backlog.open({ title: 'Add a.js', body: 'Add a.js.\n\n```done_when\n- command: npm run check-a\n```\n', author: 'example-owner', labels: ['ready'] });
  const m = f.backlog.open({ title: 'Add b.js', body: 'Add b.js.\n\n```done_when\n- command: npm run check-b\n```\n', author: 'example-owner', labels: ['ready'] });
  // Two failed worker attempts, as the coordinator records them, with their run records.
  const seed = (issue: number, runId: string, steps: RunStep[]) => {
    f.log.append('run.started', { issue, role: 'worker', model: 'm', worktree: `/w/issue-${issue}`, pid: 1, pgid: 1, attempt: 1 }, 'c', 'coordinator');
    f.log.append('run.finished', { issue, role: 'worker', reason: 'succeeded', detail: 'done' }, 'c', 'coordinator');
    f.log.append('change.rejected', { issue, why: 'the change edits a frozen test' }, 'c', 'coordinator');
    mkdirSync(join(f.stateDir, RUNS_DIR), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(f.stateDir, RUNS_DIR, `${runId}.json`), JSON.stringify({ ...record(runId, issue, 0, 0, steps), startedAt: now, endedAt: now }));
  };
  seed(n, 'ra', [step('npm run check-a')]);
  seed(m, 'rb', [step('ls', 'ok')]);
  const runner = new FakeRunner((req) => (req.role === 'stage-judge' ? { structured: { stage: 'wrong or incomplete change', reason: 'check-a still fails on the same case' }, costUsd: 0.04 } : {}));
  const c = coordinator(f, runner);
  // The first Monday noon after now, so the runs seeded just now fall inside its 7-day window (on a Monday
  // morning that's today, not next week).
  const monday = new Date();
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7));
  if (monday.getTime() <= Date.now()) monday.setDate(monday.getDate() + 7);
  await c.maybeReport(monday);
  const labels = f.log.read(0, ['run.stage_labeled']).map((e) => e.payload as EventPayload<'run.stage_labeled'>);
  assert.deepEqual(labels.map((l) => [l.run, l.stage, l.by, l.instance]), [['ra', 'wrong or incomplete change', 'judge', 'alice'], ['rb', 'verification', 'code', 'alice']]);
  assert.deepEqual(runner.calls.map((r) => r.role), ['stage-judge'], 'one judge call, for the run that ran its check');
  assert.equal(runner.calls[0]!.model, 'haiku', 'the stage-label judge is routed to haiku');
  assert.ok(f.log.read(0, ['run.cost']).some((e) => (e.payload as { role: string; usd: number }).role === 'stage-judge'), 'the judge call counts as spend');
  const report = (await f.backlog.list('report'))[0]!;
  assert.ok((await f.backlog.comments(report.number)).some((x) => /Where failed runs first went wrong/.test(x.body) && /- verification: 1 \(alice 1\)/.test(x.body)));
  // A later Monday report labels nothing again.
  const next = new Date(monday.getTime() + 7 * 86_400_000);
  await c.maybeReport(next);
  assert.equal(runner.calls.length, 1);
  assert.equal(f.log.read(0, ['run.stage_labeled']).length, 2);
});
