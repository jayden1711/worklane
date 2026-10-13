// Flaky tests (src/flaky.ts, src/coordinator/flaky.ts): a red default branch re-runs its failing checks on the same
// commit first. Green on the re-run: flaky, quarantined, one issue per test however often it's seen, and nothing red
// for the harness (no stop, no revert, no fix). Red again: real. A quarantined test blocks again after N passes in a
// row or an owner's clear; the flake rate is flaky re-runs over red runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backlog, RerunJobs } from '../src/backlog/types.js';
import { GitHubBacklog } from '../src/backlog/github.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { FlakyGate, type FlakyConfig } from '../src/coordinator/flaky.js';
import type { TestRuns } from '../src/coordinator/pr-batch.js';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { flakeRates, flakyView, quarantine, releaseByOwner } from '../src/flaky.js';
import type { RequiredCheck } from '../src/pr-watch.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const sha = (n: number) => n.toString(16).padStart(40, 'a');

function fixture(o: { cfg?: Partial<FlakyConfig>; rerun?: boolean; testRuns?: TestRuns | null; tiers?: { name: string; kind: 'fast' | 'full' }[] } = {}) {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'flaky-')), 'events.db'));
  const issues: { title: string; body: string; labels: string[] }[] = [];
  const comments: { n: number; body: string }[] = [];
  const reruns: number[][] = [];
  const backlog = {
    createIssue: async (title: string, body: string, labels: string[]) => {
      issues.push({ title, body, labels });
      return 100 + issues.length;
    },
    comment: async (n: number, body: string) => {
      comments.push({ n, body });
    },
    ...(o.rerun === false
      ? {}
      : {
          rerunFailedJobs: async (ids: number[]) => {
            reruns.push(ids);
            return new Map<number, RerunJobs>(ids.map((id) => [id, { ok: true, run: 7 }]));
          },
        }),
  } as unknown as Backlog;
  let now = Date.parse('2026-10-13T12:00:00Z');
  const gate = new FlakyGate({
    log,
    actor: 'inst',
    backlog,
    config: () => ({ rerun: true, release_after_passes: 3, rerun_timeout_min: 60, ...o.cfg }),
    repo: 'example/repo',
    branch: 'main',
    clone: '/nonexistent',
    testRuns: o.testRuns ?? null,
    tiers: () => o.tiers ?? [],
    fetch: () => undefined,
    now: () => now,
  });
  return { log, gate, issues, comments, reruns, tick: (ms: number) => (now += ms), types: () => log.read().map((e) => e.type) };
}

const check = (name: string, outcome: RequiredCheck['outcome'], id?: number): RequiredCheck => ({ name, outcome, ...(id !== undefined ? { id } : {}) });
const failedOf = (r: Awaited<ReturnType<FlakyGate['judge']>>) => {
  assert.equal(r.wait, false);
  return r.wait ? [] : r.outcomes.filter((c) => c.outcome === 'fail' || c.outcome === 'cancelled').map((c) => c.name);
};

test('red, then green on the re-run of the same commit: flaky, quarantined, one issue, and nothing red (no fix)', async () => {
  const f = fixture();
  const first = await f.gate.judge({ sha: sha(1), number: 5, outcomes: [check('ci', 'fail', 11), check('lint', 'pass', 12)] });
  assert.deepEqual(first, { wait: true }, 'the failure waits for its re-run');
  assert.deepEqual(f.reruns, [[11]], "the failing job's workflow run is re-run");
  // The re-run is going: the check run that replaces the failing one is in progress.
  assert.deepEqual(await f.gate.judge({ sha: sha(1), number: 5, outcomes: [check('ci', 'pending', 13), check('lint', 'pass', 12)] }), { wait: true });
  const r = await f.gate.judge({ sha: sha(1), number: 5, outcomes: [check('ci', 'pass', 13), check('lint', 'pass', 12)] });
  assert.deepEqual(failedOf(r), [], 'not red: nothing to stop, revert or fix');
  assert.ok(!r.wait && r.flaky.includes('ci'));
  assert.equal(f.issues.length, 1, 'one issue');
  assert.equal(f.issues[0]!.title, 'Flaky test: ci');
  assert.deepEqual(f.issues[0]!.labels, [], 'not labelled ready: no agent picks it up to fix');
  const q = quarantine(f.log.read()).get('ci')!;
  assert.equal(q.state, 'quarantined');
  assert.equal(q.sightings, 1);
  assert.equal(q.issue, 101);
  assert.equal(q.url, 'https://github.com/example/repo/issues/101');
  const types = f.types();
  assert.ok(types.includes('flaky.rerun_requested') && types.includes('flaky.rerun_result') && types.includes('flaky.quarantined'), 'every step is an event');
  const view = flakyView(f.log.read(), { now: new Date('2026-10-13T13:00:00Z'), releaseAfter: 3 });
  assert.deepEqual(view.quarantined.map((t) => t.test), ['ci'], 'a dashboard row');
});

