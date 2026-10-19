// #727 in the root updater (scripts/machine/worklane-update.cjs): a required check counts only from its pinned source,
// the engine's own checks pinned to their workflow files without a manual step. The GitHub answers are stand-ins for
// the REST API's, a spoofed same-name check from another App or workflow among them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

type Verdict = { ok: boolean; final?: boolean; idle?: boolean; noAnswer?: boolean; reason?: string };
type Cfg = { enabled?: boolean; channel?: string; repo_url?: string; branch?: string; required_checks: string[]; required_check_sources?: Record<string, unknown> };
type Deps = Record<string, unknown>;
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  chooseCommit(deps: Deps, cfg: Cfg, api: string, cands: { sha: string; date: string }[], held: null): Promise<{ chosen?: { sha: string }; wait?: { sha: string }; reason?: string; none?: true; skipped: { sha: string; reason: string }[] }>;
  realDeps(print: (l: string) => void, files: Record<string, string>): { pinChecks?: boolean };
  run(deps: Deps): Promise<string>;
};

const API = 'https://api.github.com/repos/example-org/engine';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ACTIONS = 15368;
// An Actions check run's page is its own job in its suite's workflow run (run id = suite * 10 here, as workflowRun
// makes it); `page` overrides that, e.g. for a check run made through the API into that suite.
// `id` overrides the check run's id (else its place in the list), as GitHub numbers check runs in the order it makes them.
type Run = { name: string; suite: number; app?: number; conclusion?: string; page?: string; started?: string; id?: number; status?: string };
const checkRun = (r: Run, i: number) => ({
  id: r.id ?? i,
  name: r.name,
  status: r.status ?? 'completed',
  conclusion: (r.status ?? 'completed') === 'completed' ? (r.conclusion ?? 'success') : null,
  started_at: r.started ?? '2026-10-18T10:00:00Z',
  html_url: r.page ?? `https://github.com/example-org/engine/actions/runs/${r.suite * 10}/job/${r.id ?? i}`,
  app: { id: r.app ?? ACTIONS, slug: (r.app ?? ACTIONS) === ACTIONS ? 'github-actions' : `app-${r.app}` },
  check_suite: { id: r.suite },
});
const workflowRun = (suite: number, path: string, o: { repo?: string; sha?: string } = {}) => ({ id: suite * 10, html_url: `https://github.com/${o.repo ?? 'example-org/engine'}/actions/runs/${suite * 10}`, check_suite_id: suite, path, head_sha: o.sha ?? SHA, repository: { full_name: o.repo ?? 'example-org/engine' } });

/**
 * A GitHub that answers the updater's reads for commit SHA; `rules`: the branch's rulesets; `statuses`: the commit's
 * (null: no answer). Every URL asked is kept.
 */
function gitHub(o: { runs: Run[]; workflowRuns?: unknown[] | null; rules?: unknown[] | null; statuses?: { context: string; state: string }[] | null }) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url.replace(API, ''));
    if (url.startsWith(`${API}/commits/${SHA}/check-runs`)) return { total_count: o.runs.length, check_runs: o.runs.map(checkRun) };
    if (url.startsWith(`${API}/commits/${SHA}/status?`)) return o.statuses === null ? null : { state: 'success', total_count: (o.statuses ?? []).length, statuses: o.statuses ?? [] };
    if (url.startsWith(`${API}/actions/runs?head_sha=${SHA}`)) return o.workflowRuns === null ? null : { workflow_runs: o.workflowRuns ?? [] };
    if (url === `${API}/rules/branches/main`) return o.rules === null ? null : (o.rules ?? []);
    if (url === `${API}/branches/main`) return { name: 'main', protection: { enabled: false, required_status_checks: { checks: [] } } };
    return null;
  };
  let clock = Date.parse('2026-10-18T12:00:00Z');
  const deps: Deps = { pinChecks: true, fetchJson, now: () => clock, sleep: async (ms: number) => void (clock += ms) };
  return { deps, calls };
}

