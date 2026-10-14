// plan and review stage labels: set by code from a run's trace (the issue's events), never by the judge and never
// guessed. A trace that doesn't show the evidence leaves the label as it was; existing labels and old events read
// as before; the weekly section shows plan and review with their counts and every evidence line.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventSchemas, type EventPayload, type StoredEvent } from '../src/events/types.js';
import { classifyRuns, stageLabelsMarkdown } from '../src/failure-modes.js';
import { buildReport } from '../src/reports.js';
import type { RunRecord } from '../src/run-record.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { JUDGE_STAGES, labelFailedRun, labelFailedRuns, STAGES, traceStage, type FailedRun } from '../src/stage-label.js';
import { asFailedRun, labelWeek, unlabelledFailures } from '../src/coordinator/stage-labels.js';
import { fixture } from './repro-state-graph/harness.js';

const T0 = Date.parse('2026-10-05T12:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
let id = 0;
const ev = (s: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: at(s), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });
const record = (runId: string, issue: number, role: string, s: number, e: number, commands: string[] = []): RunRecord => ({
  v: 1,
  id: runId,
  issue,
  role,
  model: 'm',
  startedAt: at(s),
  endedAt: at(e),
  reason: 'succeeded',
  costUsd: 0,
  turns: 0,
  steps: commands.map((what) => ({ kind: 'command', tool: 'Bash', what, status: 'error', exitCode: 1, output: '' })),
  files: [],
  otherTools: 0,
  final: 'done',
  truncated: false,
});
const week = { since: new Date(T0 - 86_400_000), until: new Date(T0 + 86_400_000) };
const H = 'c'.repeat(40);
const H2 = 'd'.repeat(40);
const TEST = 'test/price.test.js';
const CHECK = `node --test ${TEST}`;

/** A judge that answers every run with `stage`, recording each call. */
const judge = (stage = 'wrong or incomplete change') => new FakeRunner((req: RunRequest) => ({ structured: { stage, reason: `judge on ${/Run (\S+) \(/.exec(req.prompt)![1]}` }, costUsd: 0.03 }));

/** Label the week's runs; the labels as [run, stage, by, reason] and the judge's calls. */
async function label(events: StoredEvent[], records: RunRecord[], doneWhen: string[] | { commands: string[]; tests: string[] } = []) {
  const runner = judge();
  const out: EventPayload<'run.stage_labeled'>[] = [];
  await labelWeek({ events, records, ...week, instance: 'alpha', runner, cwd: '/tmp', doneWhenOf: async () => doneWhen, spentToday: () => 0, dailyBudgetUsd: 10, emit: (type, payload) => void (type === 'run.stage_labeled' && out.push(payload as EventPayload<'run.stage_labeled'>)) });
  for (const l of out) assert.ok(EventSchemas['run.stage_labeled'].safeParse(l).success, `${l.stage} is a valid stored label`);
  return { labels: out.map((l) => [l.run, l.stage, l.by, l.reason] as const), calls: runner.calls.length };
}

/** A planner run on `issue` at `s`, then `after` (the plan gate's events). */
const plannerRun = (issue: number, s: number, after: StoredEvent[] = []) => [
  ev(s, 'run.started', { issue, role: 'planner', model: 'm', worktree: '/w', pid: 1, pgid: 1, attempt: 1 }),
  ev(s + 60, 'run.finished', { issue, role: 'planner', reason: 'succeeded', detail: 'planned' }),
  ...after,
];
const plan = (more: object = {}) => ({ approach: 'clamp the quantity', steps: ['edit src/cart.js'], files: ['src/cart.js'], risks: [], acceptance: ['totals never go negative'], decisions: { nothing: true }, ...more });
const posted = (issue: number, s: number, p: object, held = false, decision: string | null = null) => ev(s, 'plan.posted', { issue, plan: p, held, reasons: held ? ['plan_gate is always'] : [], comments_at: 1, decision });

