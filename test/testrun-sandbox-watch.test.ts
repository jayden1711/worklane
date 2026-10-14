// WHY: a sandbox check that failed once at coordinator start switched test runs off for the life of the process,
// with nothing in the journal and no check on any PR. These tests hold the fix: the failure and the recovery are in
// the journal; the watchdog's test_sandbox incident is raised (dashboard, ops channel) and resolved; the check is
// run again with a backoff, never twice at once; and when it passes the running coordinator runs the PRs, each of
// which had a check saying test runs are off. A sandbox whose check fails still runs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { PrTestRuns, type OpenPr } from '../src/coordinator/test-runs.js';
import { postChecks, SANDBOX_TITLE } from '../src/testrun/checks.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { HELPER_PROTOCOL } from '../src/testrun/helper.js';
import { localHost, type RunHost } from '../src/testrun/host.js';
import { checkNamesFor, startTestRun, useTestRuns } from '../src/testrun/index.js';
import { runTestRun, SANDBOX_STEP, type TestRunDeps } from '../src/testrun/run.js';
import { SANDBOX_RETRY_MAX_MS, SANDBOX_RETRY_MS, sandboxRetryMs, SandboxWatch } from '../src/testrun/sandbox-watch.js';
import { setupTestRuns } from '../src/testrun/setup.js';
import { testRunStatus } from '../src/testrun/status.js';
import { readIncidents } from '../src/watchdog/incidents.js';
import { incidentsView } from '../src/watchdog/view.js';
import { Watchdog } from '../src/watchdog/watchdog.js';
import { exampleProject } from './helpers.js';

const posix = process.platform !== 'win32';
const hasPerl = posix && (() => {
  try {
    execFileSync('perl', ['-e', '1']);
    return true;
  } catch {
    return false;
  }
})();
const FAIL = 'FAIL in the sandbox (exit 226): the probe printed nothing';
const failing = { ok: false, detail: FAIL };
const passing = { ok: true, detail: 'all checks passed' };

/** One-shot timers that fire only when the test says so, with every delay asked for. */
function timers() {
  const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const delays: number[] = [];
  return {
    delays,
    pending,
    timer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      pending.push(t);
      delays.push(ms);
      return { cancel: () => void (t.cancelled = true) };
    },
    /** Fire the newest timer, if it is still wanted. */
    fire: () => {
      const t = pending.pop();
      if (t && !t.cancelled) t.fn();
    },
  };
}

