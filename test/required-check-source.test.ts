// #727: each required check counts only from its pinned source (src/check-source.ts): the GitHub App that posts it or
// the Actions workflow file that runs it. The GitHub answers here are stand-ins for the REST API's, a spoofed same-name
// check from another App or workflow among them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GitHubBacklog } from '../src/backlog/github.js';
import type { CommitCheck } from '../src/backlog/types.js';
import { checkSourceDoctor, githubCheckApps, governanceRefusal, PinnedChecks, pinOf, type CheckPin } from '../src/check-source.js';
import { ProjectConfig } from '../src/config/schema.js';
import { GitHubMainWatchApi } from '../src/github/main-watch-api.js';
import { readiness } from '../src/pr-watch.js';
import { asJudged, repoRoot } from './helpers.js';
import { JUDGED_CASTS_ALLOWED, judgedCasts, RAW_READS_ALLOWED, rawCheckReads, testImports, typeErrors } from './raw-check-reads.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const CI_APP = 1111;
const SPOOF_APP = 2222;
const ACTIONS = 15368;
const approved = { head: HEAD, approved: true };

// An Actions check run's page is its own job in its suite's workflow run (run id = suite * 10 here, as workflowRun
// makes it); `page` overrides that, e.g. for a check run made through the API.
type Run = { id: number; name: string; app: number; suite: number; status?: string; conclusion?: string | null; page?: string };
const checkRun = (r: Run) => ({ id: r.id, name: r.name, status: r.status ?? 'completed', conclusion: r.conclusion === undefined ? 'success' : r.conclusion, html_url: r.page ?? (r.app === ACTIONS ? `https://github.com/o/r/actions/runs/${r.suite * 10}/job/${r.id}` : `https://github.example/o/r/runs/${r.id}`), app: { id: r.app, slug: r.app === ACTIONS ? 'github-actions' : `app-${r.app}` }, check_suite: { id: r.suite } });
const workflowRun = (suite: number, path: string, o: { repo?: string; sha?: string } = {}) => ({ id: suite * 10, html_url: `https://github.com/${o.repo ?? 'o/r'}/actions/runs/${suite * 10}`, check_suite_id: suite, path, head_sha: o.sha ?? HEAD, repository: { full_name: o.repo ?? 'o/r' } });