/** A worker attempt on `issue` from `s`: its change proposed at `head`, then `after`. */
const workerRun = (issue: number, s: number, after: StoredEvent[], head = H) => [
  ev(s, 'run.started', { issue, role: 'worker', model: 'm', worktree: '/w', pid: 1, pgid: 1, attempt: 1 }),
  ev(s + 300, 'run.finished', { issue, role: 'worker', reason: 'succeeded', detail: 'done' }),
  ev(s + 310, 'change.proposed', { issue, base: 'b'.repeat(40), head, files: ['src/price.js'], patch_hash: 'h' }),
  ...after,
];
const verify = (issue: number, s: number, checks: { check: string; status: string }[], head = H) => ev(s, 'check.result', { issue, head, stage: 'verify', checks: checks.map((c) => ({ ...c, exitCode: c.status === 'pass' ? 0 : 1, duration_ms: 1 })) });
const verdict = (issue: number, s: number, ok: boolean, head = H) => ev(s, 'eval.verdict', { issue, head, patch_hash: 'h', patch_correct: ok, test_correct: true, confidence: 'high', advice: ok ? '' : 'wrong approach' });
const prStatus = (issue: number, s: number, checks: [string, string][], head = H) => ev(s, 'pr.status', { issue, number: 9, head, ready: false, reasons: [], checks: checks.map(([name, outcome]) => ({ name, outcome })) });

test('a planner run whose plan the plan gate turned down is labelled plan in code, with the gate as its evidence', async () => {
  const events = [
    // The contract check sends it back.
    ...plannerRun(1, 0, [ev(70, 'plan.sent_back', { issue: 1, by: 'contract', why: 'the plan run gave no steps', round: 1 })]),
    // Plan review sends it back.
    ...plannerRun(2, 1000, [ev(1065, 'plan.reviewed', { issue: 2, contradictions: [{ ref: 'D1', why: 'x' }] }), ev(1070, 'plan.sent_back', { issue: 2, by: 'review', why: 'plan review found it contradicts [D1]', round: 1 })]),
    // Held at the gate, and the owner rejects it.
    ...plannerRun(3, 2000, [posted(3, 2070, plan(), true, 'q3'), ev(2100, 'plan.decided', { issue: 3, decision: 'q3', answer: 'reject', by: 'example-owner', note: '' })]),
    // Held, and the owner asks for a revision.
    ...plannerRun(4, 3000, [posted(4, 3070, plan(), true, 'q4'), ev(3100, 'plan.decided', { issue: 4, decision: 'q4', answer: 'revise', by: 'example-owner', note: 'keep the old API' })]),
    // Built at once, and a writer objects while it is built.
    ...plannerRun(5, 4000, [posted(5, 4070, plan()), ev(4100, 'plan.objected', { issue: 5, by: 'example-writer', why: 'this rewrites the parser' })]),
  ];
  const records = [1, 2, 3, 4, 5].map((n) => record(`p${n}`, n, 'planner', (n - 1) * 1000, (n - 1) * 1000 + 60));
  const { labels, calls } = await label(events, records);
  assert.equal(calls, 0, 'no judge call: plan is code-only');
  assert.deepEqual(labels, [
    ['p1', 'plan', 'code', 'the plan contract check sent the plan back: the plan run gave no steps'],
    ['p2', 'plan', 'code', 'plan review sent the plan back: plan review found it contradicts [D1]'],
    ['p3', 'plan', 'code', '@example-owner rejected the plan at the plan gate'],
    ['p4', 'plan', 'code', '@example-owner sent the plan back at the plan gate for a revision: keep the old API'],
    ['p5', 'plan', 'code', '@example-writer objected to the plan while it was built: this rewrites the parser'],
  ]);
});

test('a worker run whose failing checks are all done_when tests its plan never names is labelled plan', async () => {
  const events = [posted(1, 0, plan()), ...workerRun(1, 100, [verify(1, 420, [{ check: CHECK, status: 'fail' }])])];
  const { labels, calls } = await label(events, [record('w1', 1, 'worker', 100, 400, [CHECK])], { commands: [TEST], tests: [TEST] });
  assert.deepEqual(labels, [['w1', 'plan', 'code', `the plan never names ${TEST}, the done_when test that failed`]]);
  assert.equal(calls, 0);
});