test('red, then red again on the re-run: a real failure, handed on; nothing quarantined, no issue', async () => {
  const f = fixture();
  assert.deepEqual(await f.gate.judge({ sha: sha(2), number: 6, outcomes: [check('ci', 'fail', 21)] }), { wait: true });
  // The same failing check run (the re-run hasn't replaced it yet) is no verdict.
  assert.deepEqual(await f.gate.judge({ sha: sha(2), number: 6, outcomes: [check('ci', 'fail', 21)] }), { wait: true });
  const r = await f.gate.judge({ sha: sha(2), number: 6, outcomes: [check('ci', 'fail', 22)] });
  assert.deepEqual(failedOf(r), ['ci'], 'red: the stop and revert follow');
  assert.equal(f.issues.length, 0);
  assert.equal(quarantine(f.log.read()).size, 0);
  const result = f.log.read(0, ['flaky.rerun_result']).at(-1)!.payload as { real: string[]; flaky: string[] };
  assert.deepEqual([result.real, result.flaky], [['ci'], []]);
  // Judged again later (the merge flow's next poll): the same verdict, no second re-run.
  assert.deepEqual(failedOf(await f.gate.judge({ sha: sha(2), number: 6, outcomes: [check('ci', 'fail', 22)] })), ['ci']);
  assert.equal(f.reruns.length, 1);
});

test("a re-run that doesn't finish in rerun_timeout_min is a real failure", async () => {
  const f = fixture({ cfg: { rerun_timeout_min: 30 } });
  await f.gate.judge({ sha: sha(3), number: null, outcomes: [check('ci', 'fail', 31)] });
  f.tick(29 * 60_000);
  assert.deepEqual(await f.gate.judge({ sha: sha(3), number: null, outcomes: [check('ci', 'pending', 32)] }), { wait: true });
  f.tick(60_000);
  const r = await f.gate.judge({ sha: sha(3), number: null, outcomes: [check('ci', 'pending', 32)] });
  assert.deepEqual(failedOf(r), ['ci'], 'pending past the timeout counts as failed, not as still running');
  assert.deepEqual((f.log.read(0, ['flaky.rerun_result']).at(-1)!.payload as { timed_out: string[] }).timed_out, ['ci']);
});

test("a check that can't be re-run (a commit status; a tracker without Actions) is real at once, as before", async () => {
  const f = fixture({ rerun: false });
  const r = await f.gate.judge({ sha: sha(4), number: 1, outcomes: [check('ci', 'fail', 41)] });
  assert.deepEqual(failedOf(r), ['ci']);
  const g = fixture();
  assert.deepEqual(failedOf(await g.gate.judge({ sha: sha(4), number: 1, outcomes: [check('status-ci', 'fail')] })), ['status-ci'], 'a status has no check run to re-run');
  const off = fixture({ cfg: { rerun: false } });
  assert.deepEqual(failedOf(await off.gate.judge({ sha: sha(4), number: 1, outcomes: [check('ci', 'fail', 41)] })), ['ci'], 'flaky.rerun: false');
  assert.equal(off.reruns.length, 0);
});