async function until(what: () => boolean, why: string) {
  for (let i = 0; i < 400 && !what(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(what(), why);
}

function fakeGitHub() {
  const calls: { name: string; sha: string; conclusion: string; title: string; summary: string }[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body ?? '{}')) as { name: string; head_sha: string; conclusion: string; output: { title: string; summary: string } };
    calls.push({ name: b.name, sha: b.head_sha, conclusion: b.conclusion, title: b.output.title, summary: b.output.summary });
    return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

/** A sandbox host that answers its helper's version and whose check says what the test queued; every call is named. */
function sandbox(results: { ok: boolean; detail: string }[]) {
  const calls: string[] = [];
  const refuse = (what: string) => async () => {
    calls.push(what);
    throw new Error(`${what} was called`);
  };
  const host = {
    kind: 'sandbox',
    helperVersion: async () => (calls.push('version'), { version: HELPER_PROTOCOL, stderr: '' }),
    check: async () => {
      calls.push('check');
      const r = results.shift();
      if (!r) throw new Error('no answer queued');
      return r;
    },
    wipe: async (id: string) => (calls.push(`wipe ${id}`), { ok: true, left: [] }),
    create: refuse('create'),
    exec: refuse('exec'),
    startDb: refuse('db-start'),
    cache: refuse('cache'),
    shared: refuse('shared'),
    changedFiles: refuse('changed-files'),
  } as unknown as RunHost;
  return { host, calls };
}

const testRun = { tiers: [{ name: 'unit', command: 'echo unit ok', kind: 'fast' }], checks: { unit: 'test / unit' } };

test('the backoff: 30 s, 1 min, 2 min, then every 5 min', () => {
  assert.deepEqual([...SANDBOX_RETRY_MS], [30_000, 60_000, 120_000]);
  assert.equal(SANDBOX_RETRY_MAX_MS, 300_000);
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(sandboxRetryMs), [30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
});

test('a failing check is run again on that backoff until it passes, then no more; one event per change, not one per check', async () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'sbx-watch-')), 'events.db'));
  const t = timers();
  const other = { ok: false, detail: 'FAIL wl-test-shop can reach /srv/worklane (open)' };
  const results = [failing, failing, failing, other, other, failing, passing];
  let passed = 0;
  let checks = 0;
  const said: string[] = [];
  const w = new SandboxWatch({ check: async () => (checks++, results.shift()!), log, actor: 'shop', timer: t.timer, say: (l) => said.push(l), passed: () => void passed++ });
  assert.equal(w.ok, false, 'not ok before any check passed');
  assert.equal(await w.check(), false);
  for (let i = 0; i < 6; i++) {
    assert.equal(t.pending.filter((x) => !x.cancelled).length, 1, 'exactly one re-check waits while it fails');
    t.fire();
    await until(() => checks === i + 2 && (w.ok || t.pending.length === 1), `check ${i + 2} ran`);
  }
  assert.deepEqual(t.delays, [30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
  assert.equal(w.ok, true);
  assert.equal(passed, 1, 'the runs are told once');
  assert.equal(t.pending.length, 0, 'no re-check once it passed');
  assert.equal(checks, 7);
  const events = log.read(0, ['testrun.sandbox']).map((e) => e.payload as EventPayload<'testrun.sandbox'>);
  assert.deepEqual(events.map((e) => [e.ok, e.detail]), [[false, FAIL], [false, other.detail], [false, FAIL], [true, 'all checks passed']]);
  // The journal: the FAIL lines the first time and when they change; the recovery, with how long it was off.
  assert.equal(said.length, 7);
  assert.match(said[0]!, /^test runs are OFF: the test sandbox check failed \(1 in a row\); no test run starts until it passes\. Checked again in 30 s;/);
  assert.ok(said[0]!.includes(`\n  ${FAIL}`), said[0]);
  assert.match(said[1]!, /\(2 in a row\).*Checked again in 1 min.*The same failure as before\.$/);
  assert.ok(said[3]!.includes(`\n  ${other.detail}`), 'new FAIL lines are said');
  assert.match(said[3]!, /Checked again in 5 min/);
  assert.match(said[6]!, /^test runs are on again: the test sandbox check passed, after 6 failed checks/);
});

test('never two checks at once: a call while one runs gets that one, and a check that throws did not pass', async () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'sbx-watch-')), 'events.db'));
  const t = timers();
  let running = 0;
  let most = 0;
  let calls = 0;
  let release: (r: { ok: boolean; detail: string }) => void = () => undefined;
  const check = () =>
    new Promise<{ ok: boolean; detail: string }>((resolve, reject) => {
      calls++;
      most = Math.max(most, ++running);
      release = (r) => {
        running--;
        if (r.detail === 'throw') reject(new Error('sudo: a password is required'));
        else resolve(r);
      };
    });
  const w = new SandboxWatch({ check, log, actor: 'shop', timer: t.timer, say: () => undefined });
  const a = w.check();
  const b = w.check();
  const c = w.check();
  assert.equal(calls, 1);
  release({ ok: false, detail: 'throw' });
  assert.deepEqual(await Promise.all([a, b, c]), [false, false, false]);
  assert.equal(w.ok, false);
  assert.equal(w.detail, "the check didn't run: sudo: a password is required");
  // The timer's check and a caller's at the same moment: still one.
  t.fire();
  const d = w.check();
  assert.equal(calls, 2);
  release(passing);
  assert.equal(await d, true);
  assert.equal(most, 1, 'never two at once');
  // Stopped: nothing more is scheduled.
  const w2 = new SandboxWatch({ check: async () => failing, log, actor: 'shop', timer: t.timer, say: () => undefined });
  w2.stop();
  await w2.check();
  assert.equal(t.pending.filter((x) => !x.cancelled).length, 0);
});