test('the evaluator passed a head whose PR checks then failed on that same head: review, in code; a proposed run with no such evidence stays unlabelled', async () => {
  const events = [
    ...workerRun(1, 0, [verify(1, 320, [{ check: CHECK, status: 'pass' }]), verdict(1, 330, true), ev(340, 'pr.opened', { issue: 1, number: 9, url: 'u', head: H, draft: false }), prStatus(1, 400, [['build', 'pass'], ['test', 'fail']])]),
    // Passed, and the PR's checks passed too: not a failure, not labelled.
    ...workerRun(2, 1000, [verify(2, 1320, [{ check: CHECK, status: 'pass' }]), verdict(2, 1330, true), prStatus(2, 1400, [['test', 'pass']])]),
  ];
  const { labels, calls } = await label(events, [record('w1', 1, 'worker', 0, 300, [CHECK]), record('w2', 2, 'worker', 1000, 1300, [CHECK])], [CHECK]);
  assert.deepEqual(labels, [['w1', 'review', 'code', `the evaluator passed ${H.slice(0, 8)} (confidence high); the PR's checks then failed on that same head: test`]]);
  assert.equal(calls, 0);
});

test('the evaluator rejected a head that then merged with the default branch green: review, in code', async () => {
  const events = workerRun(1, 0, [
    verify(1, 320, [{ check: CHECK, status: 'pass' }]),
    verdict(1, 330, false),
    ev(400, 'merge.done', { issue: 1, number: 9, head: H, sha: 'e'.repeat(40), url: 'u', title: 't' }),
    ev(500, 'merge.main_result', { issue: 1, number: 9, sha: 'e'.repeat(40), outcome: 'green', failed: [] }),
  ]);
  const { labels, calls } = await label(events, [record('w1', 1, 'worker', 0, 300, [CHECK])], [CHECK]);
  assert.deepEqual(labels, [['w1', 'review', 'code', `the evaluator rejected ${H.slice(0, 8)}; that same head merged as #9 and the default branch's checks stayed green`]]);
  assert.equal(calls, 0);
});

