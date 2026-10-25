// #925: a red or unfinished check run of a required name on the judged commit blocks, whatever its source and however
// it is ordered against a passing run of the same name (an earlier start, the same start with a lower id, an earlier
// workflow run of the same file). "Latest per name" used to hide it. The GitHub answers are stand-ins for the REST
// API's; its default `filter=latest` already keeps only the newest attempt of a job in one check suite (measured on
// this repo: a re-run job's failed first attempt is listed by `filter=all` only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { GitHubBacklog } from '../src/backlog/github.js';
import { PinnedChecks, pinnedVerdict, type CheckPin, type WorkflowSource } from '../src/check-source.js';
import { checksAt, outcomesAt, type CheckRunAt } from '../src/main-watch.js';
import { readiness } from '../src/pr-watch.js';
import { repoRoot } from './helpers.js';

const SHA = 'a'.repeat(40);
const ACTIONS = 15368;
const OTHER_APP = 4242;
const EARLY = '2026-10-18T09:00:00Z';
const LATE = '2026-10-18T10:00:00Z';

// A check run as GitHub lists it. An Actions run's page is its job in its suite's workflow run (run id = suite * 10).
type Run = { id: number; name: string; suite: number; app?: number; status?: string; conclusion?: string; started?: string };
const checkRun = (r: Run) => {
  const app = r.app ?? ACTIONS;
  const status = r.status ?? 'completed';
  return {
    id: r.id,
    name: r.name,
    status,
    conclusion: status === 'completed' ? (r.conclusion ?? 'success') : null,
    started_at: r.started ?? LATE,
    html_url: app === ACTIONS ? `https://github.com/o/r/actions/runs/${r.suite * 10}/job/${r.id}` : `https://github.example/o/r/runs/${r.id}`,
    app: { id: app, slug: app === ACTIONS ? 'github-actions' : `app-${app}` },
    check_suite: { id: r.suite },
  };
};
const workflowRun = (suite: number, path: string) => ({ id: suite * 10, html_url: `https://github.com/o/r/actions/runs/${suite * 10}`, check_suite_id: suite, path, head_sha: SHA, repository: { full_name: 'o/r' } });
// ci.yml ran twice on the commit (suites 1 and 3); gitleaks.yml once (suite 2).
const WORKFLOWS = [workflowRun(1, '.github/workflows/ci.yml'), workflowRun(2, '.github/workflows/gitleaks.yml'), workflowRun(3, '.github/workflows/ci.yml')];