/** The updater's choice on main's one candidate commit, and its reason when it isn't installed. */
async function choose(cfg: Cfg, gh: ReturnType<typeof gitHub>): Promise<Verdict & { chosen: boolean }> {
  const r = await u.chooseCommit(gh.deps, { branch: 'main', ...cfg }, API, [{ sha: SHA, date: '2026-10-18T09:00:00Z' }], null);
  return { ok: !!r.chosen, chosen: !!r.chosen, reason: r.reason ?? r.skipped[0]?.reason ?? '' };
}

const engine = { required_checks: ['test (ubuntu-latest, 22)', 'scan'] };
const legit = [workflowRun(1, '.github/workflows/ci.yml'), workflowRun(2, '.github/workflows/gitleaks.yml')];

test("the engine's own checks are pinned to their workflow files with no updates.json change: from them, the commit installs", async () => {
  const r = await choose(engine, gitHub({ runs: [{ name: 'test (ubuntu-latest, 22)', suite: 1 }, { name: 'scan', suite: 2 }], workflowRuns: legit }));
  assert.equal(r.chosen, true, r.reason);
});

test('a same-name check from another workflow, a run for another commit, another repo or another App never satisfies a required check', async () => {
  const spoofs: [string, Run[], unknown[]][] = [
    ['another workflow file', [{ name: 'test (ubuntu-latest, 22)', suite: 9 }, { name: 'scan', suite: 2 }], [...legit, workflowRun(9, '.github/workflows/evil.yml')]],
    ['the right file, run for another commit', [{ name: 'test (ubuntu-latest, 22)', suite: 9 }, { name: 'scan', suite: 2 }], [...legit, workflowRun(9, '.github/workflows/ci.yml', { sha: OTHER })]],
    ['the right file, in a fork', [{ name: 'test (ubuntu-latest, 22)', suite: 9 }, { name: 'scan', suite: 2 }], [...legit, workflowRun(9, '.github/workflows/ci.yml', { repo: 'someone/engine' })]],
    ['a check run with no workflow run (made through the API)', [{ name: 'test (ubuntu-latest, 22)', suite: 9 }, { name: 'scan', suite: 2 }], legit],
    ['another App', [{ name: 'test (ubuntu-latest, 22)', suite: 1, app: 4242 }, { name: 'scan', suite: 2 }], legit],
    // Made through the API with a workflow's token, filed into ci.yml's own suite (guess, not measured): its page isn't
    // one of that run's jobs.
    ['a check run in the pinned suite that is not one of its jobs', [{ name: 'test (ubuntu-latest, 22)', suite: 1, page: 'https://github.com/example-org/engine/runs/5' }, { name: 'scan', suite: 2 }], legit],
    ["a job of another run's page", [{ name: 'test (ubuntu-latest, 22)', suite: 1, page: 'https://github.com/example-org/engine/actions/runs/999/job/0' }, { name: 'scan', suite: 2 }], legit],
    // Adversarial pass: the job's path on another host, or over plain http, isn't its run's job page.
    ['the right path on another host', [{ name: 'test (ubuntu-latest, 22)', suite: 1, page: 'https://evil.example/example-org/engine/actions/runs/10/job/0' }, { name: 'scan', suite: 2 }], legit],
    ['the right page over http', [{ name: 'test (ubuntu-latest, 22)', suite: 1, page: 'http://github.com/example-org/engine/actions/runs/10/job/0' }, { name: 'scan', suite: 2 }], legit],
  ];
  for (const [what, runs, workflowRuns] of spoofs) {
    const r = await choose(engine, gitHub({ runs, workflowRuns }));
    assert.equal(r.chosen, false, what);
    assert.match(r.reason ?? '', /required check "test \(ubuntu-latest, 22\)" hasn't run on this commit from its pinned source/, what);
  }
});

test("a required check nothing pins (not the engine's, none in updates.json, none in the branch rules) is judged by name, exactly as before", async () => {
  const cases: Run[][] = [[{ name: 'test', suite: 1, app: 4242 }], [{ name: 'test', suite: 1, app: 4242, conclusion: 'failure' }], []];
  for (const runs of cases) {
    const gh = gitHub({ runs, workflowRuns: legit });
    const pinned = await choose({ required_checks: ['test'] }, gh);
    const before = await choose({ required_checks: ['test'] }, { ...gh, deps: { ...gh.deps, pinChecks: undefined } });
    assert.deepEqual(pinned, before, JSON.stringify(runs));
    assert.ok(gh.calls.includes('/rules/branches/main'), "the branch's rules were asked");
  }
  assert.equal((await choose({ required_checks: ['test'] }, gitHub({ runs: [{ name: 'test', suite: 1, app: 4242 }] }))).chosen, true, 'installed, as before');
  // An invalid updates.json pin refuses, never falls back to the name.
  assert.match((await choose({ required_checks: ['scan'], required_check_sources: { scan: { workflow: 'gitleaks.yml' } } }, gitHub({ runs: [{ name: 'scan', suite: 2 }], workflowRuns: legit }))).reason ?? '', /invalid pin for "scan".*: refused/);
});

test("a check the branch's rules pin under the name __proto__ keeps its pin: another App's run of it doesn't install", async () => {
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: '__proto__', integration_id: 4242 }] } }];
  assert.equal((await choose({ required_checks: ['__proto__'] }, gitHub({ runs: [{ name: '__proto__', suite: 3, app: 5555 }], rules }))).chosen, false);
  assert.equal((await choose({ required_checks: ['__proto__'] }, gitHub({ runs: [{ name: '__proto__', suite: 3, app: 4242 }], rules }))).chosen, true);
});