test('ambiguous traces keep the label they had: the judge for a failed run, nothing for a planner or proposed run', async () => {
  const cases: [string, StoredEvent[], RunRecord, string | null][] = [
    // Passed; the PR's checks failed on a different head (a later push): not the head the evaluator saw.
    ['other head', workerRun(1, 0, [verify(1, 320, [{ check: CHECK, status: 'pass' }]), verdict(1, 330, true), prStatus(1, 400, [['test', 'fail']], H2)]), record('a', 1, 'worker', 0, 300, [CHECK]), null],
    // Passed; the check failed and then passed on the same head: flaky.
    ['flaky', workerRun(2, 0, [verify(2, 320, [{ check: CHECK, status: 'pass' }]), verdict(2, 330, true), prStatus(2, 400, [['test', 'fail']]), prStatus(2, 500, [['test', 'pass']])]), record('b', 2, 'worker', 0, 300, [CHECK]), null],
    // Rejected; the same head merged but the default branch went red.
    ['merged red', workerRun(3, 0, [verify(3, 320, [{ check: CHECK, status: 'pass' }]), verdict(3, 330, false), ev(400, 'merge.done', { issue: 3, number: 9, head: H, sha: 'e'.repeat(40), url: 'u', title: 't' }), ev(500, 'merge.main_result', { issue: 3, number: 9, sha: 'e'.repeat(40), outcome: 'red', failed: ['test'] })]), record('c', 3, 'worker', 0, 300, [CHECK]), 'wrong or incomplete change'],
    // Rejected; a different head merged.
    ['merged other head', workerRun(4, 0, [verify(4, 320, [{ check: CHECK, status: 'pass' }]), verdict(4, 330, false), ev(400, 'merge.done', { issue: 4, number: 9, head: H2, sha: 'e'.repeat(40), url: 'u', title: 't' }), ev(500, 'merge.main_result', { issue: 4, number: 9, sha: 'e'.repeat(40), outcome: 'green', failed: [] })]), record('d', 4, 'worker', 0, 300, [CHECK]), 'wrong or incomplete change'],
    // The plan names the failing test (its file name).
    ['plan names it', [posted(5, -50, plan({ steps: ['make price.test.js pass'] })), ...workerRun(5, 0, [verify(5, 320, [{ check: CHECK, status: 'fail' }])])], record('e', 5, 'worker', 0, 300, [CHECK]), 'wrong or incomplete change'],
    // The plan names the module the test is named for: it may well cover it.
    ['plan names the module', [posted(13, -50, plan({ files: ['src/price.js'] })), ...workerRun(13, 0, [verify(13, 320, [{ check: CHECK, status: 'fail' }])])], record('m', 13, 'worker', 0, 300, [CHECK]), 'wrong or incomplete change'],
    // The failing check couldn't run.
    ['unavailable', [posted(6, -50, plan()), ...workerRun(6, 0, [verify(6, 320, [{ check: CHECK, status: 'unavailable' }])])], record('f', 6, 'worker', 0, 300, [CHECK]), 'wrong or incomplete change'],
    // A failing check that isn't a done_when test.
    ['not a test', [posted(7, -50, plan()), ...workerRun(7, 0, [verify(7, 320, [{ check: CHECK, status: 'fail' }, { check: 'npm run lint', status: 'fail' }])])], record('g', 7, 'worker', 0, 300, [CHECK]), 'wrong or incomplete change'],
    // The plan was held and never approved: not the plan this run was built from.
    ['held plan', [posted(8, -50, plan(), true, 'q8'), ...workerRun(8, 0, [verify(8, 320, [{ check: CHECK, status: 'fail' }])])], record('h', 8, 'worker', 0, 300, [CHECK]), 'wrong or incomplete change'],
    // No plan at all.
    ['no plan', workerRun(9, 0, [verify(9, 320, [{ check: CHECK, status: 'fail' }])]), record('i', 9, 'worker', 0, 300, [CHECK]), 'wrong or incomplete change'],
    // A planner run whose plan was built at once with no objection; and one held with no answer yet.
    ['plan accepted', plannerRun(10, 0, [posted(10, 70, plan())]), record('j', 10, 'planner', 0, 60), null],
    ['plan undecided', plannerRun(11, 0, [posted(11, 70, plan(), true, 'q11')]), record('k', 11, 'planner', 0, 60), null],
    // A send-back from another round, after the next planner run started: not this run's plan.
    ['later round', [...plannerRun(12, 0, [posted(12, 70, plan(), true, 'q12'), ev(80, 'plan.decided', { issue: 12, decision: 'q12', answer: 'approve', by: 'example-owner', note: '' })]), ...plannerRun(12, 500, [ev(570, 'plan.sent_back', { issue: 12, by: 'contract', why: 'x', round: 1 })])], record('l', 12, 'planner', 0, 60), null],
  ];
  for (const [name, events, rec, want] of cases) {
    // The labeller reads this run's trace and finds no plan or review evidence in it.
    const run = classifyRuns(events, week.since, week.until, [rec]).find((c) => c.runId === rec.id)!;
    const f = asFailedRun(run, rec, events, [TEST], [TEST]);
    assert.ok(f.trace?.during.some((e) => e.type === 'run.started'), `${name}: its trace is read`);
    assert.equal(traceStage(f), null, name);
    const { labels } = await label(events, [rec], { commands: [TEST], tests: [TEST] });
    assert.deepEqual(labels.map(([run, stage]) => [run, stage]), want ? [[rec.id, want]] : [], name);
  }
});

test('the existing code labels win over trace evidence, and a run labelled once is never relabelled', async () => {
  const transient = ev(100, 'run.transient_retry', { issue: 1, role: 'worker', model: 'm', attempt: 1, cause: 'network', wait_ms: 1, detail: 'x' });
  const events = [
    // A harness event and review evidence: environment/harness, as before.
    ...workerRun(1, 0, [transient, verdict(1, 330, false), ev(400, 'merge.done', { issue: 1, number: 9, head: H, sha: 'e'.repeat(40), url: 'u', title: 't' }), ev(500, 'merge.main_result', { issue: 1, number: 9, sha: 'e'.repeat(40), outcome: 'green', failed: [] })]),
    // The run ran none of its done_when commands and its plan never names the test: verification, as before.
    posted(2, 950, plan()),
    ...workerRun(2, 1000, [verify(2, 1320, [{ check: CHECK, status: 'fail' }])]),
    // Already labelled by the judge: plan evidence or not, it keeps its label.
    posted(3, 1950, plan()),
    ...workerRun(3, 2000, [verify(3, 2320, [{ check: CHECK, status: 'fail' }])]),
    ev(2500, 'run.stage_labeled', { run: 'w3', issue: 3, role: 'worker', instance: 'alpha', stage: 'wrong files', reason: 'x', by: 'judge' }),
  ];
  const records = [record('w1', 1, 'worker', 0, 300, [CHECK]), record('w2', 2, 'worker', 1000, 1300, ['git status']), record('w3', 3, 'worker', 2000, 2300, [CHECK])];
  const { labels } = await label(events, records, { commands: [TEST], tests: [TEST] });
  assert.deepEqual(labels.map(([run, stage]) => [run, stage]), [['w1', 'environment/harness'], ['w2', 'verification']]);
  assert.deepEqual(unlabelledFailures(events, records, week.since, week.until).map((u) => u.record.id), ['w1', 'w2']);
  // A planner run whose plan was sent back, with a harness event: no label (ambiguous), and no judge call.
  const planner = plannerRun(4, 0, [ev(30, 'run.transient_retry', { issue: 4, role: 'planner', model: 'm', attempt: 1, cause: 'network', wait_ms: 1, detail: 'x' }), ev(70, 'plan.sent_back', { issue: 4, by: 'contract', why: 'x', round: 1 })]);
  const p = await label(planner, [record('p4', 4, 'planner', 0, 60)]);
  assert.deepEqual([p.labels, p.calls], [[], 0]);
});