// Each case: the check runs of required check "test" on the commit, a passing one among them, and what must happen.
type Case = { what: string; runs: Run[]; blocks: 'fail' | 'wait' };
/** Cases for a name judged by name (nothing pins it): the runs come from any App. */
const byName: Case[] = [
  { what: 'a red run from another App that started earlier', runs: [{ id: 1, name: 'test', suite: 7, app: OTHER_APP, conclusion: 'failure', started: EARLY }, { id: 2, name: 'test', suite: 8, app: OTHER_APP + 1 }], blocks: 'fail' },
  { what: 'a red run that started at the same time with a lower id', runs: [{ id: 1, name: 'test', suite: 7, app: OTHER_APP, conclusion: 'failure' }, { id: 2, name: 'test', suite: 8, app: OTHER_APP + 1 }], blocks: 'fail' },
  { what: 'an earlier run still in progress', runs: [{ id: 1, name: 'test', suite: 7, app: OTHER_APP, status: 'in_progress', started: EARLY }, { id: 2, name: 'test', suite: 8, app: OTHER_APP + 1 }], blocks: 'wait' },
  { what: 'a red run listed after the passing one', runs: [{ id: 2, name: 'test', suite: 8, app: OTHER_APP + 1 }, { id: 1, name: 'test', suite: 7, app: OTHER_APP, conclusion: 'failure', started: EARLY }], blocks: 'fail' },
];
/** Cases for "test" pinned to ci.yml: the passing run is ci.yml's later workflow run (suite 3). */
const pinnedFile: Case[] = [
  { what: "a red run of the pinned file's earlier workflow run", runs: [{ id: 1, name: 'test', suite: 1, conclusion: 'failure', started: EARLY }, { id: 3, name: 'test', suite: 3 }], blocks: 'fail' },
  { what: "a cancelled run of the pinned file's earlier workflow run", runs: [{ id: 1, name: 'test', suite: 1, conclusion: 'cancelled', started: EARLY }, { id: 3, name: 'test', suite: 3 }], blocks: 'fail' },
  { what: "the pinned file's earlier workflow run still in progress", runs: [{ id: 1, name: 'test', suite: 1, status: 'in_progress', started: EARLY }, { id: 3, name: 'test', suite: 3 }], blocks: 'wait' },
  { what: 'a red run from another workflow file that started earlier', runs: [{ id: 1, name: 'test', suite: 2, conclusion: 'failure', started: EARLY }, { id: 3, name: 'test', suite: 3 }], blocks: 'fail' },
  { what: 'a run from another App, earlier and still in progress', runs: [{ id: 1, name: 'test', suite: 7, app: OTHER_APP, status: 'in_progress', started: EARLY }, { id: 3, name: 'test', suite: 3 }], blocks: 'wait' },
];
/** Cases for "test" pinned to a non-Actions App (OTHER_APP): the passing run is that App's newest. */
const pinnedApp: Case[] = [
  { what: "the pinned App's earlier red run in another suite", runs: [{ id: 1, name: 'test', suite: 7, app: OTHER_APP, conclusion: 'failure', started: EARLY }, { id: 2, name: 'test', suite: 8, app: OTHER_APP }], blocks: 'fail' },
  { what: "the pinned App's earlier run still in progress", runs: [{ id: 1, name: 'test', suite: 7, app: OTHER_APP, status: 'in_progress', started: EARLY }, { id: 2, name: 'test', suite: 8, app: OTHER_APP }], blocks: 'wait' },
];
const PIN_FILE: Record<string, CheckPin> = { test: { workflow: '.github/workflows/ci.yml' } };
const PIN_APP: Record<string, CheckPin> = { test: { app_id: OTHER_APP } };
const groups: [string, Record<string, unknown> | undefined, Case[]][] = [
  ['by name', undefined, byName],
  ['pinned to its workflow file', PIN_FILE, pinnedFile],
  ['pinned to its App', PIN_APP, pinnedApp],
];
// Without the blocking run (id 1 in every case) the commit is green, so the block is that run's.
const greenOnly = (c: Case) => c.runs.filter((r) => r.id !== 1);

// --- The root updater (scripts/machine/worklane-update.cjs): chooseCommit, as a timer run makes it.
type Cfg = { branch?: string; required_checks: string[]; required_check_sources?: Record<string, unknown> };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  chooseCommit(deps: Record<string, unknown>, cfg: Cfg, api: string, cands: { sha: string; date: string }[], held: null): Promise<{ chosen?: { sha: string }; wait?: { sha: string }; reason?: string; skipped: { sha: string; reason: string; pending?: boolean }[] }>;
};
const API = 'https://api.github.com/repos/o/r';
async function updater(runs: Run[], pins: Record<string, unknown> | undefined): Promise<'installs' | 'fail' | 'wait'> {
  const fetchJson = async (url: string) => {
    if (url.startsWith(`${API}/commits/${SHA}/check-runs`)) return { total_count: runs.length, check_runs: runs.map(checkRun) };
    if (url.startsWith(`${API}/commits/${SHA}/status`)) return { state: 'success', total_count: 0, statuses: [] };
    if (url.startsWith(`${API}/actions/runs?head_sha=${SHA}`)) return { workflow_runs: WORKFLOWS };
    if (url.startsWith(`${API}/rules/branches/main`)) return [];
    if (url === `${API}/branches/main`) return { name: 'main', protection: { enabled: false, required_status_checks: { checks: [] } } };
    return null;
  };
  let clock = Date.parse('2026-10-18T10:30:00Z');
  const deps = { pinChecks: true, fetchJson, now: () => clock, sleep: async (ms: number) => void (clock += ms) };
  const r = await u.chooseCommit(deps, { branch: 'main', required_checks: ['test'], ...(pins ? { required_check_sources: pins } : {}) }, API, [{ sha: SHA, date: '2026-10-18T10:20:00Z' }], null);
  if (r.chosen) return 'installs';
  return r.wait ? 'wait' : 'fail';
}

for (const [group, pins, cases] of groups) {
  test(`updater (${group}): a red or unfinished run of a required name blocks the commit, whatever its order`, async () => {
    const wrong: string[] = [];
    for (const c of cases) {
      const green = await updater(greenOnly(c), pins);
      const got = await updater(c.runs, pins);
      if (green !== 'installs' || got !== c.blocks) wrong.push(`${c.what}: ${got} (without it: ${green})`);
    }
    assert.deepEqual(wrong, []);
  });
}