test('the journal: without a `say`, the failure with its FAIL lines and the recovery go to stderr', async () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'sbx-watch-')), 'events.db'));
  const t = timers();
  const results = [failing, passing];
  const real = console.error;
  const err: string[] = [];
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  try {
    const w = new SandboxWatch({ check: async () => results.shift()!, log, actor: 'shop', timer: t.timer });
    await w.check();
    t.fire();
    await until(() => w.ok, 'passed');
  } finally {
    console.error = real;
  }
  assert.equal(err.length, 2);
  assert.match(err[0]!, /^test runs are OFF: the test sandbox check failed/);
  assert.ok(err[0]!.includes(FAIL));
  assert.match(err[1]!, /^test runs are on again: the test sandbox check passed, after 1 failed check over /);
});

test('regression: a sandbox check that fails at coordinator start no longer switches test runs off for good: journal, incident (dashboard and ops channel), re-check, runs on with no restart', async () => {
  const p = exampleProject();
  const base = mkdtempSync(join(tmpdir(), 'sbx-setup-'));
  const log = new EventLog(join(base, 'events.db'));
  const incidents = join(base, 'incidents');
  mkdirSync(incidents);
  const t = timers();
  const said: string[] = [];
  const s = sandbox([failing, failing, passing]);
  const config = TestRunConfig.parse(testRun);
  const cfg = { tests: { test_run: config, checkout: { sparse_exclude: [] } } } as unknown as Config;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
  // The watchdog as a coordinator runs it, on this instance's log, posting to a stand-in ops channel.
  const posts: string[] = [];
  let now = Date.parse('2026-10-13T21:05:22Z');
  const dog = new Watchdog({
    instance: 'shop',
    dir: incidents,
    events: () => log.read(0),
    stop: () => null,
    emergency: () => false,
    instances: () => ['shop'],
    units: () => null,
    updates: () => [],
    disks: () => [],
    config: () => ({ stallHours: 6, diskPct: 85, opsChannel: null, dashboardUrl: null }),
    poster: () => ({ poster: async (c: string) => (posts.push(c), true), dashboardUrl: 'https://dash.example.test', secrets: [] }),
    now: () => new Date(now),
  });
  const watchdogPass = async () => {
    now += 60_000;
    await dog.pass();
  };
  const open = () => readIncidents(incidents).incidents.filter((x) => x.kind === 'test_sandbox' && !x.resolvedAt);
  try {
    const runs = await setupTestRuns(cfg, { instance: 'shop', repo: 'example-org/example-shop', token: async () => 't', host: s.host, say: (l) => said.push(l), timer: t.timer }, { log, actor: 'shop', root: p.dir, stateDir: p.stateDir });

    // Set up all the same, and waiting: the coordinator goes on, and has something to tick.
    assert.ok(runs, 'a failed check at start still sets the test runs up');
    assert.equal(runs.ready(), false);
    assert.deepEqual(s.calls, ['version', 'check']);
    assert.deepEqual(t.delays, [30_000], 'the check runs again in 30 s');

    // 1. The journal.
    assert.equal(said.length, 1);
    assert.match(said[0]!, /^test runs are OFF: the test sandbox check failed/);
    assert.ok(said[0]!.includes(FAIL), said[0]);

    // 2. The alert: the event, the health line, the watchdog's incident on the Health page and in the ops channel.
    assert.deepEqual(log.read(0, ['testrun.sandbox']).map((e) => (e.payload as EventPayload<'testrun.sandbox'>).ok), [false]);
    assert.match(testRunStatus(log.read(0)).problems[0]!, /^Test runs are off: the sandbox failed its check \(FAIL in the sandbox/);
    await watchdogPass();
    assert.deepEqual(open().map((x) => [x.kind, x.key, x.instance, x.severity]), [['test_sandbox', 'shop', 'shop', 'red']]);
    assert.ok(open()[0]!.detail.includes(FAIL));
    assert.match(open()[0]!.fix, /test-user\.sh check shop\) and fix its FAIL lines; no restart needed$/);
    assert.equal(posts.length, 1, 'posted to the ops channel');
    assert.match(posts[0]!, /The test sandbox check is failing/);
    const page = incidentsView({ dir: incidents, instance: 'shop', full: true });
    assert.equal(page.status, 'red');
    assert.deepEqual(page.open.map((x) => x.kind), ['test_sandbox']);

    // 5. While it fails nothing runs: a run is refused before the host is asked for anything.
    const refused = await startTestRun({ repo: p.dir, sha, kind: 'fast', prs: [1] });
    assert.deepEqual([refused.ok, refused.outcome, refused.setup?.step], [false, 'error', SANDBOX_STEP]);
    assert.ok(refused.setup!.stderr.includes(FAIL));
    assert.deepEqual(s.calls, ['version', 'check'], 'no create, no exec, no database');
    assert.equal(log.read(0, ['testrun.started']).length, 0);

    // 3. The re-check: it fails again (the incident stays one, one post), then passes.
    t.fire();
    await until(() => s.calls.length === 3 && t.pending.length === 1, 'the second check ran');
    assert.deepEqual(t.delays, [30_000, 60_000]);
    assert.equal(runs.ready(), false);
    await watchdogPass();
    assert.equal(open().length, 1);
    assert.equal(posts.length, 1);
    assert.equal(log.read(0, ['testrun.sandbox']).length, 1, 'the same failure is one event');

    t.fire();
    await until(() => runs.ready(), 'the third check passed');
    assert.equal(t.pending.length, 0, 'and no further check is scheduled');
    assert.match(said.at(-1)!, /^test runs are on again: the test sandbox check passed, after 2 failed checks/);
    assert.deepEqual(log.read(0, ['testrun.sandbox']).map((e) => (e.payload as EventPayload<'testrun.sandbox'>).ok), [false, true]);
    assert.deepEqual(testRunStatus(log.read(0)).problems, []);
    await watchdogPass();
    assert.equal(open().length, 0, 'the incident resolves');
    assert.equal(posts.length, 2);
    assert.match(posts[1]!, /^\*\*Resolved\*\*/);
    assert.equal(incidentsView({ dir: incidents, instance: 'shop', full: true }).status, 'green');

    runs.stop();
  } finally {
    useTestRuns(null);
    log.close();
  }
});