test('plan and review evidence in one trace is ambiguous: the judge decides, as before', async () => {
  const both: FailedRun = {
    run: 'r',
    issue: 1,
    role: 'worker',
    ended: 'checks failed',
    why: 'x',
    events: ['run.started', 'run.finished'],
    doneWhen: [TEST],
    commands: [CHECK],
    steps: '',
    final: '',
    doneWhenTests: [TEST],
    trace: {
      before: [{ type: 'plan.posted', payload: { issue: 1, plan: plan(), held: false, reasons: [], comments_at: 1, decision: null } }],
      during: [verify(1, 0, [{ check: CHECK, status: 'fail' }]), verdict(1, 1, false), ev(2, 'merge.done', { issue: 1, number: 9, head: H, sha: 'e'.repeat(40), url: 'u', title: 't' }), ev(3, 'merge.main_result', { issue: 1, number: 9, sha: 'e'.repeat(40), outcome: 'green', failed: [] })].map((e) => ({ type: e.type, payload: e.payload as unknown as Record<string, unknown> })),
    },
  };
  assert.equal(traceStage(both), null);
  const runner = judge();
  const l = await labelFailedRun(both, { runner, cwd: '/tmp', allowed: () => true });
  assert.deepEqual([l?.stage, l?.by], ['wrong or incomplete change', 'judge']);
  // Either one alone is not ambiguous.
  assert.equal(traceStage({ ...both, trace: { ...both.trace!, during: both.trace!.during.slice(0, 1) } })?.stage, 'plan');
  assert.equal(traceStage({ ...both, trace: { before: [], during: both.trace!.during } })?.stage, 'review');
});

