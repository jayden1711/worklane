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
type Run = { name: string; suite: number; app?: number; conclusion?: string; page?: string; started?: string };
const checkRun = (r: Run, id: number) => ({
  id,
  name: r.name,
  status: 'completed',
  conclusion: r.conclusion ?? 'success',
  started_at: r.started ?? '2026-10-18T10:00:00Z',
  html_url: r.page ?? `https://github.com/example-org/engine/actions/runs/${r.suite * 10}/job/${id}`,
  app: { id: r.app ?? ACTIONS, slug: (r.app ?? ACTIONS) === ACTIONS ? 'github-actions' : `app-${r.app}` },
  check_suite: { id: r.suite },
});
const workflowRun = (suite: number, path: string, o: { repo?: string; sha?: string } = {}) => ({ id: suite * 10, html_url: `https://github.com/${o.repo ?? 'example-org/engine'}/actions/runs/${suite * 10}`, check_suite_id: suite, path, head_sha: o.sha ?? SHA, repository: { full_name: o.repo ?? 'example-org/engine' } });

/** A GitHub that answers the updater's reads for commit SHA; `rules`: the branch's rulesets. Every URL asked is kept. */
function gitHub(o: { runs: Run[]; workflowRuns?: unknown[] | null; rules?: unknown[] | null }) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url.replace(API, ''));
    if (url.startsWith(`${API}/commits/${SHA}/check-runs`)) return { total_count: o.runs.length, check_runs: o.runs.map(checkRun) };
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
  assert.match(r.reason ?? '', /check "test \(ubuntu-latest, 22\)" ended failure/);
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