test('a check that passes at start: nothing in the journal, no re-check, the runs ready at once (as before)', async () => {
  const p = exampleProject();
  const base = mkdtempSync(join(tmpdir(), 'sbx-setup-'));
  const log = new EventLog(join(base, 'events.db'));
  const t = timers();
  const said: string[] = [];
  const s = sandbox([passing]);
  const cfg = { tests: { test_run: TestRunConfig.parse(testRun), checkout: { sparse_exclude: [] } } } as unknown as Config;
  try {
    const runs = await setupTestRuns(cfg, { instance: 'shop', repo: 'example-org/example-shop', token: async () => 't', host: s.host, say: (l) => said.push(l), timer: t.timer }, { log, actor: 'shop', root: p.dir, stateDir: p.stateDir });
    assert.ok(runs);
    assert.equal(runs.ready(), true);
    assert.deepEqual([said, t.delays], [[], []]);
    assert.deepEqual(log.read(0, ['testrun.sandbox']).map((e) => e.payload), [{ ok: true, detail: 'all checks passed' }]);
    // A host that isn't the sandbox can never pass: no test runs, as before.
    const local = { ...s.host, kind: 'local' } as unknown as RunHost;
    assert.equal(await setupTestRuns(cfg, { instance: 'shop', repo: 'example-org/example-shop', token: async () => 't', host: local, say: (l) => said.push(l), timer: t.timer }, { log, actor: 'shop', root: p.dir, stateDir: p.stateDir }), undefined);
    assert.deepEqual(t.delays, []);
  } finally {
    useTestRuns(null);
    log.close();
  }
});