test("the branch's rules unread (a rate limit, say): a check they might pin waits, never judged by name and never refused", async () => {
  const r = await u.chooseCommit(gitHub({ runs: [{ name: 'test', suite: 1, app: 4242 }], rules: null }).deps, { branch: 'main', required_checks: ['test'] }, API, [{ sha: SHA, date: '2026-10-18T11:59:00Z' }], null);
  assert.equal(r.chosen, undefined);
  assert.match(r.reason ?? '', /no answer for the branch's rules/);
  assert.equal(r.wait?.sha, SHA, 'waits on the commit');
});

test("a pin never turns a fail into a pass: another App's newer failing run of a pinned check still refuses the commit", async () => {
  const r = await choose(engine, gitHub({ runs: [{ name: 'test (ubuntu-latest, 22)', suite: 1 }, { name: 'test (ubuntu-latest, 22)', suite: 8, app: 4242, conclusion: 'failure', started: '2026-10-18T10:05:00Z' }, { name: 'scan', suite: 2 }], workflowRuns: legit }));
  assert.equal(r.chosen, false);
  assert.match(r.reason ?? '', /check "test \(ubuntu-latest, 22\)" (from another source )?ended failure/);
});

test("owner rule: a pinned check is its source's latest run on the commit; any non-pass of its name from another source refuses it", async () => {
  const name = 'test (ubuntu-latest, 22)';
  // ci.yml ran twice on this commit: run 10 (suite 1) and the later run 30 (suite 3).
  const twice = [...legit, workflowRun(3, '.github/workflows/ci.yml')];
  const verdict = async (runs: Run[], workflowRuns: unknown[] = twice) => {
    const r = await choose({ required_checks: [name] }, gitHub({ runs, workflowRuns }));
    return r.chosen ? 'installs' : (r.reason ?? '');
  };
  // 1. Cancelled, then passed in the later run: installs. 2. Failed, then passed: installs. List order doesn't matter
  // (the later run's job has the higher id, as GitHub numbers them).
  assert.equal(await verdict([{ name, suite: 1, conclusion: 'cancelled' }, { name, suite: 3, started: '2026-10-18T09:00:00Z' }]), 'installs');
  assert.equal(await verdict([{ name, suite: 3, started: '2026-10-18T09:00:00Z', id: 5 }, { name, suite: 1, conclusion: 'failure', id: 1 }]), 'installs');
  // Passed, then cancelled in the later run: refused (the later run decides, by the runs' own order).
  assert.match(await verdict([{ name, suite: 1, started: '2026-10-18T11:00:00Z' }, { name, suite: 3, conclusion: 'cancelled' }]), /ended cancelled/);
  // 3. The pinned run passed, and another App's same-name run failed: refused.
  assert.match(await verdict([{ name, suite: 3 }, { name, suite: 8, app: 4242, conclusion: 'failure', started: '2026-10-18T09:00:00Z' }]), /from another source ended failure/);
  // A later ci.yml run for ANOTHER commit never supersedes: its failure refuses, its pass never rescues.
  const otherHead = [...legit, workflowRun(3, '.github/workflows/ci.yml', { sha: OTHER })];
  assert.match(await verdict([{ name, suite: 1 }, { name, suite: 3, conclusion: 'failure' }], otherHead), /from another source ended failure/);
  assert.match(await verdict([{ name, suite: 1, conclusion: 'failure' }, { name, suite: 3 }], otherHead), /ended failure/);
});

test('owner rule: a re-run attempt in the same workflow run counts as the newer; an unpinned --add-check name is judged as before', async () => {
  const name = 'test (ubuntu-latest, 22)';
  // Both check runs are jobs of run 10 (suite 1): ids 0 (failed) and 1 (the re-run's pass), listed failure last.
  assert.equal((await choose({ required_checks: [name] }, gitHub({ runs: [{ name, suite: 1 }, { name, suite: 1, conclusion: 'failure', started: '2026-10-18T11:00:00Z' }], workflowRuns: legit }))).chosen, false, 'id 1 is the failure: the newer attempt failed');
  assert.equal((await choose({ required_checks: [name] }, gitHub({ runs: [{ name, suite: 1, conclusion: 'failure', started: '2026-10-18T11:00:00Z' }, { name, suite: 1 }], workflowRuns: legit }))).chosen, true, 'id 1 is the pass: the newer attempt passed');
  // Unpinned: the latest run by name decides, from any source, exactly as before pins.
  const gh = gitHub({ runs: [{ name: 'extra', suite: 5, app: 4242 }, { name: 'extra', suite: 6, app: 5555, conclusion: 'failure', started: '2026-10-18T09:00:00Z' }], workflowRuns: legit });
  const pinned = await choose({ required_checks: ['extra'] }, gh);
  assert.deepEqual(pinned, await choose({ required_checks: ['extra'] }, { ...gh, deps: { ...gh.deps, pinChecks: undefined } }));
  assert.equal(pinned.chosen, true, 'the older failure is not its latest run: installs, as before');
});

test('an Actions-App pin never lets one workflow file supersede another: every file\'s latest run must pass', async () => {
  // The branch rules pin "lint" to GitHub Actions' App: ci.yml (suite 1, run 10) and evil.yml (suite 9, run 90), the
  // latter added in the commit itself.
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint', integration_id: ACTIONS }] } }];
  const files = [...legit, workflowRun(9, '.github/workflows/evil.yml')];
  const verdict = async (runs: Run[]) => {
    const r = await choose({ required_checks: ['lint'] }, gitHub({ runs, workflowRuns: files, rules }));
    return r.chosen ? 'installs' : (r.reason ?? '');
  };
  assert.match(await verdict([{ name: 'lint', suite: 1, conclusion: 'failure' }, { name: 'lint', suite: 9 }]), /"lint" ended failure/, 'ci.yml failed, evil.yml passed later');
  assert.match(await verdict([{ name: 'lint', suite: 1, status: 'in_progress' }, { name: 'lint', suite: 9 }]), /"lint" is in_progress/, 'ci.yml still running');
  assert.match(await verdict([{ name: 'lint', suite: 1 }, { name: 'lint', suite: 9, conclusion: 'failure' }]), /"lint" ended failure/, 'the added evil.yml failed');
  assert.equal(await verdict([{ name: 'lint', suite: 1 }, { name: 'lint', suite: 9 }]), 'installs', 'both passed');
});

test('"latest" fails closed: run 200 passed, then run 100 was re-run and failed: refused; the owner\'s cases stay', async () => {
  const name = 'test (ubuntu-latest, 22)';
  // ci.yml ran twice on this commit: run 100 (suite 10) and run 200 (suite 20).
  const runs = [...legit, workflowRun(10, '.github/workflows/ci.yml'), workflowRun(20, '.github/workflows/ci.yml')];
  const verdict = async (list: Run[]) => {
    const r = await choose({ required_checks: [name] }, gitHub({ runs: list, workflowRuns: runs }));
    return r.chosen ? 'installs' : (r.reason ?? '');
  };
  // Check runs 10 (run 100's first attempt, passed), 20 (run 200, passed), 30 (run 100's re-run, failed).
  assert.match(await verdict([{ name, suite: 10, id: 10 }, { name, suite: 20, id: 20 }, { name, suite: 10, id: 30, conclusion: 'failure' }]), /ended failure/);
  assert.match(await verdict([{ name, suite: 20, id: 20 }, { name, suite: 10, id: 30, conclusion: 'cancelled' }]), /ended cancelled/);
  // The owner's cases: run 100 cancelled or failed, then run 200 passed: installs.
  assert.equal(await verdict([{ name, suite: 10, id: 10, conclusion: 'cancelled' }, { name, suite: 20, id: 20 }]), 'installs');
  assert.equal(await verdict([{ name, suite: 20, id: 20 }, { name, suite: 10, id: 10, conclusion: 'failure' }]), 'installs');
});

test("a pinned check's same-name commit status that isn't success refuses it (pending waits); no answer for the statuses waits", async () => {
  const name = 'scan';
  const verdict = async (statuses: { context: string; state: string }[] | null) => {
    const r = await u.chooseCommit(gitHub({ runs: [{ name, suite: 2 }], workflowRuns: legit, statuses }).deps, { branch: 'main', required_checks: [name] }, API, [{ sha: SHA, date: '2026-10-18T11:59:00Z' }], null);
    return r.chosen ? 'installs' : `${r.wait ? 'waits' : 'refused'}: ${r.reason ?? r.skipped[0]?.reason ?? ''}`;
  };
  assert.match(await verdict([{ context: name, state: 'failure' }]), /^refused: .*"scan" has a commit status that ended failure/);
  assert.match(await verdict([{ context: name, state: 'error' }]), /^refused: .*ended error/);
  assert.match(await verdict([{ context: name, state: 'pending' }]), /^waits: .*"scan" has a pending commit status/);
  assert.match(await verdict(null), /^waits: GitHub gave no answer for its commit statuses/);
  assert.equal(await verdict([{ context: name, state: 'success' }, { context: 'other', state: 'failure' }]), 'installs', 'a success of its name, and another name\'s status, as before');
  assert.equal(await verdict([]), 'installs');
});

test('every pager reads on past a full page whose total_count is missing or wrong (statuses, workflow runs, check runs)', async () => {
  const name = 'scan';
  // 100 statuses of other contexts on page 1, the pinned name's failure on page 2.
  const filler = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ context: `${prefix}-${i}`, state: 'success' }));
  for (const total of [undefined, 100]) {
    const calls: string[] = [];
    let clock = Date.parse('2026-10-18T12:00:00Z');
    const fetchJson = async (url: string) => {
      calls.push(url.replace(API, ''));
      if (url.startsWith(`${API}/commits/${SHA}/check-runs`)) return { total_count: 1, check_runs: [checkRun({ name, suite: 2 }, 0)] };
      if (url.startsWith(`${API}/actions/runs?head_sha=${SHA}`)) return url.includes('page=2') ? { workflow_runs: [] } : { workflow_runs: [...legit, ...Array.from({ length: 98 }, (_, i) => workflowRun(100 + i, '.github/workflows/other.yml'))] };
      if (url.startsWith(`${API}/commits/${SHA}/status?`)) return url.includes('page=2') ? { total_count: total, statuses: [{ context: name, state: 'failure' }] } : { ...(total === undefined ? {} : { total_count: total }), statuses: filler(100, 'other') };
      return null;
    };
    const deps = { pinChecks: true, fetchJson, now: () => clock, sleep: async (ms: number) => void (clock += ms) };
    const r = await u.chooseCommit(deps, { branch: 'main', required_checks: [name] }, API, [{ sha: SHA, date: '2026-10-18T09:00:00Z' }], null);
    assert.equal(r.chosen, undefined, `total_count ${total}: page 2's failing status refuses`);
    assert.match(r.skipped[0]?.reason ?? r.reason ?? '', /"scan" has a commit status that ended failure/);
    assert.ok(calls.some((c) => c.startsWith('/actions/runs') && c.includes('page=2')), 'a full page of workflow runs: the next page is read');
  }
  // Check runs: a full page whose total_count says 100, a failing check on page 2: refused (it used to stop at page 1).
  let clock = Date.parse('2026-10-18T12:00:00Z');
  const runsOn = (page: number) => (page === 1 ? Array.from({ length: 100 }, (_, i) => checkRun({ name: i === 0 ? name : `other-${i}`, suite: 2 }, i)) : [checkRun({ name: 'lint', suite: 2, conclusion: 'failure' }, 500)]);
  const fetchJson = async (url: string) => {
    if (url.startsWith(`${API}/commits/${SHA}/check-runs`)) return { total_count: 100, check_runs: runsOn(url.includes('page=2') ? 2 : 1) };
    if (url.startsWith(`${API}/actions/runs?head_sha=${SHA}`)) return { workflow_runs: legit };
    if (url.startsWith(`${API}/commits/${SHA}/status?`)) return { total_count: 0, statuses: [] };
    return null;
  };
  const r = await u.chooseCommit({ pinChecks: true, fetchJson, now: () => clock, sleep: async (ms: number) => void (clock += ms) }, { branch: 'main', required_checks: [name] }, API, [{ sha: SHA, date: '2026-10-18T09:00:00Z' }], null);
  assert.equal(r.chosen, undefined);
  assert.match(r.skipped[0]?.reason ?? r.reason ?? '', /check "lint" ended failure/);
});

