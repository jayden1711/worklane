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
import { repoRoot } from './helpers.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const CI_APP = 1111;
const SPOOF_APP = 2222;
const ACTIONS = 15368;
const approved = { head: HEAD, approved: true };

type Run = { id: number; name: string; app: number; suite: number; status?: string; conclusion?: string | null };
const checkRun = (r: Run) => ({ id: r.id, name: r.name, status: r.status ?? 'completed', conclusion: r.conclusion === undefined ? 'success' : r.conclusion, html_url: `https://github.example/o/r/runs/${r.id}`, app: { id: r.app, slug: r.app === ACTIONS ? 'github-actions' : `app-${r.app}` }, check_suite: { id: r.suite } });
const workflowRun = (suite: number, path: string, o: { repo?: string; sha?: string } = {}) => ({ id: suite * 10, check_suite_id: suite, path, head_sha: o.sha ?? HEAD, repository: { full_name: o.repo ?? 'o/r' } });

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
  // Any App but Actions has no workflow run, however its check is named.
  assert.deepEqual(outcomes(await judged(github({ runs: [{ id: 1, name: 'test', app: SPOOF_APP, suite: 70 }], workflowRuns: [workflowRun(70, '.github/workflows/ci.yml')] }), pin)), ['test missing']);
});

test('a commit status with a pinned check name is missing: statuses carry no App', async () => {
  const gh = github({ runs: [], statuses: [{ context: 'test', state: 'success' }] });
  for (const pin of [{ app_id: CI_APP }, { workflow: '.github/workflows/ci.yml' }]) assert.deepEqual(outcomes(await judged(gh, { test: pin })), ['test missing']);
});

test("a check with no recorded source takes the App GitHub's protection or ruleset requires; with neither, it is refused", async () => {
  const runs = [{ id: 1, name: 'test', app: SPOOF_APP, suite: 10 }, { id: 2, name: 'lint', app: CI_APP, suite: 11 }];
  const classic = { protection: { enabled: true, required_status_checks: { checks: [{ context: 'test', app_id: CI_APP }, { context: 'lint', app_id: CI_APP }] } } };
  assert.deepEqual(outcomes(await judged(github({ runs, branch: classic }), {}, ['test', 'lint'])), ['test missing', 'lint pass'], 'classic protection names the App');
  const ruleset = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test', integration_id: CI_APP }, { context: 'lint', integration_id: CI_APP }] } }];
  assert.deepEqual(outcomes(await judged(github({ runs, rules: ruleset }), {}, ['test', 'lint'])), ['test missing', 'lint pass'], 'a ruleset names the App');
  // GitHub requires the checks from any source (no App named, -1, or no rulesets on this plan): refused, fail closed.
  const anySource = { protection: { enabled: true, required_status_checks: { checks: [{ context: 'lint', app_id: null }, { context: 'test', app_id: -1 }] } } };
  const none = await judged(github({ runs, branch: anySource, rules: 403 }), {}, ['test', 'lint']);
  assert.deepEqual(outcomes(none), ['test missing', 'lint missing']);
  assert.equal(none.ready, false);
  // A recorded source wins over GitHub's.
  assert.deepEqual(outcomes(await judged(github({ runs, branch: classic }), { lint: { app_id: SPOOF_APP } }, ['lint'])), ['lint missing']);
});

test("GitHub's Apps per check: none, -1 or a non-number names no App; two rules naming different Apps name none; own keys only", () => {
  const branch = { protection: { required_status_checks: { checks: [{ context: 'a', app_id: 5 }, { context: 'b', app_id: -1 }, { context: 'c', app_id: null }, { context: 'd', app_id: 5 }, { context: 'e', app_id: '5' }] } } };
  const rules = [{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a', integration_id: 5 }, { context: 'd', integration_id: 6 }, { context: 'f' }] } }];
  assert.deepEqual(githubCheckApps(branch, rules), { a: 5 });
  assert.deepEqual(githubCheckApps(null, 'junk'), {});
  assert.equal(pinOf('constructor', {}, {}), null, 'no inherited key is a pin');
  assert.equal(pinOf('toString', {}, githubCheckApps(branch, rules)), null);
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
    assert.deepEqual(readiness({ required, checks: await pinned.of(HEAD), head: HEAD, evaluated: approved }), readiness({ required, checks, head: HEAD, evaluated: approved }));
  }
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
      { name: 'test', app: ACTIONS, workflow: { path: '.github/workflows/ci.yml', repo: 'o/r', sha: HEAD } },
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
  assert.deepEqual((await api.checkRuns(HEAD)).map((r) => [r.app, r.suite]), [[ACTIONS, 70]]);
  assert.deepEqual(await api.runSources(HEAD), { '70': { path: '.github/workflows/ci.yml', repo: 'o/r', sha: HEAD } });
  const denied = new GitHubMainWatchApi('o/r', async () => 't', (async () => new Response('{}', { status: 403 })) as typeof fetch);
  assert.equal(await denied.runSources(HEAD), null);
});

test('turning governance mode on with any bare-name required check is refused, naming the check', () => {
  assert.match(governanceRefusal(['test', 'lint', 'dco'], { test: { app_id: CI_APP } }) ?? '', /not pinned: lint, dco$/);
  assert.equal(governanceRefusal(['test'], { test: { workflow: '.github/workflows/ci.yml' } }), null);
});

test('doctor names each required check with no recorded source, and how to pin it', () => {
  const project = { land_mode: 'pr', required_checks: ['test', 'lint'], required_check_sources: { test: { app_id: CI_APP } } };
  const d = checkSourceDoctor(project);
  assert.equal(d.level, 'warn');
  assert.match(d.detail, /^no source recorded for lint: .*refused \(missing: no PR is ready\).*required_check_sources/);
  assert.equal(checkSourceDoctor({ ...project, required_check_sources: { ...project.required_check_sources, lint: { workflow: '.github/workflows/ci.yml' } } }).level, 'ok');
  assert.equal(checkSourceDoctor({ ...project, land_mode: 'direct' }).level, 'ok');
});

test('config.yaml required_check_sources: an App id or a workflow file under .github/workflows/, nothing else', () => {
  const parse = (v: unknown) => ProjectConfig.shape.required_check_sources.safeParse(v).success;
  assert.equal(parse({ test: { app_id: 15368 }, lint: { workflow: '.github/workflows/ci.yml' } }), true);
  assert.equal(parse(undefined), true);
  for (const bad of [{ test: { app_id: 0 } }, { test: { workflow: 'ci.yml' } }, { test: { workflow: '.github/workflows/../x.yml' } }, { test: { app_id: 1, workflow: '.github/workflows/ci.yml' } }, { test: 'ci' }]) assert.equal(parse(bad), false, JSON.stringify(bad));
});

test("nothing in src/ judges GitHub's checks raw: only check-source.ts reads Backlog.checks (canary.ts reports, never gates)", () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const raw = files(join(repoRoot, 'src'))
    .filter((p) => /backlog\.checks\(/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(repoRoot, p).split('\\').join('/'))
    .sort();
  assert.deepEqual(raw, ['src/canary.ts', 'src/check-source.ts']);
});