test('while the check fails each open PR head gets one failing check that says test runs are off and why; once it passes the same heads run and their checks replace it', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const p = exampleProject();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).trim();
  const base = mkdtempSync(join(tmpdir(), 'sbx-prs-'));
  const slots = join(base, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 2 }));
  const lockPath = join(base, 'full-run.lock');
  writeFileSync(lockPath, '');
  const log = new EventLog(join(base, 'events.db'));
  const hostDir = join(base, 'host');
  const host = localHost(hostDir);
  const config = TestRunConfig.parse(testRun);
  const names = checkNamesFor(config);
  const t = timers();
  const results = [failing, passing];
  let runs: PrTestRuns | null = null;
  const watch = new SandboxWatch({ check: async () => results.shift()!, log, actor: 'shop', timer: t.timer, say: () => undefined, passed: () => runs?.sandboxPassed() });
  const deps: TestRunDeps = { config, host, repo: p.dir, log, actor: 'shop', logDir: join(base, 'logs'), lockPath, slotsDir: slots, slotPollMs: 50, sandbox: watch };
  const gh = fakeGitHub();
  let prs: OpenPr[] = [];
  let now = 0;
  runs = new PrTestRuns({
    log,
    actor: 'shop',
    repo: p.dir,
    remote: 'origin',
    host,
    listPrs: async () => prs,
    fetchPr: (pr) => pr.headSha,
    changed: () => ['src/a.ts'],
    now: () => now,
    pollMs: 1000,
    start: (req, o) => runTestRun(deps, req, o),
    post: (s, r) => postChecks({ repo: 'example-org/example-shop', token: async () => 't', log, actor: 'shop', fetch: gh.f, api: 'https://gh.test' }, s, r, names),
    sandbox: watch,
  });
  const pr = (number: number): OpenPr => ({ number, headSha: sha, base: 'main', author: 'someone', bot: false });
  const pass = async () => {
    now += 5000;
    const r = await runs!.tick();
    await runs!.idle();
    return r.started;
  };
  try {
    await watch.check();
    prs = [pr(1), pr(2)];
    assert.deepEqual(await pass(), [1, 2]);
    assert.deepEqual(gh.calls.map((c) => [c.name, c.sha, c.conclusion, c.title]), [
      ['test / unit', sha, 'failure', SANDBOX_TITLE],
      ['test / unit', sha, 'failure', SANDBOX_TITLE],
    ]);
    for (const c of gh.calls) {
      assert.match(c.summary, /test runs are off on this instance: the test sandbox failed its own check, so no test run starts/);
      assert.match(c.summary, /checks it again by itself .* nothing to restart, and this check is replaced then/);
      assert.ok(c.summary.includes(FAIL), 'why: the FAIL lines');
      assert.match(c.summary, /- not run: unit/);
      assert.doesNotMatch(c.summary, /\(0 s\)/);
    }
    assert.equal(log.read(0, ['testrun.started']).length, 0, 'no run started');
    assert.ok(!existsSync(join(hostDir, 'runs')) || readdirSync(join(hostDir, 'runs')).length === 0, 'nothing was made on the host');
    // Listing after listing while it still fails: the same heads get no second check; a new PR gets its one.
    assert.deepEqual(await pass(), []);
    prs = [pr(1), pr(2), pr(3)];
    assert.deepEqual(await pass(), [3]);
    assert.equal(gh.calls.length, 3);

    // The check passes: the very next tick lists the PRs and runs each head for real, in this same process.
    t.fire();
    await until(() => watch.ok, 'the check passed');
    now += 1; // not a poll interval later: the pass itself makes the next tick list them
    const started = (await runs.tick()).started;
    await runs.idle();
    assert.deepEqual(started, [1, 2, 3]);
    assert.equal(log.read(0, ['testrun.started']).length, 3);
    const after = gh.calls.slice(3);
    assert.deepEqual(after.map((c) => [c.name, c.sha, c.conclusion, c.title]), [1, 2, 3].map(() => ['test / unit', sha, 'success', 'Passed']), 'the same check name on the same head: the newer check replaces "test runs are off"');
    // And they are done: no run again on the next listing.
    assert.deepEqual(await pass(), []);
    runs.stop();
  } finally {
    log.close();
  }
});