test('check runs still full past CHECK_PAGES_MAX pages wait while pins are judged: a failing run of another source on page 11 never installs', async () => {
  const name = 'scan';
  const verdict = async (failOn: number) => {
    let clock = Date.parse('2026-10-18T12:00:00Z');
    const page = (n: number) => (n === 1 ? [checkRun({ name, suite: 2 }, 0), ...Array.from({ length: 99 }, (_, i) => checkRun({ name: `other-${i}`, suite: 2 }, 1 + i))] : n < failOn ? Array.from({ length: 100 }, (_, i) => checkRun({ name: `other-${n}-${i}`, suite: 2 }, n * 1000 + i)) : [checkRun({ name, suite: 8, app: 4242, conclusion: 'failure' }, 99_999)]);
    const fetchJson = async (url: string) => {
      if (url.startsWith(`${API}/commits/${SHA}/check-runs`)) return { total_count: 1100, check_runs: page(Number(new URL(url).searchParams.get('page') ?? '1')) };
      if (url.startsWith(`${API}/actions/runs?head_sha=${SHA}`)) return { workflow_runs: legit };
      if (url.startsWith(`${API}/commits/${SHA}/status?`)) return { total_count: 0, statuses: [] };
      return null;
    };
    const r = await u.chooseCommit({ pinChecks: true, fetchJson, now: () => clock, sleep: async (ms: number) => void (clock += ms) }, { branch: 'main', required_checks: [name] }, API, [{ sha: SHA, date: '2026-10-18T11:59:00Z' }], null);
    return r.chosen ? 'installs' : `${r.wait ? 'waits' : 'refused'}: ${r.reason ?? r.skipped[0]?.reason ?? ''}`;
  };
  assert.match(await verdict(10), /^refused: .*"scan" from another source ended failure/, 'page 10 is read');
  assert.match(await verdict(11), /^waits: GitHub gave no answer for its check runs/, 'past page 10: no answer, never an install (457e89b5 installed)');
});