/** A stand-in GitHub REST API for repo o/r, branch main: check runs, statuses, workflow runs, protection and rules. */
function github(o: { runs: Run[]; statuses?: { context: string; state: string }[]; workflowRuns?: unknown[] | number; branch?: unknown; rules?: unknown[] | number }) {
  const calls: string[] = [];
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const f = (async (url: string) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    if (path.startsWith(`/repos/o/r/commits/${HEAD}/check-runs`)) return answer({ total_count: o.runs.length, check_runs: o.runs.map(checkRun) });
    if (path === `/repos/o/r/commits/${HEAD}/status`) return answer({ statuses: o.statuses ?? [] });
    if (path.startsWith(`/repos/o/r/actions/runs?head_sha=${HEAD}`)) return typeof o.workflowRuns === 'number' ? answer({ message: 'Resource not accessible by integration' }, o.workflowRuns) : answer({ total_count: (o.workflowRuns ?? []).length, workflow_runs: o.workflowRuns ?? [] });
    if (path === '/repos/o/r/branches/main') return answer(o.branch ?? { name: 'main', protection: { enabled: false, required_status_checks: { checks: [], contexts: [], enforcement_level: 'off' } } });
    if (path.startsWith('/repos/o/r/rules/branches/main')) return typeof o.rules === 'number' ? answer({ message: 'Upgrade to GitHub Pro' }, o.rules) : answer(o.rules ?? []);
    return answer({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  return { backlog: new GitHubBacklog('o/r', () => 't', f), calls };
}

/** The PR's readiness on HEAD for required `test`, judged as the coordinator judges it. */
async function judged(gh: ReturnType<typeof github>, configured: Record<string, CheckPin>, required = ['test']) {
  const pinned = new PinnedChecks({ backlog: gh.backlog, branch: () => 'main', repo: () => 'o/r', configured: () => configured });
  return readiness({ required, checks: await pinned.of(HEAD), head: HEAD, evaluated: approved });
}
const outcomes = (r: Awaited<ReturnType<typeof judged>>) => r.checks.map((c) => `${c.name} ${c.outcome}`);

test('a check pinned to app A and posted by app B is missing, and the PR is not ready; posted by A it passes', async () => {
  const pin = { test: { app_id: CI_APP } };
  const spoofed = await judged(github({ runs: [{ id: 1, name: 'test', app: SPOOF_APP, suite: 10 }] }), pin);
  assert.deepEqual(outcomes(spoofed), ['test missing']);
  assert.equal(spoofed.ready, false);
  // The real App's run still pending: the spoof's green beside it changes nothing.
  const both = await judged(github({ runs: [{ id: 1, name: 'test', app: SPOOF_APP, suite: 10 }, { id: 2, name: 'test', app: CI_APP, suite: 11, status: 'in_progress', conclusion: null }] }), pin);
  assert.deepEqual(outcomes(both), ['test pending']);
  const real = await judged(github({ runs: [{ id: 2, name: 'test', app: CI_APP, suite: 11 }] }), pin);
  assert.deepEqual(outcomes(real), ['test pass']);
  assert.equal(real.ready, true);
});

test('a check pinned to a workflow file and posted by another workflow (or a run elsewhere) is missing; from that workflow it passes', async () => {
  const pin = { test: { workflow: '.github/workflows/ci.yml' } };
  const runs = [{ id: 1, name: 'test', app: ACTIONS, suite: 70 }];
  const from = (w: unknown[] | number) => judged(github({ runs, workflowRuns: w }), pin);
  assert.deepEqual(outcomes(await from([workflowRun(70, '.github/workflows/evil.yml')])), ['test missing'], 'another workflow file');
  assert.deepEqual(outcomes(await from([workflowRun(70, '.github/workflows/ci.yml', { sha: OTHER })])), ['test missing'], 'a run for another commit posting onto this one');
  assert.deepEqual(outcomes(await from([workflowRun(70, '.github/workflows/ci.yml', { repo: 'fork/r' })])), ['test missing'], 'a run in another repo');
  assert.deepEqual(outcomes(await from([])), ['test missing'], 'a suite with no workflow run (a check run made through the API)');
  assert.deepEqual(outcomes(await from(403)), ['test missing'], 'Actions unreadable: no source, fail closed');
  assert.deepEqual(outcomes(await from([workflowRun(70, '.github/workflows/ci.yml')])), ['test pass']);
  // A check run in the pinned workflow's own suite that isn't one of its run's jobs (made through the API with the
  // run's token, guess: its page is /o/r/runs/<id>, not .../actions/runs/700/job/<id>) doesn't count.
  // Adversarial pass: the right path on another host, or over plain http, isn't the run's job page either.
  for (const page of ['https://github.com/o/r/runs/1', 'https://github.com/o/r/actions/runs/999/job/1', 'https://github.com/o/r/actions/runs/700/job/2', 'not a url', 'https://evil.example/o/r/actions/runs/700/job/1', 'http://github.com/o/r/actions/runs/700/job/1']) {
    const r = await judged(github({ runs: [{ id: 1, name: 'test', app: ACTIONS, suite: 70, page }], workflowRuns: [workflowRun(70, '.github/workflows/ci.yml')] }), pin);
    assert.deepEqual(outcomes(r), ['test missing'], page);
  }
  // Any App but Actions has no workflow run, however its check is named.
  assert.deepEqual(outcomes(await judged(github({ runs: [{ id: 1, name: 'test', app: SPOOF_APP, suite: 70 }], workflowRuns: [workflowRun(70, '.github/workflows/ci.yml')] }), pin)), ['test missing']);
});

test('a commit status with a pinned check name is missing: statuses carry no App', async () => {
  const gh = github({ runs: [], statuses: [{ context: 'test', state: 'success' }] });
  for (const pin of [{ app_id: CI_APP }, { workflow: '.github/workflows/ci.yml' }]) assert.deepEqual(outcomes(await judged(gh, { test: pin })), ['test missing']);
});

test("pinning never turns a check that wasn't a pass into one: another App's failing same-name check still fails it", async () => {
  const pin = { test: { app_id: CI_APP } };
  // The reviewer's fixture: an unpinned App's failing `test` listed before the pinned App's passing one.
  const r = await judged(github({ runs: [{ id: 1, name: 'test', app: SPOOF_APP, suite: 10, conclusion: 'failure' }, { id: 2, name: 'test', app: CI_APP, suite: 11 }] }), pin);
  assert.deepEqual(outcomes(r), ['test fail']);
  assert.equal(r.ready, false);
  assert.deepEqual(r.failed, [{ name: 'test', outcome: 'fail' }], "the blocking check has no id or link: it isn't the pinned run, so no fix run reads or reruns it");
  // A pending one from anywhere still holds it too; the pinned App's own failure stands as it is.
  assert.deepEqual(outcomes(await judged(github({ runs: [{ id: 1, name: 'test', app: SPOOF_APP, suite: 10, status: 'in_progress', conclusion: null }, { id: 2, name: 'test', app: CI_APP, suite: 11 }] }), pin)), ['test pending']);
  assert.deepEqual((await judged(github({ runs: [{ id: 2, name: 'test', app: CI_APP, suite: 11, conclusion: 'failure' }] }), pin)).failed, [{ name: 'test', outcome: 'fail', id: 2, url: 'https://github.example/o/r/runs/2' }]);
});

test("owner rule: a pinned check is its source's latest run on the head; any non-pass of its name from another source blocks it", async () => {
  const pin = { test: { app_id: CI_APP } };
  // 3. A passed pinned check plus a failed same-name check from another App, listed after it: blocked.
  const r = await judged(github({ runs: [{ id: 2, name: 'test', app: CI_APP, suite: 11 }, { id: 1, name: 'test', app: SPOOF_APP, suite: 10, conclusion: 'failure' }] }), pin);
  assert.deepEqual(outcomes(r), ['test fail']);
  assert.equal(r.ready, false);
  // The pinned workflow ran twice on this head: run 700 (suite 70) and the later run 710 (suite 71).
  const wfPin = { test: { workflow: '.github/workflows/ci.yml' } };
  const twoRuns = [workflowRun(70, '.github/workflows/ci.yml'), workflowRun(71, '.github/workflows/ci.yml')];
  const wf = async (runs: Run[], workflowRuns: unknown[] = twoRuns) => outcomes(await judged(github({ runs, workflowRuns }), wfPin));
  // 1. Cancelled, then passed in the later run: ready. 2. Failed, then passed: ready. Whatever the list order.
  assert.deepEqual(await wf([{ id: 1, name: 'test', app: ACTIONS, suite: 70, conclusion: 'cancelled' }, { id: 2, name: 'test', app: ACTIONS, suite: 71 }]), ['test pass']);
  assert.deepEqual(await wf([{ id: 2, name: 'test', app: ACTIONS, suite: 71 }, { id: 1, name: 'test', app: ACTIONS, suite: 70, conclusion: 'failure' }]), ['test pass']);
  // The later run decides, by the runs' own order, not the list's: passed first, cancelled in the later run: not ready.
  assert.deepEqual(await wf([{ id: 2, name: 'test', app: ACTIONS, suite: 71, conclusion: 'cancelled' }, { id: 1, name: 'test', app: ACTIONS, suite: 70 }]), ['test cancelled']);
  // A re-run attempt of a job in the same workflow run (a newer check run, same suite) counts as the newer.
  assert.deepEqual(await wf([{ id: 9, name: 'test', app: ACTIONS, suite: 70 }, { id: 3, name: 'test', app: ACTIONS, suite: 70, conclusion: 'failure' }]), ['test pass']);
  assert.deepEqual(await wf([{ id: 3, name: 'test', app: ACTIONS, suite: 70 }, { id: 9, name: 'test', app: ACTIONS, suite: 70, conclusion: 'failure' }]), ['test fail']);
  // A later run of the pinned file for ANOTHER head never supersedes: it isn't the pinned source here, so it can only block.
  const otherHead = [workflowRun(70, '.github/workflows/ci.yml'), workflowRun(71, '.github/workflows/ci.yml', { sha: OTHER })];
  assert.deepEqual(await wf([{ id: 1, name: 'test', app: ACTIONS, suite: 70, conclusion: 'failure' }, { id: 2, name: 'test', app: ACTIONS, suite: 71 }], otherHead), ['test fail']);
  assert.deepEqual(await wf([{ id: 1, name: 'test', app: ACTIONS, suite: 70 }, { id: 2, name: 'test', app: ACTIONS, suite: 71, conclusion: 'failure' }], otherHead), ['test fail']);
  // An App pin: its later check run supersedes its earlier one.
  assert.deepEqual(outcomes(await judged(github({ runs: [{ id: 1, name: 'test', app: CI_APP, suite: 11, conclusion: 'failure' }, { id: 2, name: 'test', app: CI_APP, suite: 12 }] }), pin)), ['test pass']);
  // A same-name commit status that isn't success (fail closed), or one still pending.
  assert.deepEqual(outcomes(await judged(github({ runs: [{ id: 2, name: 'test', app: CI_APP, suite: 11 }], statuses: [{ context: 'test', state: 'failure' }] }), pin)), ['test fail']);
  assert.deepEqual(outcomes(await judged(github({ runs: [{ id: 2, name: 'test', app: CI_APP, suite: 11 }], statuses: [{ context: 'test', state: 'pending' }] }), pin)), ['test pending']);
  // Every one passing: it passes.
  assert.deepEqual(outcomes(await judged(github({ runs: [{ id: 2, name: 'test', app: CI_APP, suite: 11 }, { id: 1, name: 'test', app: SPOOF_APP, suite: 10 }], statuses: [{ context: 'test', state: 'success' }] }), pin)), ['test pass']);
});

test('option (c) unchanged: an unpinned check is judged exactly by name, over every subset and order of its checks', async () => {
  const pool: CommitCheck[] = [
    { name: 'test', source: 'check_run', status: 'completed', conclusion: 'success', id: 1, app: CI_APP },
    { name: 'test', source: 'check_run', status: 'completed', conclusion: 'failure', id: 2, app: SPOOF_APP },
    { name: 'test', source: 'status', status: 'completed', conclusion: 'success' },
    { name: 'test', source: 'status', status: 'completed', conclusion: 'failure' },
  ];
  const orders: CommitCheck[][] = [[]];
  for (let k = 0; k < pool.length; k++) for (const o of [...orders]) for (const c of pool) if (!o.includes(c) && o.length === k) orders.push([...o, c]);
  let same = 0;
  for (const checks of orders) {
    const pinned = new PinnedChecks({ backlog: { checks: async () => checks, checkApps: async () => ({}) }, branch: () => 'main', repo: () => 'o/r', configured: () => ({ other: { app_id: CI_APP } }) });
    const a = readiness({ required: ['test'], checks: await pinned.of(HEAD), head: HEAD, evaluated: approved });
    assert.deepEqual(a, readiness({ required: ['test'], checks: asJudged(checks), head: HEAD, evaluated: approved }), JSON.stringify(checks));
    same++;
  }
  assert.equal(same, 65, 'every subset in every order (sum of P(4,k))');
});

test("a check with no recorded source takes the App GitHub's protection or ruleset requires; with neither, it is judged by name as before", async () => {
  const runs = [{ id: 1, name: 'test', app: SPOOF_APP, suite: 10 }, { id: 2, name: 'lint', app: CI_APP, suite: 11 }];
  const classic = { protection: { enabled: true, required_status_checks: { checks: [{ context: 'test', app_id: CI_APP }, { context: 'lint', app_id: CI_APP }] } } };
  assert.deepEqual(outcomes(await judged(github({ runs, branch: classic }), {}, ['test', 'lint'])), ['test missing', 'lint pass'], 'classic protection names the App');
  const ruleset = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test', integration_id: CI_APP }, { context: 'lint', integration_id: CI_APP }] } }];
  assert.deepEqual(outcomes(await judged(github({ runs, rules: ruleset }), {}, ['test', 'lint'])), ['test missing', 'lint pass'], 'a ruleset names the App');
  // GitHub requires the checks from any source (no App named, -1, or no rulesets on this plan): judged by name, exactly
  // as without pins (the owner's choice for existing installs, 2026-10-19).
  const anySource = { protection: { enabled: true, required_status_checks: { checks: [{ context: 'lint', app_id: null }, { context: 'test', app_id: -1 }] } } };
  const gh = github({ runs, branch: anySource, rules: 403 });
  const none = await judged(gh, {}, ['test', 'lint']);
  assert.deepEqual(outcomes(none), ['test pass', 'lint pass']);
  assert.deepEqual(none, readiness({ required: ['test', 'lint'], checks: asJudged(await gh.backlog.checks(HEAD)), head: HEAD, evaluated: approved }), 'the same as judging the raw checks by name');
  // A recorded source wins over GitHub's.
  assert.deepEqual(outcomes(await judged(github({ runs, branch: classic }), { lint: { app_id: SPOOF_APP } }, ['lint'])), ['lint missing']);
});

test("GitHub's Apps per check: none, -1 or a non-number names no App; two rules naming different Apps name none; own keys only", () => {
  const branch = { protection: { required_status_checks: { checks: [{ context: 'a', app_id: 5 }, { context: 'b', app_id: -1 }, { context: 'c', app_id: null }, { context: 'd', app_id: 5 }, { context: 'e', app_id: '5' }] } } };
  const rules = [{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a', integration_id: 5 }, { context: 'd', integration_id: 6 }, { context: 'f' }] } }];
  assert.deepEqual({ ...githubCheckApps(branch, rules) }, { a: 5 });
  assert.deepEqual({ ...githubCheckApps(null, 'junk') }, {});
  assert.equal(pinOf('constructor', {}, {}), null, 'no inherited key is a pin');
  assert.equal(pinOf('toString', {}, githubCheckApps(branch, rules)), null);
});

test('a check GitHub\'s ruleset pins under the name __proto__ keeps its pin: another App\'s is missing', async () => {
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: '__proto__', integration_id: CI_APP }] } }];
  const spoof = await judged(github({ runs: [{ id: 1, name: '__proto__', app: SPOOF_APP, suite: 10 }], rules }), {}, ['__proto__']);
  assert.deepEqual(outcomes(spoof), ['__proto__ missing']);
  const real = await judged(github({ runs: [{ id: 2, name: '__proto__', app: CI_APP, suite: 11 }], rules }), {}, ['__proto__']);
  assert.deepEqual(outcomes(real), ['__proto__ pass']);
});

