// Delivery metrics (src/merge-metrics.ts deliveryMetrics, src/trust.ts metricsDigest, src/ci-metrics.ts,
// src/test-durations.ts): each figure from fixture events, "not measured yet" (never 0) for a source with nothing yet,
// the weekly digest's slow-tests list, the GitHub reads (rate-limited, cached in the log), the per-test duration
// parsers, the dashboard route and the panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_METRICS_CALL_MS, CiMetrics, prWallClock, SLOW_TESTS_EVERY_MS, type CiCheckRun } from '../src/ci-metrics.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload, EventType } from '../src/events/types.js';
import { deliveryMetrics, FIX_FORWARD_EVENT, type MetricEvent } from '../src/merge-metrics.js';
import { parseTestDurations } from '../src/test-durations.js';
import { deliveryLines, metricsDigest, NOT_MEASURED } from '../src/trust.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (daysAgo: number, hours = 0) => new Date(NOW.getTime() - daysAgo * 24 * HOUR + hours * HOUR).toISOString();
const ev = (ts: string, type: string, payload: object): MetricEvent => ({ ts, type, payload });
const sha = (c: string) => c.repeat(40).slice(0, 40);
const metrics = (events: MetricEvent[], budgetS = 30) => deliveryMetrics(events, { now: NOW, budgetS });
const w = (m: ReturnType<typeof metrics>, days: 7 | 30) => m.windows.find((x) => x.days === days)!;

/**
 * Over 30 days:
 * - merges: PR 101 (2 days ago, merge.done and pr.closed: one merge), PR 102 (3 days ago, pr.closed), a direct land
 *   (5 days ago), PR 103 (20 days ago);
 * - the default branch red 2 days ago, red again an hour later (the same time), green 3 hours after it went red;
 *   red 20 days ago, green 30 minutes later; red 1 hour ago, still red;
 * - revert PR #120 opened on the red 20 days ago (merge.stopped) and merged, #121 for an unaccounted commit 1 day ago;
 * - PR CI: 101 took 12 minutes, 102 took 30, 103 (20 days ago) 6; one not measurable;
 * - startup: issue 1 claimed then started 20 s later; issue 2 40 s; issue 3 (20 days ago) 300 s;
 * - flaky re-runs: two in 7 days, one found a flaky check; one quarantined.
 */