test("round 8: with no required check pinned (a bare `custom`, no rules App), 11 full pages of check runs install as on main, with main's reads", async () => {
  let clock = Date.parse('2026-10-18T12:00:00Z');
  const calls: string[] = [];
  const page = (n: number) => (n === 1 ? [checkRun({ name: 'custom', suite: 5, app: 4242 }, 0), ...Array.from({ length: 99 }, (_, i) => checkRun({ name: `other-${i}`, suite: 5, app: 4242 }, 1 + i))] : Array.from({ length: 100 }, (_, i) => checkRun({ name: `other-${n}-${i}`, suite: 5, app: 4242 }, n * 1000 + i)));
  const fetchJson = async (url: string) => {
    calls.push(url.replace(API, '').replace(/\?.*/, ''));
    if (url.startsWith(`${API}/commits/${SHA}/check-runs`)) return { total_count: 1100, check_runs: page(Number(new URL(url).searchParams.get('page') ?? '1')) };
    if (url === `${API}/rules/branches/main`) return [];
    if (url === `${API}/branches/main`) return { name: 'main', protection: { enabled: false } };
    return null;
  };
  const r = await u.chooseCommit({ pinChecks: true, fetchJson, now: () => clock, sleep: async (ms: number) => void (clock += ms) }, { branch: 'main', required_checks: ['custom'] }, API, [{ sha: SHA, date: '2026-10-18T11:59:00Z' }], null);
  assert.equal(r.chosen?.sha, SHA, `installs, as on main (5520710c waited): ${r.reason ?? ''}`);
  assert.equal(calls.filter((c) => c.endsWith('/check-runs')).length, 10, 'ten pages, as main');
  assert.equal(calls.filter((c) => c.startsWith('/actions/') || c.endsWith('/status')).length, 0, 'no workflow-run or status read');
});