// --- PR readiness (and every judge that takes PinnedChecks.of: fix-forward, the batch's fast checks).
function backlog(runs: Run[]) {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const f = (async (url: string) => {
    const path = url.replace('https://api.github.com', '');
    if (path.startsWith(`/repos/o/r/commits/${SHA}/check-runs`)) return answer({ total_count: runs.length, check_runs: runs.map(checkRun) });
    if (path.startsWith(`/repos/o/r/commits/${SHA}/status`)) return answer({ statuses: [] });
    if (path.startsWith(`/repos/o/r/actions/runs?head_sha=${SHA}`)) return answer({ total_count: WORKFLOWS.length, workflow_runs: WORKFLOWS });
    if (path === '/repos/o/r/branches/main') return answer({ name: 'main', protection: { enabled: false, required_status_checks: { checks: [], contexts: [], enforcement_level: 'off' } } });
    if (path.startsWith('/repos/o/r/rules/branches/main')) return answer([]);
    return answer({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  return new GitHubBacklog('o/r', () => 't', f);
}
async function ready(runs: Run[], pins: Record<string, CheckPin> | undefined): Promise<'installs' | 'fail' | 'wait'> {
  const pinned = new PinnedChecks({ backlog: backlog(runs), branch: () => 'main', repo: () => 'o/r', configured: () => pins ?? {}, required: () => ['test'] });
  const r = readiness({ required: ['test'], checks: await pinned.of(SHA), head: SHA, evaluated: { head: SHA, approved: true } });
  if (r.ready) return 'installs';
  return r.checks[0]!.outcome === 'pending' ? 'wait' : 'fail';
}

for (const [group, pins, cases] of groups) {
  test(`PR readiness (${group}): a red or unfinished run of a required name blocks, whatever its order`, async () => {
    const wrong: string[] = [];
    for (const c of cases) {
      const green = await ready(greenOnly(c), pins as Record<string, CheckPin> | undefined);
      const got = await ready(c.runs, pins as Record<string, CheckPin> | undefined);
      if (green !== 'installs' || got !== c.blocks) wrong.push(`${c.what}: ${got} (without it: ${green})`);
    }
    assert.deepEqual(wrong, []);
  });
}

// --- The main watch, judging a merge at time AT from GitHub's filter=all list (src/main-watch.ts).
const AT = '2026-10-18T10:30:00Z';
const runAt = (r: Run): CheckRunAt => {
  const c = checkRun(r);
  return { name: c.name, status: c.status, conclusion: c.conclusion, startedAt: c.started_at, completedAt: c.status === 'completed' ? '2026-10-18T10:10:00Z' : null, id: c.id, url: c.html_url, app: c.app.id, suite: r.suite };
};
const sources: Record<string, WorkflowSource> = Object.fromEntries(WORKFLOWS.map((w) => [String(w.check_suite_id), { run: w.id, url: w.html_url, path: w.path, repo: w.repository.full_name, sha: w.head_sha }]));
function watch(runs: Run[], pins: Record<string, CheckPin> | undefined): 'installs' | 'fail' | 'wait' {
  const at = runs.map(runAt);
  const outcome = pins
    ? ((v) => (!v ? 'missing' : v.status !== 'completed' ? 'pending' : v.conclusion === 'success' ? 'pass' : 'fail'))(pinnedVerdict(checksAt('test', at, [], AT, sources), pins.test!, { repo: 'o/r', sha: SHA }))
    : outcomesAt(['test'], at, [], AT)[0]!.outcome;
  return outcome === 'pass' ? 'installs' : outcome === 'pending' ? 'wait' : 'fail';
}

for (const [group, pins, cases] of groups) {
  test(`main watch (${group}): a red or unfinished run of a required name at merge time leaves the merge unaccounted`, () => {
    const wrong: string[] = [];
    for (const c of cases) {
      const green = watch(greenOnly(c), pins as Record<string, CheckPin> | undefined);
      const got = watch(c.runs, pins as Record<string, CheckPin> | undefined);
      if (green !== 'installs' || got !== c.blocks) wrong.push(`${c.what}: ${got} (without it: ${green})`);
    }
    assert.deepEqual(wrong, []);
  });
}

test('main watch: a re-run attempt in the same check suite still replaces its earlier attempt (filter=all lists both)', () => {
  const attempts: Run[] = [{ id: 1, name: 'test', suite: 1, conclusion: 'failure', started: EARLY }, { id: 5, name: 'test', suite: 1 }];
  assert.equal(watch(attempts, undefined), 'installs');
  assert.equal(watch(attempts, PIN_FILE), 'installs');
});