test('existing stage labels are unchanged on the existing fixtures, now read with their traces', async () => {
  // The fixtures of the original stage-label tests, as events, each with the trace the labeller now reads.
  const events = [
    ...workerRun(1, 0, [verify(1, 320, [{ check: 'npm test', status: 'fail' }])]),
    ...workerRun(2, 1000, [verify(2, 1320, [{ check: 'npm test', status: 'fail' }])]),
    ...workerRun(3, 2000, [ev(2100, 'run.transient_retry', { issue: 3, role: 'worker', model: 'm', attempt: 1, cause: 'network', wait_ms: 1, detail: 'x' }), verify(3, 2320, [{ check: 'npm test', status: 'fail' }])]),
    ...workerRun(4, 3000, [ev(3320, 'change.rejected', { issue: 4, why: 'the change edits a frozen test' })]),
  ];
  const records = [record('a', 1, 'worker', 0, 300, ['npm test']), record('b', 2, 'worker', 1000, 1300, ['git diff']), record('c', 3, 'worker', 2000, 2300, ['npm test']), record('d', 4, 'worker', 3000, 3300, ['npm test'])];
  const runs = unlabelledFailures(events, records, week.since, week.until).map(({ run, record: r }) => asFailedRun(run, r, events, ['npm test']));
  for (const f of runs) assert.ok(f.trace && f.trace.during.length, `${f.run} carries its trace`);
  const runner = judge('wrong files');
  const labels = await labelFailedRuns(runs, { runner, cwd: '/tmp', allowed: () => true });
  assert.deepEqual(labels.map((l) => [l.run, l.stage, l.by]), [['a', 'wrong files', 'judge'], ['b', 'verification', 'code'], ['c', 'environment/harness', 'code'], ['d', 'wrong files', 'judge']]);
  // The judge's choices are as they were: plan and review are never offered to it, nor accepted from it.
  assert.deepEqual([...JUDGE_STAGES], ['wrong files', 'right files, wrong place', 'wrong or incomplete change', 'verification']);
  for (const stage of ['plan', 'review']) {
    assert.equal(await labelFailedRun(runs[0]!, { runner: judge(stage), cwd: '/tmp', allowed: () => true }), null, stage);
    assert.doesNotMatch(runner.calls[0]!.prompt, new RegExp(`^- ${stage}:`, 'm'));
  }
  // The eval fixtures carry no trace: none of them gets a trace label.
  const evals = JSON.parse(readFileSync(join(process.cwd(), 'templates', 'evals', 'stage-labels.json'), 'utf8')) as { cases: { run: FailedRun }[] };
  for (const c of evals.cases) assert.equal(traceStage(c.run), null, c.run.run);
  // The old stages keep their order, and labels stored before plan and review existed still read.
  const old = ['wrong files', 'right files, wrong place', 'wrong or incomplete change', 'verification', 'environment/harness'];
  assert.deepEqual(STAGES.filter((s) => old.includes(s)), old);
  for (const stage of old) assert.ok(EventSchemas['run.stage_labeled'].safeParse({ run: 'r', issue: 1, role: 'worker', instance: 'alpha', stage, reason: 'x', by: 'judge' }).success, stage);
});

test('the Reports stage panel shows plan and review counts and the evidence line of each, in pipeline order', () => {
  const l = (run: string, stage: string, instance: string, reason: string) => ({ run, stage: stage as never, reason, by: 'code' as const, costUsd: 0, instance });
  const labels = [
    l('p1', 'plan', 'alpha', 'the plan contract check sent the plan back: the plan run gave no steps'),
    l('p2', 'plan', 'beta', '@example-owner rejected the plan at the plan gate'),
    l('p3', 'plan', 'alpha', `the plan never names ${TEST}, the done_when test that failed`),
    l('v1', 'review', 'alpha', `the evaluator passed ${H.slice(0, 8)} (confidence high); the PR's checks then failed on that same head: test`),
    l('w1', 'wrong files', 'alpha', 'edited the client'),
    l('w2', 'wrong files', 'alpha', 'edited the docs'),
    l('w3', 'wrong files', 'beta', 'edited the readme'),
    l('x1', 'verification', 'beta', "the run didn't run any of the issue's done_when commands"),
  ];
  const md = stageLabelsMarkdown(labels).join('\n');
  assert.match(md, /\(8 labelled\)/);
  assert.match(md, /^- plan: 3 \(alpha 2, beta 1\)$/m);
  assert.match(md, /^- review: 1 \(alpha 1\)$/m);
  for (const x of labels.filter((y) => y.stage === 'plan' || y.stage === 'review')) assert.ok(md.includes(`  - /runs/${x.run}: ${x.reason}`), `evidence for ${x.run}`);
  assert.doesNotMatch(md, /\/runs\/w3:/, 'other stages still show two examples');
  const order = ['- plan:', '- wrong files:', '- verification:', '- review:'].map((s) => md.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // On the Reports page: the preview's stage section, from the stored events.
  const events = labels.map((x, i) => ev(i, 'run.stage_labeled', { run: x.run, issue: 1, role: 'worker', instance: x.instance, stage: x.stage, reason: x.reason, by: 'code' }));
  for (const e of events) assert.ok(EventSchemas['run.stage_labeled'].safeParse(e.payload).success);
  const report = buildReport(events, fixture().cfg, { since: new Date(T0 - 3600_000), now: new Date(T0 + 3600_000), weekly: true }).markdown;
  assert.match(report, /^- plan: 3 \(alpha 2, beta 1\)$/m);
  assert.match(report, /^- review: 1 \(alpha 1\)$/m);
  assert.ok(report.includes(`  - /runs/v1: the evaluator passed ${H.slice(0, 8)}`));
});