function fixture(): MetricEvent[] {
  return [
    ev(at(2), 'merge.done', { issue: 1, number: 101, head: sha('a'), sha: sha('1'), url: '', title: 'One' }),
    ev(at(2), 'pr.closed', { issue: 1, number: 101, merged: true }),
    ev(at(3), 'pr.closed', { issue: 2, number: 102, merged: true }),
    ev(at(3), 'pr.closed', { issue: 9, number: 109, merged: false }),
    ev(at(5), 'land.result', { issue: 4, outcome: 'landed', landed: sha('4'), detail: '' }),
    ev(at(20), 'merge.done', { issue: 3, number: 103, head: sha('c'), sha: sha('3'), url: '', title: 'Three' }),
    ev(at(2, 1), 'merge.main_result', { issue: 1, number: 101, sha: sha('1'), outcome: 'red', failed: ['ci'] }),
    ev(at(2, 2), 'merge.main_result', { issue: 2, number: 102, sha: sha('2'), outcome: 'red', failed: ['ci'] }),
    ev(at(2, 4), 'merge.main_result', { issue: 5, number: 105, sha: sha('5'), outcome: 'green', failed: [] }),
    ev(at(20, 1), 'merge.main_result', { issue: 3, number: 103, sha: sha('3'), outcome: 'red', failed: ['ci'] }),
    ev(at(20, 1), 'merge.stopped', { reason: 'red', number: 103, sha: sha('3'), revert: 'https://github.com/o/r/pull/120' }),
    ev(at(20, 1.5), 'merge.main_result', { issue: 6, number: 106, sha: sha('6'), outcome: 'green', failed: [] }),
    ev(at(19), 'pr.closed', { issue: 7, number: 120, merged: true }),
    ev(at(1), 'main_watch.unaccounted', { sha: sha('9'), url: '', reason: 'no PR', number: null, revert: 'https://github.com/o/r/pull/121' }),
    ev(at(0, -1), 'merge.main_result', { issue: 8, number: 108, sha: sha('8'), outcome: 'red', failed: ['ci'] }),
    ev(at(2), 'ci.pr_timing', { number: 101, head: sha('a'), wall_ms: 12 * 60_000, first_started: null, last_completed: null, why: null }),
    ev(at(3), 'ci.pr_timing', { number: 102, head: sha('b'), wall_ms: 30 * 60_000, first_started: null, last_completed: null, why: null }),
    ev(at(3), 'ci.pr_timing', { number: 110, head: sha('f'), wall_ms: null, first_started: null, last_completed: null, why: 'never completed' }),
    ev(at(20), 'ci.pr_timing', { number: 103, head: sha('c'), wall_ms: 6 * 60_000, first_started: null, last_completed: null, why: null }),
    ev(at(4), 'issue.claimed', { issue: 1, instance: 'i', lease: sha('l'), base: sha('b'), owner: 'o' }),
    ev(new Date(Date.parse(at(4)) + 20_000).toISOString(), 'run.started', { issue: 1, role: 'worker', model: 'm', worktree: 'w', pid: 1, pgid: 1, attempt: 1 }),
    ev(new Date(Date.parse(at(4)) + 90_000).toISOString(), 'run.started', { issue: 1, role: 'evaluator', model: 'm', worktree: 'w', pid: 2, pgid: 2, attempt: 1 }),
    ev(at(3), 'issue.claimed', { issue: 2, instance: 'i', lease: sha('l'), base: sha('b'), owner: 'o' }),
    ev(new Date(Date.parse(at(3)) + 40_000).toISOString(), 'run.started', { issue: 2, role: 'worker', model: 'm', worktree: 'w', pid: 3, pgid: 3, attempt: 1 }),
    ev(at(20), 'issue.claimed', { issue: 3, instance: 'i', lease: sha('l'), base: sha('b'), owner: 'o' }),
    ev(new Date(Date.parse(at(20)) + 300_000).toISOString(), 'run.started', { issue: 3, role: 'worker', model: 'm', worktree: 'w', pid: 4, pgid: 4, attempt: 1 }),
    ev(at(2), 'flaky.rerun_result', { sha: sha('1'), number: 101, flaky: ['unit'], real: [], timed_out: [] }),
    ev(at(1), 'flaky.rerun_result', { sha: sha('8'), number: 108, flaky: [], real: ['unit'], timed_out: [] }),
    ev(at(2), 'flaky.quarantined', { test: 'unit', sha: sha('1'), issue: 50, url: null, again: false }),
    // Slow tests: a test run's tier and a CI job, 1 and 2 days ago; one 10 days ago (outside the week).
    ev(at(1), 'testrun.durations', { id: 'r1', tier: 'fast', tests: [{ name: 'db > migrates', ms: 45_000 }, { name: 'ui renders', ms: 900 }], parsed: 2 }),
    ev(at(2), 'ci.test_durations', { sha: sha('1'), job: 'test (1)', tests: [{ name: 'db > migrates', ms: 41_000 }, { name: 'api > slow call', ms: 31_000 }, { name: 'fast', ms: 5 }], parsed: 3, error: null }),
    ev(at(10), 'ci.test_durations', { sha: sha('3'), job: 'test (1)', tests: [{ name: 'old and slow', ms: 999_000 }], parsed: 1, error: null }),
  ];
}