test('without GitHub (no checkApps) every check is judged by name exactly as before', async () => {
  const run = (name: string, conclusion: string | null, status = 'completed', id = 1): CommitCheck => ({ name, source: 'check_run', status, conclusion, id });
  const status = (name: string, state: string | null): CommitCheck => ({ name, source: 'status', status: state ? 'completed' : 'pending', conclusion: state });
  // The inputs of test/pr-watch.test.ts.
  const cases: [string[], CommitCheck[]][] = [
    [['test', 'build'], [run('test', 'success'), run('build', 'success'), run('lint', 'failure')]],
    [['gone', 'running', 'cancelled', 'skipped', 'neutral', 'red'], [run('running', null, 'in_progress'), run('cancelled', 'cancelled'), run('skipped', 'skipped'), run('neutral', 'neutral'), run('red', 'timed_out', 'completed', 7)]],
    [['deploy'], [status('deploy', 'success')]],
    [['x'], [status('x', 'success'), run('x', 'failure')]],
  ];
  for (const [required, checks] of cases) {
    const pinned = new PinnedChecks({ backlog: { checks: async () => checks }, branch: () => 'main', repo: () => 'o/r', configured: () => ({}) });
    assert.equal(pinned.enforced, false);
    assert.deepEqual(readiness({ required, checks: await pinned.of(HEAD), head: HEAD, evaluated: approved }), readiness({ required, checks: asJudged(checks), head: HEAD, evaluated: approved }));
  }
});