test('a re-run waits for the rest of the checks to finish first (a workflow run still going cannot re-run its failed jobs)', async () => {
  const f = fixture();
  const r = await f.gate.judge({ sha: sha(5), number: 1, outcomes: [check('ci', 'fail', 51), check('slow', 'pending', 52)] });
  assert.ok(!r.wait);
  assert.deepEqual(
    r.wait ? [] : r.outcomes.map((c) => c.outcome),
    ['pending', 'pending'],
    'counted as still running, so nothing is judged red yet',
  );
  assert.equal(f.reruns.length, 0);
});

test('the same flaky test twice: one issue, and its sightings go up', async () => {
  const f = fixture();
  // Two red commits re-run before either re-run is in: both found flaky.
  await f.gate.judge({ sha: sha(6), number: 6, outcomes: [check('ci', 'fail', 61)] });
  await f.gate.judge({ sha: sha(7), number: 7, outcomes: [check('ci', 'fail', 71)] });
  assert.deepEqual(failedOf(await f.gate.judge({ sha: sha(6), number: 6, outcomes: [check('ci', 'pass', 62)] })), []);
  assert.deepEqual(failedOf(await f.gate.judge({ sha: sha(7), number: 7, outcomes: [check('ci', 'pass', 72)] })), []);
  assert.equal(f.issues.length, 1, 'deduped: one issue for the test');
  let q = quarantine(f.log.read()).get('ci')!;
  assert.equal(q.sightings, 2);
  assert.equal(q.issue, 101);
  // Failing again later, quarantined: one more sighting, still one issue, and nothing red.
  assert.deepEqual(failedOf(await f.gate.judge({ sha: sha(8), number: 8, outcomes: [check('ci', 'fail', 81)] })), []);
  q = quarantine(f.log.read()).get('ci')!;
  assert.equal(q.sightings, 3);
  assert.equal(f.issues.length, 1);
  assert.equal(f.log.read(0, ['flaky.sighted']).length, 2, 'each sighting is an event');
  const row = flakyView(f.log.read(), { now: new Date(), releaseAfter: 3 }).quarantined[0]!;
  assert.deepEqual([row.test, row.sightings, row.issue], ['ci', 3, 101], 'the dashboard row shows it');
});

test('a quarantined test: its failure turns nothing red and is not re-run; N passes in a row release it (a failure resets them)', async () => {
  const f = fixture({ cfg: { release_after_passes: 3 } });
  await f.gate.judge({ sha: sha(8), number: 8, outcomes: [check('ci', 'fail', 81)] });
  await f.gate.judge({ sha: sha(8), number: 8, outcomes: [check('ci', 'pass', 82)] });
  assert.equal(quarantine(f.log.read()).get('ci')!.passes, 0, 'the commit it was found flaky on is not a pass toward release');
  const judge = (n: number, outcome: RequiredCheck['outcome']) => f.gate.judge({ sha: sha(n), number: n, outcomes: [check('ci', outcome, n * 10)] });
  // Quarantined: a failure is counted as passed for the harness, and not re-run.
  const r = await judge(9, 'fail');
  assert.deepEqual(failedOf(r), []);
  assert.ok(!r.wait && r.quarantined.includes('ci'));
  assert.equal(f.reruns.length, 1, 'only the first failure was re-run');
  await judge(10, 'pass');
  await judge(11, 'pass');
  await judge(12, 'fail'); // resets the run of passes
  assert.equal(quarantine(f.log.read()).get('ci')!.passes, 0);
  await judge(13, 'pass');
  await judge(14, 'pass');
  assert.equal(quarantine(f.log.read()).get('ci')!.state, 'quarantined', 'two passes: still quarantined');
  await judge(15, 'pass');
  const t = quarantine(f.log.read()).get('ci')!;
  assert.equal(t.state, 'released', 'released after 3 passes in a row');
  assert.equal(t.released!.how, 'passes');
  assert.ok(f.comments.some((c) => c.n === 101 && /passed 3 times in a row/.test(c.body)), 'said on its issue');
  // Judging the same commit again doesn't count it twice.
  assert.equal(f.log.read(0, ['flaky.observed']).filter((e) => (e.payload as { sha: string }).sha === sha(15)).length, 1);
  // Released: it blocks again, so its next failure is re-run.
  assert.deepEqual(await judge(16, 'fail'), { wait: true });
  assert.equal(f.reruns.length, 2);
  // Flaky again: quarantined again on the same issue, which is told.
  await f.gate.judge({ sha: sha(16), number: 16, outcomes: [check('ci', 'pass', 161)] });
  assert.equal(f.issues.length, 1, 'no second issue');
  assert.equal(quarantine(f.log.read()).get('ci')!.state, 'quarantined');
  assert.ok(f.comments.some((c) => c.n === 101 && /quarantined again/.test(c.body)));
});