test('every delivery metric from fixture events, over 7 and 30 days', () => {
  const m = metrics(fixture());
  const [w7, w30] = [w(m, 7), w(m, 30)];
  assert.deepEqual(w7.merges, { measured: true, total: 3, perDay: 0.4 }, 'PR 101 once, PR 102, the land; not the unmerged PR');
  assert.deepEqual(w30.merges, { measured: true, total: 5, perDay: 0.2 }, 'and PR 103 and revert #120');
  assert.deepEqual(
    m.perDay!.filter((d) => d.merged),
    [
      { day: '2026-10-08', merged: 1 },
      { day: '2026-10-10', merged: 1 },
      { day: '2026-10-11', merged: 1 },
    ],
  );
  assert.equal(m.perDay!.length, 14);
  assert.equal(m.perDay!.at(-1)!.day, '2026-10-13');
  assert.deepEqual(w7.mainRed, { measured: true, count: 2, stillRed: true }, 'red twice in a row is one time; red now');
  assert.deepEqual(w30.mainRed, { measured: true, count: 3, stillRed: true });
  assert.deepEqual(w7.timeToGreen, { measured: true, minutes: [180], medianMinutes: 180 }, 'the open red time has no green yet');
  assert.deepEqual(w30.timeToGreen, { measured: true, minutes: [30, 180], medianMinutes: 105 });
  assert.deepEqual(w7.reverts, { measured: true, opened: 1, onRed: 0, merged: 0, redTimes: 2, rate: 0 });
  assert.deepEqual(w30.reverts, { measured: true, opened: 2, onRed: 1, merged: 1, redTimes: 3, rate: 0.333 });
  assert.deepEqual(w7.prCi, { measured: true, prs: 2, medianMinutes: 21, p90Minutes: 30, slowest: [{ number: 102, minutes: 30 }, { number: 101, minutes: 12 }] });
  assert.equal(w30.prCi.measured && w30.prCi.medianMinutes, 12);
  assert.deepEqual(w7.startup, { measured: true, runs: 2, medianSeconds: 30, p90Seconds: 40 }, 'claim to the first process; the evaluator later is not a startup');
  assert.deepEqual(w30.startup, { measured: true, runs: 3, medianSeconds: 40, p90Seconds: 300 });
  assert.deepEqual(w7.flake, { measured: true, reruns: 2, flaky: 1, rate: 0.5, quarantined: 1 });
  // Slow tests over the week, by the median of each test's runs; the budget 30 s.
  assert.ok(m.slowTests.measured);
  assert.deepEqual(
    m.slowTests.slowest.map((t) => [t.name, t.medianMs, t.runs]),
    [
      ['db > migrates', 43_000, 2],
      ['api > slow call', 31_000, 1],
      ['ui renders', 900, 1],
      ['fast', 5, 1],
    ],
  );
  assert.deepEqual(m.slowTests.overBudget.map((t) => t.name), ['db > migrates', 'api > slow call']);
  assert.equal(m.slowTests.overBudgetTotal, 2);
  assert.equal(m.slowTests.runs, 2, 'the run 10 days ago is outside the week');
  // The budget is the config's.
  const strict = metrics(fixture(), 0.5);
  assert.ok(strict.slowTests.measured && strict.slowTests.overBudgetTotal === 3);
});