test('the read cost: a commit where a pinned required check has no run at all reads neither its workflow runs nor its statuses', async () => {
  const gh = gitHub({ runs: [{ name: 'scan', suite: 2 }], workflowRuns: legit });
  const r = await choose(engine, gh);
  assert.equal(r.chosen, false);
  assert.match(r.reason ?? '', /"test \(ubuntu-latest, 22\)" hasn't run on this commit from its pinned source/);
  assert.deepEqual(gh.calls.map((c) => c.replace(/\?.*/, '')), [`/commits/${SHA}/check-runs`], 'one read: the check runs');
  // A pinned check with runs but no pass at all; a check judged by name that ended red, or is still running: one read each.
  const oneRead = async (runs: Run[], why: RegExp) => {
    const g = gitHub({ runs, workflowRuns: legit });
    const v = await choose(engine, g);
    assert.equal(v.chosen, false);
    assert.match(v.reason ?? '', why);
    assert.deepEqual(g.calls.map((c) => c.replace(/\?.*/, '')), [`/commits/${SHA}/check-runs`], String(why));
  };
  await oneRead([{ name: 'test (ubuntu-latest, 22)', suite: 1, conclusion: 'failure' }, { name: 'scan', suite: 2 }], /"test \(ubuntu-latest, 22\)" ended failure/);
  await oneRead([{ name: 'test (ubuntu-latest, 22)', suite: 1 }, { name: 'scan', suite: 2 }, { name: 'lint-bot', suite: 7, app: 4242, conclusion: 'failure' }], /check "lint-bot" ended failure/);
  await oneRead([{ name: 'test (ubuntu-latest, 22)', suite: 1 }, { name: 'scan', suite: 2 }, { name: 'lint-bot', suite: 7, app: 4242, status: 'in_progress' }], /check "lint-bot" is in_progress/);
  // With every pinned check present, both are read.
  const all = gitHub({ runs: [{ name: 'test (ubuntu-latest, 22)', suite: 1 }, { name: 'scan', suite: 2 }], workflowRuns: legit });
  assert.equal((await choose(engine, all)).chosen, true);
  assert.deepEqual(all.calls.map((c) => c.replace(/\?.*/, '')), [`/commits/${SHA}/check-runs`, '/actions/runs', `/commits/${SHA}/status`]);
});

test('a pin to an App that is not Actions fails closed: every one of its check runs listed must pass', async () => {
  const pin = { required_checks: ['scan'], required_check_sources: { scan: { app_id: 4242 } } };
  const verdict = async (runs: Run[]) => {
    const r = await choose(pin, gitHub({ runs }));
    return r.chosen ? 'installs' : (r.reason ?? '');
  };
  // Its first suite cancelled or failed, its second passed: refused (no file to group by, so nothing supersedes).
  assert.match(await verdict([{ name: 'scan', suite: 11, app: 4242, conclusion: 'cancelled' }, { name: 'scan', suite: 12, app: 4242 }]), /"scan" ended cancelled/);
  assert.match(await verdict([{ name: 'scan', suite: 12, app: 4242 }, { name: 'scan', suite: 11, app: 4242, conclusion: 'failure' }]), /"scan" ended failure/);
  // A re-run GitHub lists in place of the failure (the latest of its suite): installs; both suites passed: installs.
  assert.equal(await verdict([{ name: 'scan', suite: 11, app: 4242 }]), 'installs');
  assert.equal(await verdict([{ name: 'scan', suite: 11, app: 4242 }, { name: 'scan', suite: 12, app: 4242 }]), 'installs');
});

test("updates.json required_check_sources pins a check (over the updater's own list); the branch rules' App pins one it doesn't name", async () => {
  const own = await choose({ required_checks: ['scan'], required_check_sources: { scan: { app_id: 4242 } } }, gitHub({ runs: [{ name: 'scan', suite: 2 }], workflowRuns: legit }));
  assert.equal(own.chosen, false, 'from Actions, but pinned to App 4242');
  assert.equal((await choose({ required_checks: ['scan'], required_check_sources: { scan: { app_id: 4242 } } }, gitHub({ runs: [{ name: 'scan', suite: 2, app: 4242 }] }))).chosen, true);
  const rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint', integration_id: 4242 }] } }];
  assert.equal((await choose({ required_checks: ['lint'] }, gitHub({ runs: [{ name: 'lint', suite: 3, app: ACTIONS }], rules }))).chosen, false);
  assert.equal((await choose({ required_checks: ['lint'] }, gitHub({ runs: [{ name: 'lint', suite: 3, app: 4242 }], rules }))).chosen, true);
});

test('no answer for the workflow runs: wait, never a pass', async () => {
  const r = await u.chooseCommit(gitHub({ runs: [{ name: 'scan', suite: 2 }], workflowRuns: null }).deps, { branch: 'main', required_checks: ['scan'] }, API, [{ sha: SHA, date: '2026-10-18T11:59:00Z' }], null);
  assert.equal(r.chosen, undefined);
  assert.match(r.reason ?? '', /no answer for its workflow runs/);
});

test("the release channel judges the release's main commit the same way", async () => {
  const listing = `${'3'.repeat(40)}\trefs/tags/v0.5.0\n${'b'.repeat(40)}\trefs/tags/v0.5.0^{}\n`;
  const machine = (runs: Run[]) => {
    const gh = gitHub({ runs, workflowRuns: legit });
    const notes: string[] = [];
    let current = 'a'.repeat(39) + 'f';
    const deps = {
      ...gh.deps,
      config: () => ({ enabled: true, channel: 'release', repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['scan'] }),
      installed: () => current,
      installedVersion: () => '0.4.1',
      verifyRelease: () => ({ ok: true, base: SHA, object: '3'.repeat(40), commit: 'b'.repeat(40) }),
      exec: (file: string, args: string[]) => (file === 'git' ? listing : file === 'systemctl' && args[0] === 'show' ? 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n' : file === 'systemctl' ? 'worklane-x.service loaded active running x\n' : ''),
      slots: () => [],
      alive: () => false,
      installTree: () => undefined,
      syncHelpers: () => [],
      switchTo: (sha: string) => void (current = sha),
      log: () => undefined,
      held: () => null,
      hold: () => undefined,
      configChangedAt: () => 0,
      note: (event: string, _sha: string | null, reason: string) => (notes.push(`${event}: ${reason}`), event),
      checked: () => undefined,
    };
    return { deps, notes };
  };
  const spoofed = machine([{ name: 'scan', suite: 2, app: 4242 }]);
  assert.notEqual(await u.run(spoofed.deps), 'installed');
  assert.match(spoofed.notes.join('\n'), /"scan" hasn't run on this commit from its pinned source/);
  assert.equal(await u.run(machine([{ name: 'scan', suite: 2 }]).deps), 'installed');
});

test('adversarial pass: turning updates off works whatever the pins say (an invalid one included), and reads nothing', async () => {
  const gh = gitHub({ runs: [] });
  const deps = { ...gh.deps, config: () => ({ enabled: false, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['scan'], required_check_sources: { scan: 'junk', __proto__x: 1 } }), log: () => undefined, note: (e: string) => e, checked: () => undefined, stuck: () => null, saveStuck: () => undefined };
  assert.equal(await u.run(deps), 'disabled');
  assert.deepEqual(gh.calls, [], 'no GitHub read');
});

test('the installed updater always judges by source: realDeps turns it on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'update-pins-'));
  assert.equal(u.realDeps(() => undefined, { log: join(dir, 'l'), state: join(dir, 's'), held: join(dir, 'h'), drain: join(dir, 'd') }).pinChecks, true);
});