test("GitHub's rules never answered: a check config.yaml doesn't pin is missing (fail closed), never judged by name", async () => {
  let down = true;
  const checks: CommitCheck[] = [{ name: 'test', source: 'check_run', status: 'completed', conclusion: 'success', id: 1, app: SPOOF_APP }, { name: 'lint', source: 'check_run', status: 'completed', conclusion: 'success', id: 2, app: CI_APP }];
  const pinned = new PinnedChecks({ backlog: { checks: async () => checks, checkApps: async () => (down ? Promise.reject(new Error('GitHub 502')) : {}) }, branch: () => 'main', repo: () => 'o/r', configured: () => ({ lint: { app_id: CI_APP } }), now: () => 0 });
  const judge = async () => readiness({ required: ['test', 'lint'], checks: await pinned.of(HEAD), head: HEAD, evaluated: approved }).checks.map((c) => `${c.name} ${c.outcome}`);
  assert.equal(await pinned.githubApps(), null);
  assert.deepEqual(await judge(), ['test missing', 'lint pass'], 'unknown: missing; the config pin still applies');
  down = false;
  assert.deepEqual(await judge(), ['test pass', 'lint pass'], 'GitHub answered (no App named): judged by name, as before');
});

test("GitHub's protection and rules are read once per 10 minutes; an error keeps the last answer", async () => {
  let t = 0;
  let fail = false;
  const calls: string[] = [];
  const pinned = new PinnedChecks({
    backlog: { checks: async () => [], checkApps: async (b) => (calls.push(b), fail ? Promise.reject(new Error('GitHub 502')) : { test: CI_APP }) },
    branch: () => 'main',
    repo: () => 'o/r',
    configured: () => ({}),
    now: () => t,
  });
  assert.deepEqual(await pinned.githubApps(), { test: CI_APP });
  t = 9 * 60_000;
  await pinned.githubApps();
  assert.deepEqual(calls, ['main']);
  t = 11 * 60_000;
  fail = true;
  assert.deepEqual(await pinned.githubApps(), { test: CI_APP }, 'kept');
  assert.equal(calls.length, 2);
});