test('fix-forward: not measured until its events exist, then its success rate from them', () => {
  const m = metrics(fixture());
  assert.equal(w(m, 7).fixForward.measured, false);
  assert.match((w(m, 7).fixForward as { why: string }).why, /fix-forward hasn't taken on a red default branch yet; this fills from its fix_forward\.finished events/);
  const withFf = metrics([...fixture(), ev(at(1), FIX_FORWARD_EVENT, { outcome: 'fixed' }), ev(at(2), FIX_FORWARD_EVENT, { outcome: 'reverted' }), ev(at(3), FIX_FORWARD_EVENT, { outcome: 'fixed' })]);
  assert.deepEqual(w(withFf, 7).fixForward, { measured: true, attempts: 3, fixed: 2, reverted: 1, successRate: 0.667 });
});

test('a source with nothing recorded is "not measured yet", never 0, in the numbers, the digest and the panel', () => {
  const m = metrics([]);
  for (const win of m.windows) for (const k of ['merges', 'mainRed', 'timeToGreen', 'reverts', 'fixForward', 'prCi', 'startup', 'flake'] as const) assert.equal(win[k].measured, false, `${k} over ${win.days} days`);
  assert.equal(m.slowTests.measured, false);
  assert.equal(m.perDay, null);
  const lines = deliveryLines(m);
  assert.equal(lines.length, 8);
  for (const l of lines) {
    assert.match(l, /not measured yet \(/, l);
    assert.doesNotMatch(l, /: 0\b|\b0%|\b0 \//, `no zero for a missing source: ${l}`);
  }
  const digest = metricsDigest(m, { instance: 'example' }).join('\n');
  assert.match(digest, /\*\*Slow tests:\*\* not measured yet \(no test run or CI log with per-test durations in the last 7 days\)/);
  // One source present, the others missing: only the present one is a number.
  const some = metrics([ev(at(1), 'pr.closed', { issue: 1, number: 1, merged: true })]);
  assert.deepEqual(w(some, 7).merges, { measured: true, total: 1, perDay: 0.1 });
  assert.equal(w(some, 7).prCi.measured, false);
  assert.equal(w(some, 7).flake.measured, false, 'no flaky re-run events (flaky tests not merged): not measured');
  // Test output with no durations this reads, or CI logs that couldn't be read, say so.
  const unread = metrics([ev(at(1), 'testrun.durations', { id: 'r', tier: 't', tests: [], parsed: 0 })]);
  assert.match((unread.slowTests as { why: string }).why, /printed no per-test durations this reads/);
  const denied = metrics([ev(at(1), 'ci.test_durations', { sha: sha('1'), job: 'test', tests: [], parsed: 0, error: 'GitHub 403 reading the log of job 7' })]);
  assert.match((denied.slowTests as { why: string }).why, /the CI logs couldn't be read \(GitHub 403/);
  assert.equal(NOT_MEASURED, 'not measured yet');
});

test('the weekly metrics digest: the delivery figures, then the 20 slowest tests and every test over budget, each message under 2000 characters', () => {
  const tests = Array.from({ length: 30 }, (_, i) => ({ name: `suite ${i} > a test named at some length to fill the line ${i}`, ms: (i + 1) * 2000 }));
  const m = metrics([...fixture(), ev(at(1), 'testrun.durations', { id: 'r2', tier: 'full', tests, parsed: 30 })]);
  const parts = metricsDigest(m, { instance: 'example', dashboardUrl: 'https://dash.example.test/' });
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 2000, `${p.length} characters`);
  assert.match(parts[0]!, /^\*\*Metrics, week of 2026-10-12: example\*\* \(last 7 \/ 30 days\)/);
  assert.match(parts[0]!, /- Merges per day: 0\.4 \(3\) \/ 0\.2 \(5\)/);
  assert.match(parts[0]!, /- Main red: 2 \/ 3 \(red now\)/);
  assert.match(parts[0]!, /- Time to green \(median\): 180 min \/ 105 min/);
  assert.match(parts[0]!, /- Reverts opened, merged: 1, 0 \/ 2, 1; revert rate 0% \/ 33\.3%/);
  assert.match(parts[0]!, /- Fix-forward success: not measured yet \(fix-forward hasn't taken on a red default branch yet/);
  assert.match(parts[0]!, /- PR CI wall-clock \(median, p90\): 21 min, 30 min \/ 12 min, 30 min/);
  assert.match(parts[0]!, /- Agent startup \(median, p90\): 30 s, 40 s \/ 40 s, 5 min/);
  assert.match(parts[0]!, /- Flake rate: 50% of 2 \/ 50% of 2/);
  assert.match(parts[0]!, /https:\/\/dash\.example\.test\/reports$/);
  const rest = parts.slice(1).join('\n');
  assert.match(rest, /\*\*The 20 slowest tests\*\*, last 7 days \(median of 3 runs; budget 30 s\):/);
  const listed = [...rest.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]));
  assert.deepEqual(listed, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.match(rest, /^1\. 1 min `suite 29 > a test named/m);
  assert.match(rest, /\*\*Over the 30 s budget: 17\*\*/, '15 of the 30 (32 s to 60 s), and two from the fixture');
  assert.match(rest, /^- 43 s `db > migrates`$/m);
});

// --- The per-test duration parsers -------------------------------------------------------------------------------

test('per-test durations: node:test TAP and spec (leaf tests only, suites and skips left out), pytest, go, jest, vitest; Actions timestamps and colours stripped; anything else none', () => {
  // node:test's TAP, as Node prints it (a test with a subtest, a describe suite, a skip).
  const tap = [
    'TAP version 13',
    '# Subtest: leaf one',
    'ok 1 - leaf one',
    '  ---',
    '  duration_ms: 31.639875',
    "  type: 'test'",
    '  ...',
    '# Subtest: parent',
    '    # Subtest: child a',
    '    ok 1 - child a',
    '      ---',
    '      duration_ms: 21.513292',
    "      type: 'test'",
    '      ...',
    '    1..1',
    'ok 2 - parent',
    '  ---',
    '  duration_ms: 21.768333',
    "  type: 'test'",
    '  ...',
    '# Subtest: suite',
    '    # Subtest: in suite',
    '    not ok 1 - in suite',
    '      ---',
    '      duration_ms: 1200',
    "      type: 'test'",
    '      ...',
    'ok 3 - suite',
    '  ---',
    '  duration_ms: 1300',
    "  type: 'suite'",
    '  ...',
    '# Subtest: skipped',
    'ok 4 - skipped # SKIP',
    '  ---',
    '  duration_ms: 0.04',
    '  ...',
  ].join('\n');
  assert.deepEqual(parseTestDurations(tap), [
    { name: 'suite > in suite', ms: 1200 },
    { name: 'leaf one', ms: 31.6 },
    { name: 'parent > child a', ms: 21.5 },
  ]);
  // The spec reporter, from GitHub Actions' log (a timestamp on each line) with colours.
  const spec = [
    '2026-10-13T10:00:00.1234567Z \x1b[32m✔ leaf one (30.93125ms)\x1b[39m',
    '2026-10-13T10:00:00.1234567Z ▶ parent',
    '2026-10-13T10:00:00.1234567Z   ✔ child a (21.647833ms)',
    '2026-10-13T10:00:00.1234567Z ✔ parent (21.974875ms)',
    '2026-10-13T10:00:00.1234567Z ▶ suite',
    '2026-10-13T10:00:00.1234567Z   ✖ in suite (1500.5ms)',
    '2026-10-13T10:00:00.1234567Z ▶ suite (1600ms)',
    '2026-10-13T10:00:00.1234567Z ﹣ skipped (0.04125ms) # SKIP',
    '2026-10-13T10:00:00.1234567Z ℹ duration_ms 110.006958',
  ].join('\n');
  assert.deepEqual(parseTestDurations(spec), [
    { name: 'suite > in suite', ms: 1500.5 },
    { name: 'leaf one', ms: 30.9 },
    { name: 'parent > child a', ms: 21.6 },
  ]);
  const pytest = ['============ slowest 3 durations ============', '2.51s call     tests/test_db.py::test_migrate', '0.40s setup    tests/test_db.py::test_migrate', '0.02s call     tests/test_ui.py::test_render[a]'].join('\n');
  assert.deepEqual(parseTestDurations(pytest), [
    { name: 'tests/test_db.py::test_migrate', ms: 2510 },
    { name: 'tests/test_ui.py::test_render[a]', ms: 20 },
  ]);
  const go = ['=== RUN   TestA', '--- PASS: TestA (1.50s)', '    --- PASS: TestA/sub (1.20s)', '    --- FAIL: TestA/other (0.25s)', '--- PASS: TestB (0.01s)'].join('\n');
  assert.deepEqual(parseTestDurations(go), [
    { name: 'TestA/sub', ms: 1200 },
    { name: 'TestA/other', ms: 250 },
    { name: 'TestB', ms: 10 },
  ]);
  const jest = ['  db', '    ✓ migrates (1203 ms)', '    ✕ rolls back (2 s)', ' ✓ src/a.test.ts > adds 12ms'].join('\n');
  assert.deepEqual(parseTestDurations(jest), [
    { name: 'rolls back', ms: 2000 },
    { name: 'migrates', ms: 1203 },
    { name: 'src/a.test.ts > adds', ms: 12 },
  ]);
  assert.deepEqual(parseTestDurations('PASS 12 tests in 3.4s\nok  \tgithub.com/x/y\t0.123s\nRan 5 tests in 0.002s'), [], 'totals, package lines and unittest summaries are not tests');
});

// --- The GitHub reads ----------------------------------------------------------------------------------------------

const run = (o: Partial<CiCheckRun> & { name: string }): CiCheckRun => ({ id: 1, status: 'completed', conclusion: 'success', startedAt: null, completedAt: null, app: 'github-actions', ...o });

test('PR CI wall-clock: the first check run starting to the last required check completing; not measurable when one never completed', () => {
  const runs = [
    run({ name: 'unit', startedAt: '2026-10-13T10:00:00Z', completedAt: '2026-10-13T10:08:00Z' }),
    run({ name: 'lint', startedAt: '2026-10-13T09:59:00Z', completedAt: '2026-10-13T10:01:00Z' }),
    run({ name: 'slow optional', startedAt: '2026-10-13T10:00:00Z', completedAt: '2026-10-13T11:00:00Z' }),
    // A re-run of unit: the required check's last completion counts.
    run({ name: 'unit', startedAt: '2026-10-13T10:09:00Z', completedAt: '2026-10-13T10:14:00Z' }),
  ];
  assert.deepEqual(prWallClock(runs, ['unit', 'lint']), { wall_ms: 15 * 60_000, first_started: '2026-10-13T09:59:00.000Z', last_completed: '2026-10-13T10:14:00.000Z', why: null });
  assert.equal(prWallClock(runs, []).wall_ms, 61 * 60_000, 'no required checks: every check');
  assert.deepEqual(prWallClock(runs, ['unit', 'e2e']), { wall_ms: null, first_started: null, last_completed: null, why: 'the required check e2e never completed on the head' });
  assert.equal(prWallClock([], ['unit']).why, 'no check run started on the head');
});

function meter(o: { runs?: CiCheckRun[]; log?: string; fail?: boolean } = {}) {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'ci-metrics-')), 'events.db'));
  let now = Date.now();
  const calls: string[] = [];
  const m = new CiMetrics({
    api: {
      checkRuns: async (s) => {
        calls.push(`runs ${s.slice(0, 4)}`);
        if (o.fail) throw new Error('GitHub 502 reading the check runs');
        return o.runs ?? [];
      },
      jobLog: async (id) => {
        calls.push(`log ${id}`);
        return o.log ?? '';
      },
    },
    events: (types) => log.read(0, types as EventType[]),
    emit: <T extends EventType>(type: T, payload: EventPayload<T>) => log.append(type, payload, 'test'),
    required: () => ['unit'],
    now: () => now,
  });
  return { log, calls, m, tick: (ms: number) => (now += ms) };
}

test('the GitHub reads: one call per interval, each merged PR timed once (the log is the cache), then the day\'s CI job logs read for slow tests', async () => {
  const runs = [run({ id: 7, name: 'unit', startedAt: '2026-10-13T08:00:00Z', completedAt: '2026-10-13T08:20:00Z' }), run({ id: 8, name: 'other app', app: 'some-app', startedAt: '2026-10-13T08:00:00Z', completedAt: '2026-10-13T08:01:00Z' })];
  const r = meter({ runs, log: '✔ db > migrates (41000ms)\n✔ fast (2ms)\n' });
  r.log.append('pr.opened', { issue: 1, number: 11, url: '', head: sha('a'), draft: false }, 't');
  r.log.append('merge.done', { issue: 1, number: 11, head: sha('a'), sha: sha('1'), url: '', title: 'One' }, 't');
  r.log.append('pr.opened', { issue: 2, number: 12, url: '', head: sha('b'), draft: false }, 't');
  r.log.append('pr.closed', { issue: 2, number: 12, merged: true }, 't');
  await r.m.step();
  assert.equal(r.calls.length, 1);
  await r.m.step();
  assert.equal(r.calls.length, 1, 'no second call within the interval');
  r.tick(CI_METRICS_CALL_MS);
  await r.m.step();
  assert.deepEqual([...r.calls].sort(), ['runs aaaa', 'runs bbbb'], "each merged PR's head");
  const timings = r.log.read(0, ['ci.pr_timing']).map((e) => e.payload as EventPayload<'ci.pr_timing'>);
  assert.deepEqual(timings.map((t) => [t.number, t.wall_ms]).sort(), [[11, 20 * 60_000], [12, 20 * 60_000]]);
  // The merge commit is too fresh for its CI: nothing more to ask.
  r.tick(CI_METRICS_CALL_MS);
  await r.m.step();
  assert.equal(r.calls.length, 2, 'every PR timed; the merge commit not settled yet');
  r.tick(2 * HOUR);
  await r.m.step();
  assert.deepEqual(r.calls.slice(2), ['runs 1111'], 'the merge commit\'s check runs');
  r.tick(CI_METRICS_CALL_MS);
  await r.m.step();
  assert.deepEqual(r.calls.slice(3), ['log 7'], 'only the Actions job\'s log');
  const d = r.log.read(0, ['ci.test_durations']).map((e) => e.payload as EventPayload<'ci.test_durations'>);
  assert.deepEqual(d, [{ sha: sha('1'), job: 'unit', tests: [{ name: 'db > migrates', ms: 41_000 }, { name: 'fast', ms: 2 }], parsed: 2, error: null }]);
  // Nothing again within the day, and the same commit never again.
  for (let i = 0; i < 5; i++) {
    r.tick(CI_METRICS_CALL_MS);
    await r.m.step();
  }
  assert.equal(r.calls.length, 4, 'cached: no PR or commit asked twice');
  r.tick(SLOW_TESTS_EVERY_MS);
  await r.m.step();
  assert.equal(r.calls.length, 4, 'a day later, the same newest merge commit is not read again');
});

test('the GitHub reads: a failing call is tried again later, and a PR is recorded as not measurable after three tries', async () => {
  const r = meter({ fail: true });
  r.log.append('merge.done', { issue: 1, number: 11, head: sha('a'), sha: sha('1'), url: '', title: 'One' }, 't');
  for (let i = 0; i < 3; i++) {
    await r.m.step();
    r.tick(CI_METRICS_CALL_MS);
  }
  assert.equal(r.calls.length, 3);
  const t = r.log.read(0, ['ci.pr_timing']).map((e) => e.payload as EventPayload<'ci.pr_timing'>);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.wall_ms, null);
  assert.match(t[0]!.why!, /reading its check runs failed: GitHub 502/);
  // Not measurable is not a number: the metric has no PR CI figure from it.
  const m = deliveryMetrics(r.log.read(0).map((e) => ({ ts: e.ts, type: e.type, payload: e.payload })), { budgetS: 30 });
  assert.equal(m.windows[0]!.prCi.measured, false);
});

// --- The dashboard -----------------------------------------------------------------------------------------------

test('GET /api/metrics: the owner and writers get the metrics and their definitions; a viewer is refused; read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-metrics-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('pr.closed', { issue: 1, number: 11, merged: true }, 't');
  log.append('testrun.durations', { id: 'r', tier: 'fast', tests: [{ name: 'db > migrates', ms: 45_000 }], parsed: 1 }, 't');
  log.close();
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const call = (user: string, init: RequestInit = {}) => fetch(`${base}/api/metrics`, { ...init, headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } });
  try {
    for (const user of ['example-owner', 'example-collaborator']) {
      const res = await call(user);
      assert.equal(res.status, 200, user);
      const m = (await res.json()) as { windows: { days: number; merges: { measured: boolean; total?: number }; prCi: { measured: boolean } }[]; slowTests: { measured: boolean; overBudget?: { name: string }[]; budgetS?: number }; definitions: string[] };
      assert.equal(m.windows[0]!.merges.total, 1);
      assert.equal(m.windows[0]!.prCi.measured, false);
      assert.equal(m.slowTests.budgetS, 30, 'config.yaml metrics.slow_test_budget_s, 30 by default');
      assert.deepEqual(m.slowTests.overBudget!.map((t) => t.name), ['db > migrates']);
      assert.ok(m.definitions.some((x) => /^Slow tests:/.test(x)));
    }
    assert.equal((await call('someone-else')).status, 403);
    assert.equal((await call('example-owner', { method: 'POST', body: '{}' })).status, 405);
  } finally {
    await d.close();
  }
});