test('an owner clears a test from quarantine; a test not quarantined is refused', async () => {
  const f = fixture();
  await f.gate.judge({ sha: sha(17), number: 1, outcomes: [check('ci', 'fail', 171)] });
  await f.gate.judge({ sha: sha(17), number: 1, outcomes: [check('ci', 'pass', 172)] });
  assert.deepEqual(releaseByOwner(f.log, 'other', 'example-owner'), { ok: false, status: 404, error: 'other is not quarantined' });
  assert.deepEqual(releaseByOwner(f.log, ' ', 'example-owner'), { ok: false, status: 400, error: 'name the test (the check) to clear' });
  assert.deepEqual(releaseByOwner(f.log, 'ci', 'example-owner'), { ok: true });
  const t = quarantine(f.log.read()).get('ci')!;
  assert.equal(t.state, 'released');
  assert.deepEqual([t.released!.how, t.released!.by], ['owner', 'example-owner']);
  assert.deepEqual(await f.gate.judge({ sha: sha(18), number: 1, outcomes: [check('ci', 'fail', 181)] }), { wait: true }, 'it blocks again: its next failure is re-run before anything');
});

test('a test-run check is re-run by running its tiers again on the same commit, and its checks posted again', async () => {
  const runs: { sha: string; kind: string }[] = [];
  const posted: string[] = [];
  let pass = true;
  const testRuns: TestRuns = {
    startTestRun: async (req) => {
      runs.push({ sha: req.sha, kind: req.kind });
      return { id: 'r1', sha: req.sha, kind: req.kind, ok: pass, outcome: 'done', tiers: [{ tier: 'unit', ok: pass, durationMs: 1, summary: '', logRef: 'r1/unit.log' }] };
    },
    postChecks: async (s) => {
      posted.push(s);
    },
    checkNames: () => ({ unit: 'test-run/unit' }),
  };
  const f = fixture({ testRuns, tiers: [{ name: 'unit', kind: 'full' }], rerun: false });
  assert.deepEqual(await f.gate.judge({ sha: sha(19), number: 2, outcomes: [check('test-run/unit', 'fail', 191)] }), { wait: true });
  await new Promise((r) => setImmediate(r));
  const r = await f.gate.judge({ sha: sha(19), number: 2, outcomes: [check('test-run/unit', 'fail', 191)] });
  assert.deepEqual(failedOf(r), [], 'passed on the re-run: flaky');
  assert.deepEqual(runs, [{ sha: sha(19), kind: 'full' }]);
  assert.deepEqual(posted, [sha(19)]);
  assert.equal(f.issues.length, 1);
  pass = false;
  const g = fixture({ testRuns, tiers: [{ name: 'unit', kind: 'full' }], rerun: false });
  await g.gate.judge({ sha: sha(21), number: 3, outcomes: [check('test-run/unit', 'fail', 211)] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(failedOf(await g.gate.judge({ sha: sha(21), number: 3, outcomes: [check('test-run/unit', 'fail', 211)] })), ['test-run/unit'], 'failed again: real');
});

test('the flake rate: flaky re-runs over red runs, over 7 and 30 days', () => {
  const at = (days: number) => new Date(Date.parse('2026-10-13T00:00:00Z') - days * 86_400_000).toISOString();
  let id = 0;
  const ev = (type: string, ts: string, payload: object): StoredEvent => ({ id: ++id, ts, type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
  const red = (n: number, days: number, flaky: boolean) => [
    ev('flaky.rerun_requested', at(days), { sha: sha(n), number: null, failed: ['ci'], via: [], at: at(days) }),
    ev('flaky.rerun_result', at(days), { sha: sha(n), number: null, flaky: flaky ? ['ci'] : [], real: flaky ? [] : ['ci'], timed_out: [] }),
  ];
  const events = [...red(1, 1, true), ...red(2, 2, false), ...red(3, 3, false), ...red(4, 4, true), ...red(5, 10, true), ...red(6, 20, false), ...red(7, 40, true)];
  assert.deepEqual(flakeRates(events, new Date('2026-10-13T00:00:00Z')), [
    { days: 7, redRuns: 4, flakyReruns: 2, rate: 0.5 },
    { days: 30, redRuns: 6, flakyReruns: 3, rate: 0.5 },
  ]);
  assert.deepEqual(flakeRates([], new Date()), [
    { days: 7, redRuns: 0, flakyReruns: 0, rate: null },
    { days: 30, redRuns: 0, flakyReruns: 0, rate: null },
  ]);
});

test("GitHub: each failing job's workflow run is re-run once, through rerun-failed-jobs; a refusal says why", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    const job = /\/actions\/jobs\/(\d+)$/.exec(path);
    if (job) return new Response(JSON.stringify({ run_id: job[1] === '3' ? 900 : 800 }), { status: 200 });
    if (path.endsWith('/runs/900/rerun-failed-jobs')) return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
    return new Response('{}', { status: 201 });
  }) as unknown as typeof fetch;
  const gh = new GitHubBacklog('example/repo', () => 't', fetchImpl, 'https://api.example');
  const r = await gh.rerunFailedJobs([1, 2, 3]);
  assert.deepEqual(r.get(1), { ok: true, run: 800 });
  assert.deepEqual(r.get(2), { ok: true, run: 800 });
  assert.equal(r.get(3)!.ok, false);
  assert.equal((r.get(3) as { why: string }).why, 'forbidden');
  assert.deepEqual(
    calls.filter((c) => c.startsWith('POST')),
    ['POST /repos/example/repo/actions/runs/800/rerun-failed-jobs', 'POST /repos/example/repo/actions/runs/900/rerun-failed-jobs'],
    'one re-run per workflow run',
  );
});

test('dashboard: owners and writers read the flaky tests; only an owner clears one, and it is audited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flaky-dash-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  log.append('flaky.quarantined', { test: 'ci', sha: sha(1), issue: 101, url: 'https://github.com/example/repo/issues/101', again: false }, 'c');
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), pollMs: 50 });
  const base = d.url.split('/?')[0]!;
  const req = (path: string, who: string, body?: object) =>
    fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(who) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await req('/api/flaky', 'someone-else')).status, 403, 'not a viewer\'s');
    const w = (await (await req('/api/flaky', 'example-collaborator')).json()) as { quarantined: { test: string; issue: number }[]; canClear: boolean; releaseAfter: number };
    assert.deepEqual([w.quarantined.map((t) => [t.test, t.issue]), w.canClear, w.releaseAfter], [[['ci', 101]], false, 10]);
    assert.equal((await req('/api/flaky/clear', 'example-collaborator', { test: 'ci' })).status, 403, 'a writer may not clear it');
    assert.equal((await req('/api/flaky/clear', 'example-owner', { test: 'nope' })).status, 404);
    assert.equal((await req('/api/flaky/clear', 'example-owner', { test: 'ci' })).status, 200);
    const o = (await (await req('/api/flaky', 'example-owner')).json()) as { quarantined: unknown[]; released: { test: string; released: { by: string } }[] };
    assert.deepEqual([o.quarantined.length, o.released[0]!.test, o.released[0]!.released.by], [0, 'ci', 'example-owner']);
    assert.ok(log.read(0, ['dashboard.audit']).some((e) => (e.payload as { action: string }).action === 'flaky.cleared'), 'audited');
  } finally {
    await d.close();
  }
});