test('GitHub checks carry who posted each check run, and the workflow run behind an Actions one (read once per suite)', async () => {
  const gh = github({ runs: [{ id: 1, name: 'test', app: ACTIONS, suite: 70 }, { id: 2, name: 'lint', app: CI_APP, suite: 71 }], workflowRuns: [workflowRun(70, '.github/workflows/ci.yml')] });
  const checks = await gh.backlog.checks(HEAD);
  assert.deepEqual(
    checks.map((c) => ({ name: c.name, app: c.app, workflow: c.workflow })),
    [
      { name: 'test', app: ACTIONS, workflow: { run: 700, url: 'https://github.com/o/r/actions/runs/700', path: '.github/workflows/ci.yml', repo: 'o/r', sha: HEAD } },
      { name: 'lint', app: CI_APP, workflow: undefined },
    ],
  );
  await gh.backlog.checks(HEAD);
  assert.equal(gh.calls.filter((p) => p.includes('/actions/runs')).length, 1, 'a known suite is not asked again');
});

test("the main watch's GitHub calls carry each run's App and suite, and the workflow run behind each suite", async () => {
  const f = (async (url: string) => {
    const path = url.replace('https://api.github.com', '');
    if (path.startsWith(`/repos/o/r/commits/${HEAD}/check-runs`)) return new Response(JSON.stringify({ check_runs: [{ ...checkRun({ id: 1, name: 'test', app: ACTIONS, suite: 70 }), started_at: null, completed_at: null }] }));
    if (path.startsWith('/repos/o/r/actions/runs')) return new Response(JSON.stringify({ workflow_runs: [workflowRun(70, '.github/workflows/ci.yml'), { check_suite_id: 71 }] }));
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const api = new GitHubMainWatchApi('o/r', async () => 't', f);
  assert.deepEqual((await api.checkRuns(HEAD)).map((r) => [r.app, r.suite, r.id, r.url]), [[ACTIONS, 70, 1, 'https://github.com/o/r/actions/runs/700/job/1']]);
  assert.deepEqual(await api.runSources(HEAD), { '70': { run: 700, url: 'https://github.com/o/r/actions/runs/700', path: '.github/workflows/ci.yml', repo: 'o/r', sha: HEAD } });
  const denied = new GitHubMainWatchApi('o/r', async () => 't', (async () => new Response('{}', { status: 403 })) as typeof fetch);
  assert.equal(await denied.runSources(HEAD), null);
});

test('turning governance mode on with any bare-name required check is refused, naming the check', () => {
  assert.match(governanceRefusal(['test', 'lint', 'dco'], { test: { app_id: CI_APP } }) ?? '', /not pinned: lint, dco$/);
  assert.equal(governanceRefusal(['test'], { test: { workflow: '.github/workflows/ci.yml' } }), null);
});

test('doctor names each required check with no recorded source, judged by name, and how to pin it', () => {
  const project = { land_mode: 'pr', required_checks: ['test', 'lint'], required_check_sources: { test: { app_id: CI_APP } } };
  const d = checkSourceDoctor(project);
  assert.equal(d.level, 'warn');
  assert.match(d.detail, /^no source recorded for lint: each is judged by name .*required_check_sources/);
  assert.equal(checkSourceDoctor({ ...project, required_check_sources: { ...project.required_check_sources, lint: { workflow: '.github/workflows/ci.yml' } } }).level, 'ok');
  assert.equal(checkSourceDoctor({ ...project, land_mode: 'direct' }).level, 'ok');
});

test('config.yaml required_check_sources: an App id or a workflow file under .github/workflows/, nothing else', () => {
  const parse = (v: unknown) => ProjectConfig.shape.required_check_sources.safeParse(v).success;
  assert.equal(parse({ test: { app_id: 15368 }, lint: { workflow: '.github/workflows/ci.yml' } }), true);
  assert.equal(parse(undefined), true);
  for (const bad of [{ test: { app_id: 0 } }, { test: { workflow: 'ci.yml' } }, { test: { workflow: '.github/workflows/../x.yml' } }, { test: { app_id: 1, workflow: '.github/workflows/ci.yml' } }, { test: 'ci' }]) assert.equal(parse(bad), false, JSON.stringify(bad));
  // Adversarial pass: a pin keyed __proto__ (as YAML or JSON parses it, an own key) would set the record's prototype and
  // be dropped, leaving the check judged by name: refused instead.
  assert.equal(parse(JSON.parse('{"__proto__": {"app_id": 1111}}')), false);
});

// The reviewer's 12 raw reads (round 1), each in a module typed as src/ would type it. The text-only check below
// catches 1 of them; the type-based scan must catch all 12.
const FIXTURE_PRELUDE = [
  "import type { Backlog } from '../src/backlog/types.js';",
  "import { GitHubBacklog } from '../src/backlog/github.js';",
  "import type { MainWatchApi } from '../src/main-watch.js';",
  'declare const repo: string;',
  'declare const token: () => string;',
  'declare const api: MainWatchApi;',
  'declare const deps: object;',
  'declare class FixForward { constructor(o: object); }',
  'export class Reader {',
  '  constructor(private readonly d: { backlog: Backlog; github: Backlog }) {}',
  '  async f(sha: string): Promise<unknown> {',
].join('\n');
const RAW_FIXTURES: Record<string, string> = {
  'direct call (control)': 'const c = await this.d.backlog.checks(sha);',
  'alias variable': 'const b = this.d.backlog;\nconst c = await b.checks(sha);',
  'method reference as a dep': 'new FixForward({ ...deps, checks: this.d.backlog.checks.bind(this.d.backlog) });',
  'unbound reference': 'const read = this.d.backlog.checks;',
  destructured: 'const { checks } = this.d.backlog;\nawait checks.call(this.d.backlog, sha);',
  'optional chaining': 'await this.d.backlog?.checks(sha);',
  'bracket access': "await this.d.backlog['checks'](sha);",
  'line break before call': 'await this.d.backlog\n  .checks(sha);',
  'space before paren': 'await this.d.backlog.checks (sha);',
  'differently named receiver': 'await this.d.github.checks(sha);',
  'GitHubBacklog instance named gh': 'const gh = new GitHubBacklog(repo, token);\nawait gh.checks(sha);',
  'main watch api raw runs (not Backlog)': 'const runs = await api.checkRuns(sha);',
};
const fixture = (body: string) => `${FIXTURE_PRELUDE}\n${body}\nreturn null;\n  }\n}\n`;

test('the raw-read scan catches every spelling of a raw read of GitHub\'s checks (the reviewer\'s 12), and nothing else', () => {
  const files = Object.fromEntries(Object.values(RAW_FIXTURES).map((body, i) => [`test/raw-fixture-${i}.ts`, fixture(body)]));
  files['test/raw-fixture-clean.ts'] = fixture("const r = { checks: [1] };\nconst n = r.checks.length + [{ checks: 2 }][0]!.checks;\nconst { checks } = r;\nreturn [n, checks, this.d.backlog.pullRequest];");
  const hits = rawCheckReads(files);
  for (const [i, name] of Object.keys(RAW_FIXTURES).entries()) assert.ok(hits.some((h) => h.file === `test/raw-fixture-${i}.ts`), `caught: ${name}`);
  assert.deepEqual(hits.filter((h) => h.file === 'test/raw-fixture-clean.ts'), [], 'a `checks` that is not GitHub\'s is not a raw read');
  // The old text-only check (kept below) catches only the plain call.
  assert.equal(Object.values(RAW_FIXTURES).filter((body) => /backlog\.checks\(/.test(body)).length, 1);
});

// The reviewer's round-2 ways around the brand, each a src/ file, fed as data.
const CAST_PRELUDE = [
  "import type { Backlog } from './backlog/types.js';",
  "import { readiness } from './pr-watch.js';",
  "import type { JudgedChecks } from './check-source.js';",
  'export async function f(backlog: Backlog, sha: string, other: { list(): Promise<never[]> }) {',
].join('\n');
const CAST_FIXTURES: Record<string, { body: string; catches: ('cast' | 'raw')[] }> = {
  'cast as JudgedChecks': { body: "  const raw = await backlog.checks(sha);\n  return readiness({ required: ['ci'], checks: raw as JudgedChecks, head: sha, evaluated: null });", catches: ['cast', 'raw'] },
  'cast as never at a judging call': { body: "  const raw = await backlog.checks(sha);\n  return readiness({ required: ['ci'], checks: raw as never, head: sha, evaluated: null });", catches: ['cast', 'raw'] },
  'structural alias, then as never': { body: "  const b: { checks(s: string): Promise<unknown[]> } = backlog;\n  const raw = await b.checks(sha);\n  return readiness({ required: ['ci'], checks: raw as never, head: sha, evaluated: null });", catches: ['cast', 'raw'] },
  'computed key from a const': { body: "  const k = 'checks' as const;\n  const raw = await backlog[k](sha);\n  return raw;", catches: ['raw'] },
  'Reflect.get': { body: "  const raw = await Reflect.get(backlog, 'checks').call(backlog, sha);\n  return raw;", catches: ['raw'] },
  'data from elsewhere, as unknown as JudgedChecks': { body: "  const raw = await other.list();\n  return readiness({ required: ['ci'], checks: raw as unknown as JudgedChecks, head: sha, evaluated: null });", catches: ['cast'] },
};

test('every way around the JudgedChecks brand in src/ is caught: a cast into it, or a raw read however spelled (fixtures)', () => {
  for (const [name, f] of Object.entries(CAST_FIXTURES)) {
    const file = `src/zz-fixture-${name.replace(/\W+/g, '-')}.ts`;
    const files = { [file]: `${CAST_PRELUDE}\n${f.body}\n}\n` };
    if (f.catches.includes('cast')) assert.ok(judgedCasts(files).some((h) => h.file === file), `cast caught: ${name}`);
    if (f.catches.includes('raw')) assert.ok(rawCheckReads(files).some((h) => h.file === file), `raw read caught: ${name}`);
  }
  // Not casts into JudgedChecks: an ordinary cast, and the judged answer itself.
  const clean = { 'src/zz-fixture-clean.ts': `${CAST_PRELUDE}\n  const n = (sha as string).length;\n  return [n, other];\n}\n` };
  assert.deepEqual(judgedCasts(clean), []);
  // A src/ import from test/ (asJudged lives there), static, re-export or dynamic.
  const imports = { 'src/zz-imp.ts': "import { asJudged } from '../test/helpers.js';\nexport { repoRoot } from '../test/helpers.js';\nexport const m = () => import('../test/raw-check-reads.js');\nexport { asJudged };\n", 'src/zz-ok.ts': "import { BRAND } from './brand.js';\nexport { BRAND };\n" };
  assert.deepEqual(testImports(imports).map((h) => `${h.file} ${h.spec}`), ['src/zz-imp.ts ../test/helpers.js', 'src/zz-imp.ts ../test/helpers.js', 'src/zz-imp.ts ../test/raw-check-reads.js']);
});

// The reviewer's round-3 ways in with `any` or `never` (n1 to n10), each a src/ file, fed as data.
const R3 = "  return readiness({ required: ['ci'], checks: raw, head: sha, evaluated: null });";
const ANY_FIXTURES: Record<string, string> = {
  'n1 backlog as any, read, pass': "  const raw = await (backlog as any).checks(sha);\n" + R3,
  'n2 backlog into an any var, read, pass': "  const b: any = backlog;\n  const raw = await b.checks(sha);\n" + R3,
  'n3 structural alias via a parameter': "  const g = (b: { checks(s: string): Promise<any> }) => b.checks(sha);\n  const raw = await g(backlog);\n" + R3,
  'n4 raw read into an unannotated as-never const': "  const raw0 = await backlog.checks(sha);\n  const raw = raw0 as never;\n" + R3,
  'n5 other data into an unannotated as-never const': "  const raw0 = await other.list();\n  const raw = raw0 as never;\n" + R3,
  'n6 other data via JSON.parse (any), no cast': "  const raw = JSON.parse(JSON.stringify(await other.list()));\n" + R3,
  'n7 other data via a generic identity cast': "  const id = <T,>(x: unknown): T => x as T;\n  const raw = id<JudgedChecks>(await other.list());\n" + R3,
  'n8 other data via a type predicate': "  const raw: unknown = await other.list();\n  const isJ = (x: unknown): x is JudgedChecks => true;\n  if (!isJ(raw)) return null;\n" + R3,
  'n9 Object.entries over backlog': "  const fns = Object.entries(backlog).find(([k]) => k === 'che' + 'cks');\n  const raw = await (fns![1] as any)(sha);\n" + R3,
  'n10 backlog as unknown as structural': "  const b = backlog as unknown as { checks(s: string): Promise<any> };\n  const raw = await b.checks(sha);\n" + R3,
};

test('a value typed any or never never reaches a judging call unseen: the reviewer\'s n1 to n10, each caught (fixtures)', () => {
  for (const [name, body] of Object.entries(ANY_FIXTURES)) {
    const file = `src/zz-any-${name.replace(/\W+/g, '-')}.ts`;
    const files = { [file]: `${CAST_PRELUDE}\n${body}\n}\n` };
    const hits = rawCheckReads(files).length + judgedCasts(files).length;
    assert.ok(hits > 0, `caught: ${name}`);
  }
});

test('src/ casts into JudgedChecks only in check-source.ts, and imports nothing from test/', () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const src = Object.fromEntries(files(join(repoRoot, 'src')).map((p) => [relative(repoRoot, p).split('\\').join('/'), readFileSync(p, 'utf8')]));
  assert.deepEqual(judgedCasts(src).filter((h) => !Object.hasOwn(JUDGED_CASTS_ALLOWED, h.file)), []);
  assert.deepEqual(testImports(src), []);
});

test("src/ reads GitHub's checks raw only where RAW_READS_ALLOWED says why (check-source.ts, the main watch, the canary)", () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const src = Object.fromEntries(files(join(repoRoot, 'src')).map((p) => [relative(repoRoot, p).split('\\').join('/'), readFileSync(p, 'utf8')]));
  const hits = rawCheckReads(src);
  assert.deepEqual(hits.filter((h) => !Object.hasOwn(RAW_READS_ALLOWED, h.file)), [], 'a raw read outside the allowed files');
  assert.deepEqual([...new Set(hits.map((h) => h.file))].sort(), Object.keys(RAW_READS_ALLOWED).sort(), 'an allowed file that no longer reads them raw');
});

test("a raw Backlog.checks answer doesn't compile where checks are judged: readiness, requiredOutcomes, headChecks, mayMerge, prReadiness, fix-forward's reader", () => {
  const body = [
    "import type { Backlog } from '../src/backlog/types.js';",
    "import { readiness, requiredOutcomes } from '../src/pr-watch.js';",
    "import { headChecks } from '../src/ci-none.js';",
    "import { mayMerge } from '../src/coordinator/pr-batch.js';",
    "import type { FixForwardDeps } from '../src/coordinator/fix-forward.js';",
    "import type { MergeFlow } from '../src/coordinator/merge-flow.js';",
    'export async function f(backlog: Backlog, flow: MergeFlow, sha: string) {',
    '  const raw = await backlog.checks(sha);',
    "  readiness({ required: ['ci'], checks: raw, head: sha, evaluated: null });",
    "  requiredOutcomes(['ci'], raw);",
    "  headChecks({ project: {}, tests: {}, github: raw, events: () => [], sha });",
    "  mayMerge({ events: [], number: 1, head: sha, checks: raw, fastChecks: ['ci'] });",
    '  flow.prReadiness(1, sha, raw);',
    "  const reader: FixForwardDeps['checks'] = (s) => backlog.checks(s);",
    '  return reader;',
    '}',
  ].join('\n');
  const errors = typeErrors({ 'test/raw-judged-fixture.ts': body });
  for (const line of [9, 10, 11, 12, 13, 14]) assert.ok(errors.some((e) => e.startsWith(`test/raw-judged-fixture.ts:${line}:`)), `line ${line} doesn't compile: ${errors.join('\n')}`);
});

test("nothing in src/ judges GitHub's checks raw: only check-source.ts reads Backlog.checks (canary.ts: see RAW_READS_ALLOWED)", () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const raw = files(join(repoRoot, 'src'))
    .filter((p) => /backlog\.checks\(/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(repoRoot, p).split('\\').join('/'))
    .sort();
  assert.deepEqual(raw, ['src/canary.ts', 'src/check-source.ts']);
});
