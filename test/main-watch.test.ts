// The main watch (src/main-watch.ts) over a real git remote and a fake GitHub: which commits on the default branch
// are accounted for, at most one API call a minute, and a last checked commit that survives a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GitHubBacklog } from '../src/backlog/github.js';
import { PinnedChecks, type CheckPin, type WorkflowSource } from '../src/check-source.js';
import { readiness } from '../src/pr-watch.js';
import type { Role } from '../src/dashboard-auth.js';
import { GitHubMainWatchApi } from '../src/github/main-watch-api.js';
import { acceptGit, acceptMerge, CONFIG_PATH, DEAD_CHECK_MS, disabledWorkflowFor, disabledWorkflowsOf, judge, LINK_LAG_MS, MAIN_WATCH_CALL_MS, MainWatch, outcomesAt, protectionView, readWatchState, repoGit, revertCapsAt, type Acceptance, type AcceptTarget, type CheckRunAt, type Compared, type MainWatchApi, type MainWatchDeps, type MergedPull, type ProtectionMode, type StatusAt, subjectPrNumber, tripOf, type Trip, type WatchGit, type WorkflowAt } from '../src/main-watch.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];

/** A remote, a clone people push from, and the coordinator's clone the watch reads. */
function world(o: { config?: string; files?: Record<string, string> } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'main-watch-'));
  const remote = join(base, 'remote.git');
  const person = join(base, 'person');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', person);
  writeFileSync(join(person, 'a.txt'), 'a\n');
  git(person, 'add', 'a.txt');
  const files = { ...(o.config !== undefined ? { [CONFIG_PATH]: o.config } : {}), ...o.files };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(person, path)), { recursive: true });
    writeFileSync(join(person, path), text);
    git(person, 'add', path);
  }
  git(person, ...ident, 'commit', '-q', '-m', 'init');
  git(person, 'remote', 'add', 'origin', remote);
  git(person, 'push', '-q', 'origin', 'main');
  const coord = join(base, 'coord');
  git(base, 'clone', '-q', remote, coord);
  let n = 0;
  /** A commit pushed straight to main. */
  const directPush = () => {
    writeFileSync(join(person, `d${++n}.txt`), `${n}\n`);
    git(person, 'add', '-A');
    git(person, ...ident, 'commit', '-q', '-m', `direct ${n}`);
    git(person, 'push', '-q', 'origin', 'main');
    return git(person, 'rev-parse', 'HEAD');
  };
  /** A branch merged into main with a merge commit, as GitHub's merge button does: the merge commit and the PR head. */
  const mergedPr = () => {
    git(person, 'checkout', '-q', '-b', `f${++n}`);
    writeFileSync(join(person, `f${n}.txt`), `${n}\n`);
    git(person, 'add', '-A');
    git(person, ...ident, 'commit', '-q', '-m', `feature ${n}`);
    const head = git(person, 'rev-parse', 'HEAD');
    git(person, 'checkout', '-q', 'main');
    git(person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, head);
    git(person, 'push', '-q', 'origin', 'main');
    return { merge: git(person, 'rev-parse', 'HEAD'), head };
  };
  return { base, remote, coord, directPush, mergedPr, stateFile: join(base, 'main-watch.json') };
}

/** A GitHub that answers from what the test set, counting every call. */
function fakeGitHub() {
  const calls: { at: number; what: string }[] = [];
  const pulls = new Map<string, MergedPull[]>();
  const prs = new Map<number, MergedPull>();
  const runs = new Map<string, CheckRunAt[]>();
  const statuses = new Map<string, StatusAt[]>();
  const roles = new Map<string, Role | null>();
  /** GitHub's compare, by `base...head`; not set: head is behind base (not in that merge). */
  const compares = new Map<string, Compared>();
  /** The workflow run behind each check suite on a commit, by suite id (#727). */
  const sources = new Map<string, Record<string, WorkflowSource>>();
  /** `workflows`: the Actions workflows' list; null: GitHub answered 403 or 404; 'throw': any other error. */
  const g = { protection: 'none' as 'enforced' | 'none', now: 0, workflows: null as WorkflowAt[] | null | 'throw' };
  const call = (what: string) => calls.push({ at: g.now, what });
  const api: MainWatchApi = {
    protection: async () => (call('protection'), g.protection),
    commitPulls: async (sha) => (call(`pulls ${sha.slice(0, 7)}`), pulls.get(sha) ?? []),
    pull: async (n) => (call(`pull #${n}`), prs.get(n)!),
    checkRuns: async (sha) => (call(`runs ${sha.slice(0, 7)}`), runs.get(sha) ?? []),
    statuses: async (sha) => (call(`statuses ${sha.slice(0, 7)}`), statuses.get(sha) ?? []),
    runSources: async (sha) => (call(`sources ${sha.slice(0, 7)}`), sources.get(sha) ?? {}),
    role: async (login) => (call(`role ${login}`), roles.get(login) ?? null),
    compare: async (base, head) => (call(`compare ${base.slice(0, 7)}...${head.slice(0, 7)}`), compares.get(`${base}...${head}`) ?? { status: 'behind', aheadBy: 0, behindBy: 1 }),
    workflows: async () => {
      call('workflows');
      if (g.workflows === 'throw') throw new Error('GitHub 502 reading the Actions workflows');
      return g.workflows;
    },
  };
  /** A PR merged at `at` by `by`, its merge commit `merge`, its head `head`. */
  const pr = (number: number, merge: string, head: string, at: string, by: string | null, bot = false): MergedPull => {
    const p = { number, url: `https://github.com/example-org/example-shop/pull/${number}`, mergedAt: at, mergeCommit: merge, mergedBy: by, mergedByBot: bot, head, base: 'main' };
    pulls.set(merge, [p]);
    prs.set(number, p);
    return p;
  };
  return { api, calls, pulls, prs, runs, statuses, roles, compares, sources, g, pr };
}

const T = Date.parse('2026-10-12T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ci = (o: Partial<CheckRunAt> = {}): CheckRunAt => ({ name: 'ci', status: 'completed', conclusion: 'success', startedAt: iso(T - 10 * 60_000), completedAt: iso(T - 5 * 60_000), ...o });

function watcher(w: ReturnType<typeof world>, gh: ReturnType<typeof fakeGitHub>, o: { harness?: Map<string, { number: number; head: string; at: string }>; required?: string[]; pins?: MainWatchDeps['pins'] } = {}) {
  const out = { modes: [] as { mode: ProtectionMode; detail: string }[], checked: [] as { sha: string; how: string; number: number }[], accepted: [] as { sha: string; number: number | null; a: Acceptance }[], unaccounted: [] as { sha: string; reason: string; number: number | null; revert: boolean; trip: Trip | null }[], dead: [] as { check: string; since: string; state: string; workflow?: WorkflowAt }[] };
  const watch = new MainWatch({
    stateFile: w.stateFile,
    branch: 'main',
    required: () => o.required ?? ['ci'],
    ...(o.pins ? { pins: o.pins } : {}),
    deadCheck: (d) => void out.dead.push(d),
    api: gh.api,
    git: repoGit(w.coord, 'origin', 'main'),
    harnessMerge: (sha) => o.harness?.get(sha) ?? null,
    now: () => gh.g.now,
    mode: (mode, detail) => out.modes.push({ mode, detail }),
    checked: (sha, how, number) => out.checked.push({ sha, how, number }),
    accepted: (sha, number, a) => out.accepted.push({ sha, number, a }),
    unaccounted: async (u) => void out.unaccounted.push(u),
  });
  return { watch, ...out };
}

/** Run the coordinator's timer for `minutes`, a pass every 10 s. */
async function run(gh: ReturnType<typeof fakeGitHub>, watch: MainWatch, minutes: number) {
  for (let i = 0; i < minutes * 6; i++) {
    gh.g.now += 10_000;
    await watch.step();
  }
}

/** A watch that has asked about protection and taken main's tip as its baseline. */
async function started(o: { harness?: Map<string, { number: number; head: string; at: string }>; required?: string[]; config?: string; files?: Record<string, string>; pins?: MainWatchDeps['pins'] } = {}) {
  const w = world({ ...(o.config === undefined ? {} : { config: o.config }), ...(o.files ? { files: o.files } : {}) });
  const gh = fakeGitHub();
  gh.g.now = T + 60 * 60_000;
  const s = watcher(w, gh, o);
  await run(gh, s.watch, 1);
  assert.deepEqual(s.modes.map((m) => m.mode), ['main_watch'], 'no protection on GitHub: the watch is on');
  assert.equal(readWatchState(w.stateFile).last, git(w.coord, 'rev-parse', 'origin/main'), "main's tip is the baseline");
  return { w, gh, ...s };
}

test('main watch: a green PR merged by a writer is accounted for; nothing stops', async () => {
  const s = await started();
  const m = s.w.mergedPr();
  s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(m.head, [ci()]);
  await run(s.gh, s.watch, 6);
  assert.deepEqual(s.unaccounted, [], 'nothing unaccounted');
  assert.deepEqual(s.checked, [{ sha: m.merge, how: 'person', number: 7 }]);
  assert.equal(readWatchState(s.w.stateFile).last, m.merge);
});

test("main watch: a merge is judged by the required_checks committed at its first parent, not the startup config's", async () => {
  // The startup config still lists a check the default branch has since dropped (a clone whose working tree was
  // never updated): the merge is judged by the config as committed just before it, so it's accounted for.
  const s = await started({ required: ['ci', 'test (macos-latest)'], config: 'required_checks:\n  - ci\n' });
  const m = s.w.mergedPr();
  s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(m.head, [ci()]);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.unaccounted, [], 'the dropped check is not required of it');
  assert.deepEqual(s.checked, [{ sha: m.merge, how: 'person', number: 7 }]);

  // And the other way: a check added on the branch since startup is required.
  const a = await started({ required: ['ci'], config: 'required_checks: [ci, lint]\n' });
  const n = a.w.mergedPr();
  a.gh.pr(8, n.merge, n.head, iso(T), 'example-collaborator');
  a.gh.roles.set('example-collaborator', 'writer');
  a.gh.runs.set(n.head, [ci()]);
  await run(a.gh, a.watch, 7);
  assert.equal(a.unaccounted.length, 1);
  assert.match(a.unaccounted[0]!.reason, /lint missing/);
  assert.doesNotMatch(a.unaccounted[0]!.reason, /loaded at startup/);
});

test('main watch (#727): a merge whose required checks came from another App or workflow than their pins, or a status, is unaccounted', async () => {
  const repo = 'example-org/example-shop';
  const pins = { sources: () => ({}), github: async () => ({}), repo };
  const config = 'required_checks: [ci, lint, deploy]\nrequired_check_sources:\n  ci: { app_id: 1111 }\n  lint: { workflow: .github/workflows/ci.yml }\n  deploy: { app_id: 1111 }\n';
  const s = await started({ pins, config });
  const m = s.w.mergedPr();
  s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  // A job of workflow run 7000 (suite 70) has the page .../actions/runs/7000/job/<its id>.
  const job = (id: number) => ({ id, url: `https://github.com/${repo}/actions/runs/7000/job/${id}` });
  s.gh.runs.set(m.head, [ci({ app: 2222, suite: 1 }), ci({ name: 'lint', app: 15368, suite: 70, ...job(701) })]);
  s.gh.statuses.set(m.head, [{ context: 'deploy', state: 'success', createdAt: iso(T - 60_000) }]);
  const runPage = `https://github.com/${repo}/actions/runs/7000`;
  s.gh.sources.set(m.head, { '70': { run: 7000, url: runPage, path: '.github/workflows/evil.yml', repo, sha: m.head } });
  await run(s.gh, s.watch, 8);
  assert.equal(s.unaccounted.length, 1);
  assert.match(s.unaccounted[0]!.reason, /ci missing, lint missing, deploy missing/);

  // From their pinned sources, the same merge is accounted for.
  const a = await started({ pins, config });
  const n = a.w.mergedPr();
  a.gh.pr(8, n.merge, n.head, iso(T), 'example-collaborator');
  a.gh.roles.set('example-collaborator', 'writer');
  a.gh.runs.set(n.head, [ci({ app: 1111, suite: 1 }), ci({ name: 'lint', app: 15368, suite: 70, ...job(701) }), ci({ name: 'deploy', app: 1111, suite: 1 })]);
  a.gh.sources.set(n.head, { '70': { run: 7000, url: runPage, path: '.github/workflows/ci.yml', repo, sha: n.head } });
  await run(a.gh, a.watch, 8);
  assert.deepEqual(a.unaccounted, []);
  assert.deepEqual(a.checked, [{ sha: n.merge, how: 'person', number: 8 }]);
  assert.ok(a.gh.calls.some((c) => c.what === `sources ${n.head.slice(0, 7)}`), 'the workflow runs were read for the workflow pin');

  // A check run in the pinned workflow's suite that isn't one of its run's own jobs (made through the API: its page
  // is not .../actions/runs/7000/job/<id>; guess, not measured) doesn't count.
  const api = await started({ pins, config });
  const q = api.w.mergedPr();
  api.gh.pr(10, q.merge, q.head, iso(T), 'example-collaborator');
  api.gh.roles.set('example-collaborator', 'writer');
  api.gh.runs.set(q.head, [ci({ app: 1111, suite: 1 }), ci({ name: 'lint', app: 15368, suite: 70, id: 702, url: `https://github.com/${repo}/runs/702` }), ci({ name: 'deploy', app: 1111, suite: 1 })]);
  api.gh.sources.set(q.head, { '70': { run: 7000, url: runPage, path: '.github/workflows/ci.yml', repo, sha: q.head } });
  await run(api.gh, api.watch, 8);
  assert.match(api.unaccounted[0]?.reason ?? '', /: lint missing$/);
});

test("main watch (#727): pinning never turns a check that wasn't a pass into one: another App's newer failing run still fails it", async () => {
  const pins = { sources: () => ({}), github: async () => ({}), repo: 'example-org/example-shop' };
  const s = await started({ pins, config: 'required_checks: [ci]\nrequired_check_sources:\n  ci: { app_id: 1111 }\n' });
  const m = s.w.mergedPr();
  s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(m.head, [ci({ app: 1111, suite: 1 }), ci({ app: 2222, suite: 2, conclusion: 'failure', startedAt: iso(T - 8 * 60_000) })]);
  await run(s.gh, s.watch, 8);
  assert.match(s.unaccounted[0]?.reason ?? '', /: ci fail$/);
});

test("main watch (#727, owner rule): a pinned check is its source's latest run on the head; any non-pass of its name from another source blocks it", async () => {
  const repo = 'example-org/example-shop';
  const pins = { sources: () => ({}), github: async () => ({}), repo };
  const config = 'required_checks: [ci]\nrequired_check_sources:\n  ci: { workflow: .github/workflows/ci.yml }\n';
  // ci.yml ran twice on the head: run 100 (suite 1), then run 200 (suite 2); run 300 (suite 3) is ci.yml for another head.
  const page = (run: number) => `https://github.com/${repo}/actions/runs/${run}`;
  const job = (suite: number, id: number) => ({ app: 15368, suite, id, url: `${page(suite * 100)}/job/${id}` });
  const verdict = async (runs: CheckRunAt[], statuses: StatusAt[] = []) => {
    const s = await started({ pins, config });
    const m = s.w.mergedPr();
    s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
    s.gh.roles.set('example-collaborator', 'writer');
    s.gh.runs.set(m.head, runs);
    s.gh.statuses.set(m.head, statuses);
    s.gh.sources.set(m.head, { '1': { run: 100, url: page(100), path: '.github/workflows/ci.yml', repo, sha: m.head }, '2': { run: 200, url: page(200), path: '.github/workflows/ci.yml', repo, sha: m.head }, '3': { run: 300, url: page(300), path: '.github/workflows/ci.yml', repo, sha: 'f'.repeat(40) } });
    await run(s.gh, s.watch, 8);
    return s.unaccounted[0]?.reason.replace(/^.*: /, '') ?? (s.checked.length ? 'accounted' : 'none');
  };
  // Started later in time but in the earlier run: ordering is by the runs' own order, not by start time or list order.
  const early = { startedAt: iso(T - 20 * 60_000), completedAt: iso(T - 15 * 60_000) };
  // 1. Cancelled, then passed in the later run: accounted. 2. Failed, then passed: accounted.
  assert.equal(await verdict([ci({ ...job(1, 11), conclusion: 'cancelled' }), ci({ ...job(2, 21), ...early })]), 'accounted');
  assert.equal(await verdict([ci({ ...job(2, 21), ...early }), ci({ ...job(1, 11), conclusion: 'failure' })]), 'accounted');
  // Passed, then cancelled in the later run: the later run decides.
  assert.equal(await verdict([ci(job(1, 11)), ci({ ...job(2, 21), conclusion: 'cancelled', ...early })]), 'ci fail');
  // A re-run attempt in the same workflow run (a newer check run, same suite) counts as the newer.
  assert.equal(await verdict([ci({ ...job(1, 19), ...early }), ci({ ...job(1, 11), conclusion: 'failure' })]), 'accounted');
  // 3. The pinned run passed, and another App's same-name check failed: unaccounted.
  assert.equal(await verdict([ci(job(2, 21)), ci({ app: 2222, suite: 9, conclusion: 'failure', ...early })]), 'ci fail');
  // A later ci.yml run for ANOTHER head never supersedes; its failure blocks, its pass never rescues.
  assert.equal(await verdict([ci(job(2, 21)), ci({ ...job(3, 31), conclusion: 'failure' })]), 'ci fail');
  assert.equal(await verdict([ci({ ...job(2, 21), conclusion: 'failure' }), ci(job(3, 31))]), 'ci fail');
  // A same-name commit status that isn't success blocks.
  assert.equal(await verdict([ci(job(2, 21))], [{ context: 'ci', state: 'failure', createdAt: iso(T - 60_000) }]), 'ci fail');
});

test('main watch (#727): an Actions-App pin never lets one workflow file supersede another; a failed re-run of an older run blocks', async () => {
  const repo = 'example-org/example-shop';
  const page = (run: number) => `https://github.com/${repo}/actions/runs/${run}`;
  const job = (suite: number, id: number) => ({ app: 15368, suite, id, url: `${page(suite * 100)}/job/${id}` });
  const verdict = async (o: { github: Record<string, number>; config: string; files: Record<string, string>; runs: CheckRunAt[] }) => {
    const s = await started({ pins: { sources: () => ({}), github: async () => o.github, repo }, config: o.config });
    const m = s.w.mergedPr();
    s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
    s.gh.roles.set('example-collaborator', 'writer');
    s.gh.runs.set(m.head, o.runs);
    s.gh.sources.set(m.head, Object.fromEntries(Object.entries(o.files).map(([suite, path]) => [suite, { run: Number(suite) * 100, url: page(Number(suite) * 100), path, repo, sha: m.head }])));
    await run(s.gh, s.watch, 8);
    // Round 6: the watch itself asked for the workflow runs (it used to under a workflow pin only, so under an
    // Actions-App pin every run was its own group and these cases passed for the wrong reason).
    assert.ok(s.gh.calls.some((c) => c.what.startsWith('sources ')), 'the watch read the workflow runs behind the Actions suites');
    return s.unaccounted[0]?.reason.replace(/^.*: /, '') ?? (s.checked.length ? 'accounted' : 'none');
  };
  // GitHub's rules pin `ci` to the Actions App; ci.yml is suite 1 (run 100), a PR-added evil.yml suite 2 (run 200).
  const app = { github: { ci: 15368 }, config: 'required_checks: [ci]\n', files: { '1': '.github/workflows/ci.yml', '2': '.github/workflows/evil.yml' } };
  assert.equal(await verdict({ ...app, runs: [ci({ ...job(1, 11), conclusion: 'failure' }), ci(job(2, 21))] }), 'ci fail');
  assert.equal(await verdict({ ...app, runs: [ci({ ...job(1, 11), status: 'in_progress', conclusion: null, completedAt: null }), ci(job(2, 21))] }), 'ci pending');
  assert.equal(await verdict({ ...app, runs: [ci(job(1, 11)), ci(job(2, 21))] }), 'accounted');
  // A workflow pin: run 200 passed (check run 21), then run 100 was re-run and its newest attempt (check run 31) failed.
  const wf = { github: {}, config: 'required_checks: [ci]\nrequired_check_sources:\n  ci: { workflow: .github/workflows/ci.yml }\n', files: { '1': '.github/workflows/ci.yml', '2': '.github/workflows/ci.yml' } };
  assert.equal(await verdict({ ...wf, runs: [ci(job(2, 21)), ci({ ...job(1, 31), conclusion: 'failure' })] }), 'ci fail');
  assert.equal(await verdict({ ...wf, runs: [ci({ ...job(1, 11), conclusion: 'cancelled' }), ci(job(2, 21))] }), 'accounted', "the owner's case 1 stays");
});

test("main watch (#727): while GitHub's rules have never answered, a merge waits to be judged: never by name, never unaccounted", async () => {
  let rules: Record<string, number> | null = null;
  const s = await started({ pins: { sources: () => ({}), github: async () => rules, repo: 'example-org/example-shop' }, config: 'required_checks: [ci]\n' });
  const m = s.w.mergedPr();
  s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(m.head, [ci({ app: 2222, suite: 1 })]);
  await run(s.gh, s.watch, 8);
  assert.deepEqual([s.checked, s.unaccounted], [[], []], 'not judged yet');
  rules = { ci: 1111 };
  await run(s.gh, s.watch, 8);
  assert.match(s.unaccounted[0]?.reason ?? '', /: ci missing$/, "judged once GitHub answers: its App pin applies");
});

test("main watch (#727): while GitHub's rules have never answered, a direct push and a bot's merge are still unaccounted, as on main", async () => {
  const pins = { sources: () => ({}), github: async () => null, repo: 'example-org/example-shop' };
  const d = await started({ pins, config: 'required_checks: [ci]\n' });
  const sha = d.w.directPush();
  await run(d.gh, d.watch, 8);
  assert.equal(d.unaccounted.length, 1, 'the direct push');
  assert.equal(d.unaccounted[0]!.sha, sha);
  assert.match(d.unaccounted[0]!.reason, /pushed to main directly/);

  const b = await started({ pins, config: 'required_checks: [ci]\n' });
  const m = b.w.mergedPr();
  b.gh.pr(7, m.merge, m.head, iso(T), 'example-bot[bot]', true);
  b.gh.runs.set(m.head, [ci({ app: 1111, suite: 1 })]);
  await run(b.gh, b.watch, 8);
  assert.match(b.unaccounted[0]?.reason ?? '', /merged into main by a bot/);
});

test('main watch (#727): with no pin recorded and none named by GitHub, a check is judged by name, exactly as before pins', async () => {
  const pins = { sources: () => ({}), github: async () => ({}), repo: 'example-org/example-shop' };
  const judged = async (withPins: boolean, runs: CheckRunAt[], statuses: StatusAt[] = []) => {
    const s = await started({ ...(withPins ? { pins } : {}), config: 'required_checks: [ci, deploy]\n' });
    const m = s.w.mergedPr();
    s.gh.pr(9, m.merge, m.head, iso(T), 'example-collaborator');
    s.gh.roles.set('example-collaborator', 'writer');
    s.gh.runs.set(m.head, runs);
    s.gh.statuses.set(m.head, statuses);
    await run(s.gh, s.watch, 8);
    return { unaccounted: s.unaccounted.map((u) => u.reason.replace(/\b[0-9a-f]{8}\b/g, '<sha>')), checked: s.checked.length };
  };
  const deploy = [{ context: 'deploy', state: 'success', createdAt: iso(T - 60_000) }];
  for (const [runs, statuses] of [[[ci({ app: 1111, suite: 1 })], deploy], [[ci({ app: 2222, suite: 2, conclusion: 'failure' })], deploy], [[ci()], []]] as [CheckRunAt[], StatusAt[]][]) {
    assert.deepEqual(await judged(true, runs, statuses), await judged(false, runs, statuses));
  }
  assert.deepEqual(await judged(true, [ci({ app: 1111, suite: 1 })], deploy), { unaccounted: [], checked: 1 }, 'accounted, as on main');
});

test('main watch: with no config.yaml readable at the first parent, the startup config judges, and the reason says so', async () => {
  for (const [label, config] of [
    ['absent', undefined],
    ['not YAML', 'required_checks: [ci\n'],
    ['invalid required_checks', 'required_checks: 3\n'],
  ] as const) {
    const s = await started({ required: ['ci', 'test (macos-latest)'], ...(config === undefined ? {} : { config }) });
    const m = s.w.mergedPr();
    s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
    s.gh.roles.set('example-collaborator', 'writer');
    s.gh.runs.set(m.head, [ci()]);
    await run(s.gh, s.watch, 7);
    assert.equal(s.unaccounted.length, 1, label);
    assert.match(s.unaccounted[0]!.reason, /test \(macos-latest\) missing/, label);
    assert.match(s.unaccounted[0]!.reason, /judged by the required_checks loaded at startup: .*config\.yaml/, label);
  }
});

test('main watch: a direct push is unaccounted (with a revert) once its commit-to-PR link stayed empty for LINK_LAG_MS, a call a minute', async () => {
  const s = await started();
  const before = s.gh.calls.length;
  const sha = s.w.directPush();
  await run(s.gh, s.watch, 1);
  assert.equal(s.unaccounted.length, 0, 'not on the first empty answer: the link may just lag');
  await run(s.gh, s.watch, 3);
  assert.equal(s.unaccounted.length, 1);
  assert.equal(s.unaccounted[0]!.sha, sha);
  assert.equal(s.unaccounted[0]!.revert, true, 'a revert PR is asked for');
  assert.match(s.unaccounted[0]!.reason, /was pushed to main directly: no merged PR has it/);
  const asked = s.gh.calls.slice(before);
  assert.deepEqual(asked.map((c) => c.what), Array(1 + LINK_LAG_MS / MAIN_WATCH_CALL_MS).fill(`pulls ${sha.slice(0, 7)}`), 'only the link, asked until LINK_LAG_MS after its first answer');
  assert.equal(asked.at(-1)!.at - asked[0]!.at, LINK_LAG_MS);
  assert.deepEqual(s.checked, []);
});

test('regression: a squash merge whose commit-to-PR link lags is accounted once GitHub links it, never a direct push', async () => {
  // A squash merge has one parent and a subject GitHub doesn't own ("Title (#N)"), so no merge subject names the PR;
  // judged on the first empty answer, it was a direct push and got a revert PR.
  const s = await started();
  const sha = s.w.directPush(); // a squash merge is one commit on main, like a push
  s.gh.prs.set(41, { number: 41, url: 'https://github.com/example-org/example-shop/pull/41', mergedAt: iso(T), mergeCommit: sha, mergedBy: 'example-collaborator', mergedByBot: false, head: 'f'.repeat(40), base: 'main' });
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set('f'.repeat(40), [ci()]);
  await run(s.gh, s.watch, 1); // the link is still empty
  assert.equal(s.gh.calls.filter((c) => c.what === `pulls ${sha.slice(0, 7)}`).length, 1);
  s.gh.pulls.set(sha, [s.gh.prs.get(41)!]); // GitHub links it a few seconds later
  await run(s.gh, s.watch, 6);
  assert.deepEqual(s.unaccounted, [], 'no revert PR for a normal squash merge');
  assert.deepEqual(s.checked, [{ sha, how: 'person', number: 41 }]);
});

test('regression: a commit inside a rebase merge is the PR\'s by GitHub\'s compare; an earlier direct push the PR\'s merge descends from is not', async () => {
  // Git ancestry said both were "in" the PR's merge: every earlier commit on main is an ancestor of a later merge.
  const s = await started();
  const pushed = s.w.directPush(); // a direct push, before the PR merged
  const r1 = s.w.directPush(); // the PR's two commits, rebased onto main
  const r2 = s.w.directPush();
  const pr = { number: 42, url: 'https://github.com/example-org/example-shop/pull/42', mergedAt: iso(T), mergeCommit: r2, mergedBy: 'example-collaborator', mergedByBot: false, head: 'e'.repeat(40), base: 'main', commits: 2 };
  s.gh.prs.set(42, pr);
  for (const c of [pushed, r1, r2]) s.gh.pulls.set(c, [pr]); // GitHub's link lists the PR for the pushed commit too (its branch had it)
  s.gh.compares.set(`${pushed}...${r2}`, { status: 'ahead', aheadBy: 2, behindBy: 0 });
  s.gh.compares.set(`${r1}...${r2}`, { status: 'ahead', aheadBy: 1, behindBy: 0 });
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set('e'.repeat(40), [ci()]);
  await run(s.gh, s.watch, 20);
  assert.deepEqual(s.unaccounted.map((u) => u.sha), [pushed], 'the push before the PR merged is a direct push');
  assert.match(s.unaccounted[0]!.reason, /#42's merge .* doesn't include it: 2 commit\(s\) ahead of it, and the PR has 2/);
  assert.deepEqual(s.checked.map((c) => [c.sha, c.number]), [[r1, 42], [r2, 42]], 'both rebased commits are the PR\'s');
});

test('regression: a merge commit GitHub has not linked to its PR yet is judged by the PR its subject names, never as a direct push', async () => {
  // Main 09f60340 (#307's merge) was judged 6 s after it landed: GitHub's commit-to-PR link was still empty, and the
  // watch opened a revert PR for a normal merge. The PR the merge subject names answers at once.
  const s = await started();
  const m = s.w.mergedPr();
  const n = Number(/#(\d+)/.exec(git(s.w.remote, 'log', '-1', '--format=%s', m.merge))?.[1] ?? 'NaN');
  s.gh.pr(n, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.pulls.delete(m.merge); // the link lags: no merged PR for the commit yet
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(m.head, [ci()]);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.unaccounted, [], 'no revert PR for a normal merge');
  assert.deepEqual(s.checked, [{ sha: m.merge, how: 'person', number: n }]);
});

test('a made-up merge subject is still a direct push: the named PR\'s own merge commit is another', async () => {
  const s = await started();
  const real = s.w.mergedPr();
  const n = Number(/#(\d+)/.exec(git(s.w.remote, 'log', '-1', '--format=%s', real.merge))?.[1] ?? 'NaN');
  s.gh.pr(n, real.merge, real.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  s.gh.runs.set(real.head, [ci()]);
  await run(s.gh, s.watch, 6);
  const fake = s.w.mergedPr(); // a second merge commit, which no PR has; its subject names another number
  s.gh.prs.set(Number(/#(\d+)/.exec(git(s.w.remote, 'log', '-1', '--format=%s', fake.merge))?.[1] ?? 'NaN'), { ...s.gh.prs.get(n)!, number: Number(/#(\d+)/.exec(git(s.w.remote, 'log', '-1', '--format=%s', fake.merge))?.[1]) });
  await run(s.gh, s.watch, 6);
  assert.equal(s.unaccounted.length, 1);
  assert.equal(s.unaccounted[0]!.sha, fake.merge);
  assert.match(s.unaccounted[0]!.reason, /pushed to main directly/);
});

test('subjectPrNumber reads this repo\'s and GitHub\'s merge subjects, nothing else', () => {
  assert.equal(subjectPrNumber('Merge #307: Tests: example repos run no background git maintenance'), 307);
  assert.equal(subjectPrNumber('Merge pull request #12 from someone/branch'), 12);
  assert.equal(subjectPrNumber('Fix #307 in the merge flow'), null);
  assert.equal(subjectPrNumber('Merge branch main into feature'), null);
});

test('main watch: a PR merged with a failing, pending or missing required check is unaccounted', async () => {
  for (const [label, runs, re] of [
    ['failing', [ci({ conclusion: 'failure' })], /ci fail/],
    ['still running when merged', [ci({ status: 'in_progress', completedAt: null })], /ci pending/],
    ['green only after the merge', [ci({ completedAt: iso(T + 60_000) })], /ci pending/],
    ['missing', [], /ci missing/],
  ] as const) {
    const s = await started();
    const m = s.w.mergedPr();
    s.gh.pr(8, m.merge, m.head, iso(T), 'example-owner');
    s.gh.roles.set('example-owner', 'owner');
    s.gh.runs.set(m.head, [...runs]);
    await run(s.gh, s.watch, 7);
    assert.equal(s.unaccounted.length, 1, label);
    assert.match(s.unaccounted[0]!.reason, /#8 was merged into main with required checks not green/, label);
    assert.match(s.unaccounted[0]!.reason, re, label);
    assert.deepEqual(s.checked, [], label);
  }
});

test('main watch: a merge by an unknown actor, an unmapped person or a bot is unaccounted', async () => {
  for (const [label, by, role, bot, re] of [
    ['no merger', null, null, false, /by an unknown actor/],
    ['unmapped', 'someone-else', null, false, /isn't a mapped admin or writer/],
    ['a viewer', 'someone-else', 'viewer', false, /isn't a mapped admin or writer/],
    ['a bot', 'automerge[bot]', null, true, /by a bot/],
  ] as const) {
    const s = await started();
    const m = s.w.mergedPr();
    s.gh.pr(9, m.merge, m.head, iso(T), by, bot);
    if (by) s.gh.roles.set(by, role);
    s.gh.runs.set(m.head, [ci()]);
    await run(s.gh, s.watch, 7);
    assert.equal(s.unaccounted.length, 1, label);
    assert.match(s.unaccounted[0]!.reason, re, label);
  }
});

test("main watch: the harness's own merge with green checks passes, without asking who merged it", async () => {
  const harness = new Map<string, { number: number; head: string; at: string }>();
  const s = await started({ harness });
  const m = s.w.mergedPr();
  harness.set(m.merge, { number: 11, head: m.head, at: iso(T) });
  s.gh.runs.set(m.head, [ci()]);
  const before = s.gh.calls.length;
  await run(s.gh, s.watch, 3);
  assert.deepEqual(s.checked, [{ sha: m.merge, how: 'harness', number: 11 }]);
  assert.equal(s.unaccounted.length, 0);
  assert.deepEqual(s.gh.calls.slice(before).map((c) => c.what), [`runs ${m.head.slice(0, 7)}`]);
  // Not green on the head it merged: unaccounted, whoever merged it.
  const r = s.w.mergedPr();
  harness.set(r.merge, { number: 12, head: r.head, at: iso(T) });
  s.gh.runs.set(r.head, [ci({ conclusion: 'failure' })]);
  await run(s.gh, s.watch, 3);
  assert.match((s.unaccounted as { reason: string }[])[0]?.reason ?? '', /the harness merged #12 into main with required checks not green/);
});

test('main watch: at most one API call a minute, across many commits and a restart', async () => {
  const s = await started();
  for (let i = 0; i < 3; i++) {
    const m = s.w.mergedPr();
    s.gh.pr(20 + i, m.merge, m.head, iso(T), 'example-collaborator');
    s.gh.runs.set(m.head, [ci({ name: 'other' })]); // not the required check: the statuses are read too
  }
  s.gh.roles.set('example-collaborator', 'writer');
  s.w.directPush();
  await run(s.gh, s.watch, 9);
  // A restart in the middle: a new watch on the same state file.
  const again = watcher(s.w, s.gh);
  await run(s.gh, again.watch, 20);
  const at = s.gh.calls.map((c) => c.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= MAIN_WATCH_CALL_MS, `calls ${i - 1} and ${i} are ${(at[i]! - at[i - 1]!) / 1000} s apart`);
  assert.equal(s.unaccounted.length + again.unaccounted.length, 4, 'every commit was judged: 3 PRs missing ci, and the push');
});

test('main watch: a restart neither checks a commit again nor skips one', async () => {
  const s = await started();
  const a = s.w.directPush();
  await run(s.gh, s.watch, 4);
  assert.deepEqual(s.unaccounted.map((u) => u.sha), [a]);
  const askedA = s.gh.calls.filter((x) => x.what === `pulls ${a.slice(0, 7)}`).length;
  const b = s.w.mergedPr();
  const c = s.w.directPush();
  s.gh.pr(30, b.merge, b.head, iso(T), 'example-owner');
  s.gh.roles.set('example-owner', 'owner');
  s.gh.runs.set(b.head, [ci()]);
  await run(s.gh, s.watch, 2); // part-way through b
  const again = watcher(s.w, s.gh);
  await run(s.gh, again.watch, 10);
  assert.deepEqual(again.checked.map((x) => x.sha), [b.merge], 'b, once');
  assert.deepEqual(again.unaccounted.map((u) => u.sha), [c], 'c, and not a again');
  assert.equal(s.gh.calls.filter((x) => x.what === `pulls ${a.slice(0, 7)}`).length, askedA, 'a was not asked about again');
  assert.equal(readWatchState(s.w.stateFile).last, c);
});

test('main watch trips: one pass\'s unaccounted commits with one reason are one trip, each judged; a direct push in it is its own trip; a restart keeps the trip', async () => {
  const s = await started({ config: 'required_checks: [ci]\nmain_watch:\n  revert_prs_per_trip: 2\n' });
  // One fetch sees them all: PR #42 rebased onto main as two commits, its required check never run, then a direct push.
  const r1 = s.w.directPush();
  const r2 = s.w.directPush();
  const pushed = s.w.directPush();
  const pr = { number: 42, url: 'https://github.com/example-org/example-shop/pull/42', mergedAt: iso(T), mergeCommit: r2, mergedBy: 'example-owner', mergedByBot: false, head: 'e'.repeat(40), base: 'main', commits: 2 };
  s.gh.prs.set(42, pr);
  for (const c of [r1, r2]) s.gh.pulls.set(c, [pr]);
  s.gh.compares.set(`${r1}...${r2}`, { status: 'ahead', aheadBy: 1, behindBy: 0 });
  s.gh.roles.set('example-owner', 'owner');
  for (let i = 0; i < 20 && !s.unaccounted.length; i++) await run(s.gh, s.watch, 1);
  // A restart in the middle of the pass: a new watch on the same state file.
  const again = watcher(s.w, s.gh);
  await run(s.gh, again.watch, 20);
  const all = [...s.unaccounted, ...again.unaccounted];
  assert.deepEqual(all.map((u) => u.sha), [r1, r2, pushed], 'every commit judged, each once');
  assert.ok(all.every((u) => u.revert), 'each asks for its revert: only the coordinator caps them');
  assert.match(all[0]!.reason, /#42 was merged .*ci missing/);
  assert.equal(all[0]!.trip?.id, all[1]!.trip?.id, "the rebased PR's two commits are one trip, across the restart");
  assert.notEqual(all[2]!.trip?.id, all[0]!.trip?.id, 'the direct push in the same pass is a trip of its own');
  assert.deepEqual([all[0]!.trip?.perTrip, all[0]!.trip?.perDay], [2, 3], 'caps as committed before the pass');
  assert.notEqual(tripOf({ from: r1, tip: pushed }, all[0]!.reason), all[0]!.trip?.id, 'another pass, another trip');
});

test('revertCapsAt: the config at a commit, or the defaults when it is missing, not valid, or asks for no revert PR at all', () => {
  const at = (text: string | null) => revertCapsAt({ show: () => text } as unknown as WatchGit, 'x');
  assert.deepEqual(at('main_watch:\n  revert_prs_per_trip: 2\n  revert_prs_per_day: 5\n'), { perTrip: 2, perDay: 5 });
  assert.deepEqual(at(null), { perTrip: 1, perDay: 3 });
  assert.deepEqual(at('main_watch: [\n'), { perTrip: 1, perDay: 3 });
  assert.deepEqual(at('main_watch:\n  revert_prs_per_trip: 0\n'), { perTrip: 1, perDay: 3 }, 'a cap of 0 is not valid');
});

/** A PR merged by an admin whose head has `runs`. */
function mergeWith(s: Awaited<ReturnType<typeof started>>, n: number, runs: CheckRunAt[]) {
  const m = s.w.mergedPr();
  s.gh.pr(n, m.merge, m.head, iso(T), 'example-owner');
  s.gh.roles.set('example-owner', 'owner');
  s.gh.runs.set(m.head, runs);
}

/** config.yaml committed on main with `text` (a direct push). */
function commitConfig(s: Awaited<ReturnType<typeof started>>, text: string) {
  const person = join(s.w.base, 'person');
  writeFileSync(join(person, CONFIG_PATH), text);
  git(person, 'add', CONFIG_PATH);
  git(person, ...ident, 'commit', '-q', '-m', 'config');
  git(person, 'push', '-q', 'origin', 'main');
}

test('main watch dead check: a required check with no run on any commit judged for dead_check_days is raised once, shown, and cleared when a run appears', async () => {
  const s = await started();
  const merged = (n: number, runs: CheckRunAt[]) => mergeWith(s, n, runs);
  merged(8, []);
  await run(s.gh, s.watch, 7);
  assert.equal(s.unaccounted.length, 1);
  assert.equal(s.dead.length, 0, 'one commit without a run is not a dead check yet');
  s.gh.g.now += DEAD_CHECK_MS;
  await run(s.gh, s.watch, 1);
  assert.deepEqual(s.dead.map((d) => [d.check, d.state]), [['ci', 'raised']]);
  assert.deepEqual(protectionView(s.w.stateFile, 'o/r').deadChecks.map((d) => d.check), ['ci'], 'on the dashboard');
  merged(9, []);
  await run(s.gh, s.watch, 7);
  assert.equal(s.unaccounted.length, 2, 'still judged, still unaccounted');
  assert.equal(s.dead.length, 1, 'raised once');
  merged(10, [ci({ conclusion: 'failure' })]); // a run, even a failing one: the check posts again
  await run(s.gh, s.watch, 7);
  assert.equal(s.unaccounted.length, 3);
  assert.deepEqual(s.dead.map((d) => d.state), ['raised', 'cleared']);
  assert.deepEqual(protectionView(s.w.stateFile, 'o/r').deadChecks, []);
});

test('regression: a dead check dropped from the committed required_checks is cleared, though the startup config still lists it', async () => {
  const s = await started({ required: ['ci'], config: 'required_checks: [ci]\n' });
  mergeWith(s, 8, []);
  await run(s.gh, s.watch, 7);
  s.gh.g.now += DEAD_CHECK_MS;
  await run(s.gh, s.watch, 1);
  assert.deepEqual(s.dead.map((d) => [d.check, d.state]), [['ci', 'raised']]);
  // main drops ci (and requires lint): the next merge is judged by that, and so are the dead checks.
  commitConfig(s, 'required_checks: [lint]\n');
  await run(s.gh, s.watch, 5);
  mergeWith(s, 9, [ci({ name: 'lint' })]);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.checked.map((c) => c.number), [9], 'judged by the committed lint');
  assert.deepEqual(s.dead.map((d) => [d.check, d.state]), [['ci', 'raised'], ['ci', 'cleared']]);
  assert.deepEqual(protectionView(s.w.stateFile, 'o/r').deadChecks, []);
  assert.deepEqual(readWatchState(s.w.stateFile).dead, {});
});

test('regression: a check only the committed required_checks list, that never posts, is raised as dead', async () => {
  // The startup config doesn't know lint; main's config.yaml requires it, so every merge trips on it.
  const s = await started({ required: ['ci'], config: 'required_checks: [ci, lint]\n' });
  mergeWith(s, 8, [ci()]);
  await run(s.gh, s.watch, 7);
  assert.match(s.unaccounted[0]?.reason ?? '', /lint missing/);
  s.gh.g.now += DEAD_CHECK_MS;
  await run(s.gh, s.watch, 1);
  assert.deepEqual(s.dead.map((d) => [d.check, d.state]), [['lint', 'raised']]);
  assert.deepEqual(protectionView(s.w.stateFile, 'o/r').deadChecks.map((d) => d.check), ['lint']);
});

const TESTS_YML = 'name: Tests\non: push\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
const disabledTests: WorkflowAt = { name: 'Tests', path: '.github/workflows/tests.yml', state: 'disabled_manually' };
/** What each unaccounted commit was: its PR, whether it gets a revert, and whether its reason is the missing ci. */
const tripped = (s: Awaited<ReturnType<typeof started>>) => s.unaccounted.map((u) => [u.number, u.revert, /required checks not green on \w+ at merge time: ci missing\b/.test(u.reason)]);

test('main watch dead check: when the workflow that would post the check is disabled, the warning says so, from one read of the workflows kept for the dead window', async () => {
  const s = await started({ files: { '.github/workflows/tests.yml': TESTS_YML } });
  s.gh.g.workflows = [{ name: 'Docs', path: '.github/workflows/docs.yml', state: 'disabled_inactivity' }, disabledTests];
  const reads = () => s.gh.calls.filter((c) => c.what === 'workflows').length;
  mergeWith(s, 8, []);
  await run(s.gh, s.watch, 7);
  assert.equal(reads(), 0, 'no read before a check is dead');
  s.gh.g.now += DEAD_CHECK_MS;
  await run(s.gh, s.watch, 1);
  assert.deepEqual(s.dead.map((d) => [d.check, d.state, d.workflow]), [['ci', 'raised', disabledTests]], 'the job "ci" in tests.yml posts it; docs.yml posts nothing of it');
  assert.deepEqual(protectionView(s.w.stateFile, 'o/r').deadChecks.map((d) => [d.check, d.workflow]), [['ci', disabledTests]], 'on the dashboard');
  assert.equal(reads(), 1);
  // Judging and the stop as without it: the next merge without its check is still judged, and unaccounted.
  mergeWith(s, 9, []);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(tripped(s), [[8, true, true], [9, true, true]]);
  assert.equal(s.dead.length, 1, 'raised once');
  assert.equal(reads(), 1, 'read once in the dead window');
  // A dead window on, read once more for the dashboard: enabled again, the note goes; no second warning.
  s.gh.g.workflows = [{ ...disabledTests, state: 'active' }];
  s.gh.g.now += DEAD_CHECK_MS;
  await run(s.gh, s.watch, 1);
  assert.equal(reads(), 2);
  assert.equal(s.dead.length, 1);
  assert.deepEqual(protectionView(s.w.stateFile, 'o/r').deadChecks, [{ check: 'ci', since: s.dead[0]!.since }]);
});

test('main watch dead check: a workflows read answering 403 or 404, or failing, adds nothing: the warning, judging and the stop are as without it', async () => {
  for (const answer of [null, 'throw'] as const) {
    const s = await started({ files: { '.github/workflows/tests.yml': TESTS_YML } });
    s.gh.g.workflows = answer;
    mergeWith(s, 8, []);
    await run(s.gh, s.watch, 7);
    s.gh.g.now += DEAD_CHECK_MS;
    await run(s.gh, s.watch, 1);
    const since = s.dead[0]?.since ?? '';
    assert.deepEqual(s.dead, [{ check: 'ci', since, state: 'raised' }], `${answer}: raised in the same pass, with no note`);
    assert.deepEqual(protectionView(s.w.stateFile, 'o/r').deadChecks, [{ check: 'ci', since }]);
    mergeWith(s, 9, []);
    await run(s.gh, s.watch, 7);
    assert.deepEqual(tripped(s), [[8, true, true], [9, true, true]], `${answer}: judged and stopped as before`);
    assert.equal(s.gh.calls.filter((c) => c.what === 'workflows').length, 1, `${answer}: not asked again`);
  }
  // The API: 403 and 404 are null, any other error throws (the watch catches it); GitHub's list is read by name, path and state.
  const answer = { status: 200, body: '' };
  const urls: string[] = [];
  const f = (async (url: string) => (urls.push(url), new Response(answer.body, { status: answer.status }))) as unknown as typeof fetch;
  const api = new GitHubMainWatchApi('x/y', async () => 't', f);
  for (const status of [403, 404]) {
    Object.assign(answer, { status, body: '{"message":"Resource not accessible by integration"}' });
    assert.equal(await api.workflows(), null, String(status));
  }
  Object.assign(answer, { status: 500, body: '{}' });
  await assert.rejects(api.workflows(), /GitHub 500 reading the Actions workflows/);
  // The shape GitHub answers (measured: GET /repos/{o}/{r}/actions/workflows), state one of its REST description's enum.
  const listed = [
    { id: 1, node_id: 'W_1', name: 'Tests', path: '.github/workflows/tests.yml', state: 'disabled_manually', created_at: iso(T), updated_at: iso(T), url: 'https://api.github.com/repos/x/y/actions/workflows/1', html_url: 'https://github.com/x/y/blob/main/.github/workflows/tests.yml', badge_url: 'https://github.com/x/y/workflows/Tests/badge.svg' },
    { id: 2, node_id: 'W_2', name: 'Docs', path: '.github/workflows/docs.yml', state: 'active' },
    { id: 3, name: 7, path: null, state: 'active' },
  ];
  Object.assign(answer, { status: 200, body: JSON.stringify({ total_count: 3, workflows: listed }) });
  assert.deepEqual(await api.workflows(), [disabledTests, { name: 'Docs', path: '.github/workflows/docs.yml', state: 'active' }]);
  assert.ok(urls.every((u) => u === 'https://api.github.com/repos/x/y/actions/workflows?per_page=100'), urls.join(' '));
});

test('disabledWorkflowFor: a disabled workflow named as the check, a file named so, or one with a job that posts it; nothing for an active one', () => {
  const files: Record<string, string> = {
    '.github/workflows/ci.yml': 'name: CI\njobs:\n  test:\n    name: test (ubuntu-latest, 22)\n  shard:\n    name: test shard ${{ matrix.shard }}/4 (${{ matrix.os }})\n  desktop:\n    runs-on: x\n  matrix:\n    strategy: {}\n',
    '.github/workflows/broken.yml': 'jobs: [\n',
  };
  const show = (p: string) => files[p] ?? null;
  const wf = (name: string, path: string, state = 'disabled_manually'): WorkflowAt => ({ name, path, state });
  const ciYml = wf('CI', '.github/workflows/ci.yml');
  const at = (check: string, list: WorkflowAt[]) => disabledWorkflowFor(check, list, show)?.name ?? null;
  assert.equal(at('test (ubuntu-latest, 22)', [ciYml]), 'CI', "a job's name");
  assert.equal(at('desktop', [ciYml]), 'CI', "a job's id, when it has no name");
  assert.equal(at('matrix (ubuntu-latest, 22)', [ciYml]), 'CI', "GitHub's matrix suffix");
  assert.equal(at('test shard 2/4 (ubuntu-latest)', [ciYml]), 'CI', 'a name with expressions');
  assert.equal(at('test shard 2/4 (ubuntu-latest); more', [ciYml]), null, 'only the text in their places');
  assert.equal(at('CI', [ciYml]), 'CI', "the workflow's name");
  assert.equal(at('scan', [wf('Secrets', '.github/workflows/scan.yaml', 'disabled_inactivity')]), 'Secrets', "the file's name");
  assert.equal(at('lint', [ciYml]), null, 'no job posts it');
  assert.equal(at('desktop', [{ ...ciYml, state: 'active' }]), null, 'active: nothing to say');
  assert.equal(at('lint', [wf('Broken', '.github/workflows/broken.yml')]), null, "a file that doesn't parse");
  const clipped = disabledWorkflowFor('CI', [wf('CI', `.github/workflows/a\n${'x'.repeat(300)}.yml`)], show);
  assert.equal(clipped?.path.length, 200);
  assert.doesNotMatch(clipped?.path ?? '\n', /\n/);
});

const disabled = (name: string, path: string): WorkflowAt => ({ name, path, state: 'disabled_manually' });

test('regression: a disabled workflow whose job name is only expressions is blamed for no check', () => {
  const files: Record<string, string> = {
    '.github/workflows/nightly.yml': 'jobs:\n  targets:\n    name: ${{ matrix.target }}\n',
    '.github/workflows/release.yml': 'jobs:\n  pair:\n    name: ${{ inputs.a }} ${{ inputs.b }}\n',
  };
  const show = (p: string) => files[p] ?? null;
  for (const check of ['ci', 'lint', 'unit tests']) {
    assert.equal(disabledWorkflowFor(check, [disabled('Nightly', '.github/workflows/nightly.yml'), disabled('Release', '.github/workflows/release.yml')], show), null, check);
  }
  // Nor does it hide the disabled workflow that does post it, further down the list.
  files['.github/workflows/ci.yml'] = 'jobs:\n  ci:\n    runs-on: x\n';
  assert.equal(disabledWorkflowFor('ci', [disabled('Nightly', '.github/workflows/nightly.yml'), disabled('CI', '.github/workflows/ci.yml')], show)?.name, 'CI');
});

test('regression: nothing is said when an active workflow would post the check too', () => {
  const files: Record<string, string> = {
    '.github/workflows/ci.yml': 'name: CI\non: pull_request\njobs:\n  build:\n    runs-on: x\n',
    '.github/workflows/nightly-build.yml': 'name: Nightly build\non: schedule\njobs:\n  build:\n    runs-on: x\n',
  };
  const show = (p: string) => files[p] ?? null;
  const nightly = disabled('Nightly build', '.github/workflows/nightly-build.yml');
  assert.equal(disabledWorkflowFor('build', [{ name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, nightly], show), null, 'ci.yml (active) posts build');
  assert.equal(disabledWorkflowFor('build', [nightly, { name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }], show), null, 'whatever the order');
  assert.equal(disabledWorkflowFor('build', [{ name: 'CI', path: '.github/workflows/ci.yml', state: 'disabled_inactivity' }, nightly], show)?.name, 'CI', 'both disabled: the first is named');
  assert.equal(disabledWorkflowFor('build', [{ name: 'Docs', path: '.github/workflows/docs.yml', state: 'active' }, nightly], show)?.name, 'Nightly build', 'an active one that posts something else');
});

test('regression: a workflow file over the size cap is not parsed', () => {
  const big = `jobs:\n  big:\n    runs-on: x\n${'# padding\n'.repeat(30_000)}`;
  assert.ok(big.length > 256 * 1024);
  assert.equal(disabledWorkflowFor('big', [disabled('Huge', '.github/workflows/huge.yml')], () => big), null);
  assert.equal(disabledWorkflowFor('big', [disabled('Huge', '.github/workflows/huge.yml')], () => big.slice(0, 1000))?.name, 'Huge', 'the same file, small');
});

test('regression: a job name with many expressions matches in linear time, not by backtracking', () => {
  const file = 'jobs:\n  j:\n    name: "${{ a }}${{ a }}${{ a }}${{ a }}${{ a }}X"\n';
  const list = [disabled('W', '.github/workflows/w.yml')];
  const t = performance.now();
  assert.equal(disabledWorkflowFor('a'.repeat(180), list, () => file), null);
  assert.ok(performance.now() - t < 150, `took ${Math.round(performance.now() - t)} ms`);
  assert.equal(disabledWorkflowFor(`${'a'.repeat(180)}X`, list, () => file)?.name, 'W', 'and still matches its expansion');
});

test('disabledWorkflowsOf: one read parses each workflow file once, and none when no workflow is disabled', () => {
  const shown: string[] = [];
  const files: Record<string, string> = { '.github/workflows/ci.yml': 'jobs:\n  ci:\n    runs-on: x\n', '.github/workflows/nightly.yml': 'jobs:\n  lint:\n    runs-on: x\n' };
  const show = (p: string) => (shown.push(p), files[p] ?? null);
  const active = [{ name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, { name: 'Nightly', path: '.github/workflows/nightly.yml', state: 'active' }];
  const none = disabledWorkflowsOf(active, show);
  assert.deepEqual([none('ci'), none('lint'), none('scan')], [null, null, null]);
  assert.deepEqual(shown, [], 'no disabled workflow: no file is read');
  const some = disabledWorkflowsOf([active[0]!, disabled('Nightly', '.github/workflows/nightly.yml')], show);
  assert.deepEqual([some('ci'), some('lint')?.name, some('scan'), some('lint')?.name], [null, 'Nightly', null, 'Nightly']);
  assert.deepEqual([...shown].sort(), ['.github/workflows/ci.yml', '.github/workflows/nightly.yml'], 'each file once');
});

test('regression: a disabled workflow\'s name and path lose C1 and bidi controls', () => {
  const w = disabledWorkflowFor('C\u0085I‮', [{ name: 'C\u0085I\u202e', path: '.github/workflows/\u2066ci\u2069.yml\u200f', state: 'disabled_manually' }], () => null);
  assert.deepEqual(w, { name: 'C I ', path: '.github/workflows/ ci .yml ', state: 'disabled_manually' });
});

test('regression: clipping a disabled workflow\'s name to 200 characters never keeps half an emoji', () => {
  const name = `x${'😀'.repeat(150)}`;
  const w = disabledWorkflowFor(name, [{ name, path: '.github/workflows/ci.yml', state: 'disabled_manually' }], () => null);
  assert.equal(w?.name, `x${'😀'.repeat(99)}`);
});

test('main watch: GitHub enforcing the protection leaves it to GitHub; a rewritten main is unaccounted, with no revert', async () => {
  const w = world();
  const gh = fakeGitHub();
  gh.g.protection = 'enforced';
  const s = watcher(w, gh);
  await run(gh, s.watch, 5);
  assert.deepEqual(s.modes.map((m) => m.mode), ['github']);
  assert.deepEqual(gh.calls.map((c) => c.what), ['protection'], 'nothing else is asked');
  const r = await started();
  r.w.directPush();
  await run(r.gh, r.watch, 2);
  // Someone force-pushes main back to before the checked commit.
  const person = join(r.w.base, 'person');
  git(person, 'reset', '-q', '--hard', 'HEAD~1');
  writeFileSync(join(person, 'x.txt'), 'x\n');
  git(person, 'add', '-A');
  git(person, ...ident, 'commit', '-q', '-m', 'rewritten');
  git(person, 'push', '-q', '--force', 'origin', 'main');
  await run(r.gh, r.watch, 1);
  const last = r.unaccounted.at(-1)!;
  assert.match(last.reason, /main was rewritten/);
  assert.equal(last.revert, false);
});

test('outcomesAt and judge: checks are read as they stood at merge time; no required checks judge nothing green', () => {
  const at = iso(T);
  assert.deepEqual(outcomesAt(['ci'], [ci(), ci({ startedAt: iso(T + 1000), completedAt: iso(T + 2000), conclusion: 'failure' })], null, at), [{ name: 'ci', outcome: 'pass' }], 'a rerun after the merge does not count');
  assert.deepEqual(outcomesAt(['ci'], [], null, at), [{ name: 'ci', outcome: 'unknown' }]);
  assert.deepEqual(outcomesAt(['ci'], [], [{ context: 'ci', state: 'success', createdAt: iso(T - 1000) }], at), [{ name: 'ci', outcome: 'pass' }]);
  assert.deepEqual(outcomesAt(['ci'], [], [{ context: 'ci', state: 'success', createdAt: iso(T + 1000) }], at), [{ name: 'ci', outcome: 'missing' }]);
  const v = judge('a'.repeat(40), { harness: { number: 3, head: 'b'.repeat(40), at } }, { branch: 'main', required: [] });
  assert.ok(v.done && !v.accounted);
});

// ---------------------------------------------------------------- bootstrap merges an admin accepted

/** An admin's accept, as the dashboard makes it: over the coordinator's clone, with the PRs judged already. */
const accept = (w: ReturnType<typeof world>, target: AcceptTarget, judgedPrs: number[] = [], reason = "bootstrap: the suite can't run yet") =>
  acceptMerge({ stateFile: w.stateFile, git: acceptGit(w.coord, 'origin', 'main'), branch: 'main', target, reason, by: 'example-owner', judgedPrs });

/** An open PR #n: a branch from main with one commit, its head at refs/pull/n/head as GitHub keeps it. */
function openPr(w: ReturnType<typeof world>, n: number) {
  const person = join(w.base, 'person');
  let k = 0;
  const push = () => {
    git(person, 'checkout', '-q', '-B', `pr${n}`, ...(k ? [`pr${n}`] : []));
    writeFileSync(join(person, `pr${n}-${++k}.txt`), `${n}.${k}\n`);
    git(person, 'add', '-A');
    git(person, ...ident, 'commit', '-q', '-m', `pr ${n} (${k})`);
    const head = git(person, 'rev-parse', 'HEAD');
    git(person, 'push', '-q', '-f', 'origin', `HEAD:refs/pull/${n}/head`);
    git(person, 'checkout', '-q', 'main');
    return head;
  };
  const p = { head: push(), push: () => (p.head = push()) };
  /** Merged with a merge commit (GitHub's merge button), or squashed. */
  const merge = (how: 'merge' | 'squash' = 'merge') => {
    if (how === 'merge') git(person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n}`, p.head);
    else {
      git(person, 'merge', '-q', '--squash', p.head);
      git(person, ...ident, 'commit', '-q', '-m', `PR ${n} (#${n})`);
    }
    git(person, 'push', '-q', 'origin', 'main');
    return git(person, 'rev-parse', 'HEAD');
  };
  return Object.assign(p, { merge });
}

test('main watch: a hand merge an admin accepted by its sha is accounted (no stop, alert or revert); the next one, not accepted, still trips', async () => {
  const s = await started();
  s.gh.roles.set('example-owner', 'owner');
  // The project's required check can't run yet: the admin's merge has it missing.
  const m = s.w.mergedPr();
  s.gh.pr(22, m.merge, m.head, iso(T), 'example-owner');
  const r = accept(s.w, { sha: m.merge.slice(0, 12) });
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.acceptance.sha, m.merge, 'kept as the full sha');
  await run(s.gh, s.watch, 7);
  assert.equal(s.unaccounted.length, 0, 'no stop, no alert, no revert PR');
  assert.deepEqual(s.accepted.map((x) => [x.sha, x.number, x.a.by, x.a.reason]), [[m.merge, null, 'example-owner', "bootstrap: the suite can't run yet"]]);
  assert.deepEqual(s.checked, []);
  assert.equal(readWatchState(s.w.stateFile).last, m.merge);
  assert.deepEqual(s.gh.calls.map((c) => c.what).filter((c) => c.includes(m.merge.slice(0, 7))), [], 'an accepted sha takes no API call');
  // The next hand merge, just like it but not accepted, trips as before.
  const n = s.w.mergedPr();
  s.gh.pr(23, n.merge, n.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.unaccounted.map((u) => [u.sha, u.revert]), [[n.merge, true]]);
  assert.match(s.unaccounted[0]!.reason, /#23 was merged into main with required checks not green.*ci missing/);
  // One being checked (the watch is part-way through it) can be accepted too.
  const p = s.w.mergedPr();
  s.gh.pr(24, p.merge, p.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 1);
  assert.equal(readWatchState(s.w.stateFile).pending?.sha, p.merge, 'being checked');
  assert.ok(accept(s.w, { sha: p.merge }).ok);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.accepted.map((x) => x.sha), [m.merge, p.merge]);
  assert.equal(s.unaccounted.length, 1);
});

test('main watch: a PR accepted by number before it merges is accounted when it merges at that head (merge or squash); pushed to after, it trips', async () => {
  const s = await started();
  s.gh.roles.set('example-owner', 'owner');
  // Accept, then merge: the owner's case.
  const a = openPr(s.w, 25);
  const r = accept(s.w, { pr: 25 });
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.equal(r.acceptance.head, a.head, "pinned to the PR's head now");
  const am = a.merge();
  s.gh.pr(25, am, a.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.equal(s.unaccounted.length, 0, 'no stop, no alert, no revert PR');
  assert.deepEqual(s.accepted.map((x) => [x.sha, x.number]), [[am, 25]]);
  // Squashed: the same.
  const b = openPr(s.w, 26);
  assert.ok(accept(s.w, { pr: 26 }).ok);
  const bm = b.merge('squash');
  s.gh.pr(26, bm, b.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.accepted.map((x) => [x.sha, x.number]), [[am, 25], [bm, 26]]);
  assert.equal(s.unaccounted.length, 0);
  // Accepted, then pushed to: the head merged isn't the one accepted, so it is judged as any merge.
  const c = openPr(s.w, 27);
  assert.ok(accept(s.w, { pr: 27 }).ok);
  c.push();
  const cm = c.merge();
  s.gh.pr(27, cm, c.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.unaccounted.map((u) => u.sha), [cm]);
  assert.match(s.unaccounted[0]!.reason, /#27 was merged into main with required checks not green/);
  assert.equal(s.accepted.length, 2);
});

test('main watch accept: a rewrite, a commit not on the branch, one already judged and one off the first-parent line are refused', async () => {
  const s = await started();
  s.gh.roles.set('example-owner', 'owner');
  const baseline = readWatchState(s.w.stateFile).last!;
  // Already judged: the last commit checked, and one before it.
  assert.match((accept(s.w, { sha: baseline }) as { error: string }).error, /judged already/);
  const g = s.w.mergedPr();
  s.gh.pr(30, g.merge, g.head, iso(T), 'example-owner');
  s.gh.runs.set(g.head, [ci()]);
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.checked.map((x) => x.sha), [g.merge]);
  for (const sha of [g.merge, baseline]) {
    const r = accept(s.w, { sha });
    assert.ok(!r.ok && r.status === 409 && /judged already/.test(r.error), `${sha.slice(0, 8)}: ${JSON.stringify(r)}`);
  }
  // A PR judged already, by the watch's events, or whose head is on the branch at or before the last checked.
  assert.match((accept(s.w, { pr: 30 }, [30]) as { error: string }).error, /#30's merge was judged already/);
  const person = join(s.w.base, 'person');
  git(person, 'push', '-q', 'origin', `${g.head}:refs/pull/30/head`);
  assert.match((accept(s.w, { pr: 30 }) as { error: string }).error, /on main already, at or before the last commit checked/);
  // Not on the branch: a commit on another branch, a sha nothing has, a PR the remote doesn't have.
  git(person, 'checkout', '-q', '-b', 'elsewhere');
  writeFileSync(join(person, 'e.txt'), 'e\n');
  git(person, 'add', '-A');
  git(person, ...ident, 'commit', '-q', '-m', 'elsewhere');
  const foreign = git(person, 'rev-parse', 'HEAD');
  git(person, 'push', '-q', 'origin', 'elsewhere');
  git(person, 'checkout', '-q', 'main');
  git(s.w.coord, 'fetch', '-q', 'origin');
  for (const sha of [foreign, 'f'.repeat(40)]) {
    const r = accept(s.w, { sha });
    assert.ok(!r.ok && r.status === 404 && /is not a commit on main/.test(r.error), `${sha.slice(0, 8)}: ${JSON.stringify(r)}`);
  }
  assert.match((accept(s.w, { pr: 999 }) as { error: string }).error, /no PR #999 on the remote/);
  // On the branch, but inside a merge: the watch judges the merge commit, so that is what is accepted.
  const h = s.w.mergedPr();
  const inside = accept(s.w, { sha: h.head });
  assert.ok(!inside.ok && /not on its first-parent line/.test(inside.error), JSON.stringify(inside));
  // No reason refused too; and the same thing twice.
  assert.match((accept(s.w, { sha: h.merge }, [], '  ') as { error: string }).error, /a reason is required/);
  assert.ok(accept(s.w, { sha: h.merge }).ok);
  assert.match((accept(s.w, { sha: h.merge }) as { error: string }).error, /accepted already/);
  s.gh.pr(32, h.merge, h.head, iso(T), 'example-owner');
  await run(s.gh, s.watch, 7);
  assert.deepEqual(s.accepted.map((x) => x.sha), [h.merge]);
  // A force-push: neither the rewritten tip nor a PR can be accepted while it waits to be judged.
  git(person, 'reset', '-q', '--hard', 'HEAD~1');
  writeFileSync(join(person, 'x.txt'), 'x\n');
  git(person, 'add', '-A');
  git(person, ...ident, 'commit', '-q', '-m', 'rewritten');
  git(person, 'push', '-q', '--force', 'origin', 'main');
  const rewritten = git(person, 'rev-parse', 'HEAD');
  openPr(s.w, 31);
  for (const target of [{ sha: rewritten }, { pr: 31 }] as AcceptTarget[]) {
    const r = accept(s.w, target);
    assert.ok(!r.ok && r.status === 409 && /was rewritten since the last commit checked .*: a force-push can't be accepted/.test(r.error), `${JSON.stringify(target)}: ${JSON.stringify(r)}`);
  }
  // And the rewrite still trips, with no revert.
  await run(s.gh, s.watch, 2);
  assert.match(s.unaccounted.at(-1)!.reason, /main was rewritten/);
  assert.equal(s.unaccounted.at(-1)!.revert, false);
  assert.equal(s.accepted.length, 1);
});

test('main watch accept: nothing to accept while GitHub guards the branch, or before the watch has a starting commit', async () => {
  const w = world();
  const gh = fakeGitHub();
  const s = watcher(w, gh);
  assert.match((accept(w, { pr: 1 }) as { error: string }).error, /isn't guarding main \(not started\)/);
  gh.g.protection = 'enforced';
  await run(gh, s.watch, 1);
  assert.match((accept(w, { pr: 1 }) as { error: string }).error, /isn't guarding main \(github\)/);
});

test('judge: an accepted sha is accounted at once; an accepted PR only at the head accepted', () => {
  const at = iso(T);
  const a: Acceptance = { id: 'x', sha: null, pr: 5, head: 'b'.repeat(40), base: 'c'.repeat(40), by: 'example-owner', reason: 'r', at };
  const o = { branch: 'main', required: ['ci'], accepted: [a, { ...a, id: 'y', sha: 'a'.repeat(40), pr: null, head: null }] };
  assert.deepEqual(judge('a'.repeat(40), { harness: null }, o), { done: true, accounted: true, how: 'accepted', number: null, acceptance: o.accepted[1] });
  const pr = (head: string): MergedPull => ({ number: 5, url: '', mergedAt: at, mergeCommit: 'd'.repeat(40), mergedBy: null, mergedByBot: false, head, base: 'main' });
  const f = (head: string) => ({ harness: null, pulls: [pr(head)], pr: pr(head) });
  const v = judge('d'.repeat(40), f('b'.repeat(40)), o);
  assert.ok(v.done && v.accounted && v.how === 'accepted' && v.number === 5);
  const w = judge('d'.repeat(40), f('e'.repeat(40)), o);
  assert.ok(w.done && !w.accounted, 'another head: judged as any merge');
  const h = judge('d'.repeat(40), { harness: { number: 5, head: 'b'.repeat(40), at } }, o);
  assert.ok(h.done && h.accounted && h.how === 'accepted', "the harness's own merge of it too");
});

test("GitHubMainWatchApi: compare reads GitHub's ahead/behind counts; a PR carries its commit count", async () => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (url.includes('/compare/')) return new Response(JSON.stringify({ status: 'ahead', ahead_by: 1, behind_by: 0, commits: [] }));
    return new Response(JSON.stringify({ number: 9, html_url: 'https://github.com/x/y/pull/9', merged_at: iso(T), merge_commit_sha: 'b'.repeat(40), merged_by: { login: 'example-owner', type: 'User' }, head: { sha: 'c'.repeat(40) }, base: { ref: 'main' }, commits: 3 }));
  }) as unknown as typeof fetch;
  const api = new GitHubMainWatchApi('x/y', async () => 't', f);
  assert.deepEqual(await api.compare('a'.repeat(40), 'b'.repeat(40)), { status: 'ahead', aheadBy: 1, behindBy: 0 });
  assert.ok(urls[0]!.endsWith(`/repos/x/y/compare/${'a'.repeat(40)}...${'b'.repeat(40)}?per_page=1`), urls[0]);
  assert.equal((await api.pull(9)).commits, 3);
});

// #727 round 6: readiness and the main watch judge a pinned check through one function (pinnedVerdict) over the same
// facts. One table, each case under a workflow pin, an Actions-App pin (GitHub's rules name 15368) and a pin to an App
// that isn't Actions: readiness through PinnedChecks.of over GitHubBacklog's real requests, the watch through its own
// request loop (it asks for each read itself, nothing handed in). Both must give the expected verdict.
type Job = { id: number; suite: number; app?: number; conclusion?: string; status?: string };
type Case = { what: string; jobs: Job[]; files?: Record<number, string>; statuses?: { context: string; state: string }[]; expect: 'pass' | 'fail' | 'pending' | 'missing' };
const AGREE_REPO = 'example-org/example-shop';
const OTHER_APP = 2222;
const NON_ACTIONS_APP = 1111;
const pageOf = (j: Job) => (j.app ?? ACTIONS_ID) === ACTIONS_ID ? `https://github.com/${AGREE_REPO}/actions/runs/${j.suite * 100}/job/${j.id}` : `https://github.example/${AGREE_REPO}/runs/${j.id}`;
const ACTIONS_ID = 15368;

/** Readiness's verdict for `ci` on `head`: GitHubBacklog's own requests over these answers (check runs as filter=latest lists them). */
async function readinessVerdict(c: Case, head: string, pin: { configured: Record<string, CheckPin>; github: Record<string, number> }): Promise<string> {
  const latest = new Map<number, Job>();
  for (const j of c.jobs) if (!latest.has(j.suite) || latest.get(j.suite)!.id < j.id) latest.set(j.suite, j);
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const f = (async (url: string) => {
    const path = url.replace('https://api.github.com', '');
    if (path.startsWith(`/repos/${AGREE_REPO}/commits/${head}/check-runs?filter=latest`)) {
      const runs = [...latest.values()].map((j) => ({ id: j.id, name: 'ci', status: j.status ?? 'completed', conclusion: (j.status ?? 'completed') === 'completed' ? (j.conclusion ?? 'success') : null, html_url: pageOf(j), app: { id: j.app ?? ACTIONS_ID }, check_suite: { id: j.suite } }));
      return answer({ total_count: runs.length, check_runs: runs });
    }
    if (path.startsWith(`/repos/${AGREE_REPO}/actions/runs?head_sha=${head}`)) {
      const runs = Object.entries(c.files ?? {}).map(([suite, file]) => ({ id: Number(suite) * 100, html_url: `https://github.com/${AGREE_REPO}/actions/runs/${Number(suite) * 100}`, check_suite_id: Number(suite), path: file, head_sha: head, repository: { full_name: AGREE_REPO } }));
      return answer({ total_count: runs.length, workflow_runs: runs });
    }
    if (path.startsWith(`/repos/${AGREE_REPO}/commits/${head}/status`)) return answer({ total_count: (c.statuses ?? []).length, statuses: c.statuses ?? [] });
    if (path === `/repos/${AGREE_REPO}/branches/main`) return answer({ name: 'main', protection: { enabled: false } });
    if (path.startsWith(`/repos/${AGREE_REPO}/rules/branches/main`)) return answer(Object.entries(pin.github).map(([context, id]) => ({ type: 'required_status_checks', parameters: { required_status_checks: [{ context, integration_id: id }] } })));
    return answer({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  const pinned = new PinnedChecks({ backlog: new GitHubBacklog(AGREE_REPO, () => 't', f), branch: () => 'main', repo: () => AGREE_REPO, configured: () => pin.configured });
  const out = readiness({ required: ['ci'], checks: await pinned.of(head), head, evaluated: { head, approved: true } }).checks[0]!.outcome;
  return out === 'pass' || out === 'pending' || out === 'missing' ? out : 'fail';
}

/** The main watch's verdict for `ci` on a merge whose PR head carries these runs, through its own request loop. */
async function watchVerdict(c: Case, pin: { config: string; github: Record<string, number> }): Promise<string> {
  const s = await started({ pins: { sources: () => ({}), github: async () => pin.github, repo: AGREE_REPO }, config: pin.config });
  const m = s.w.mergedPr();
  s.gh.pr(7, m.merge, m.head, iso(T), 'example-collaborator');
  s.gh.roles.set('example-collaborator', 'writer');
  // filter=all: every attempt, each started and finished before the merge, in id order.
  s.gh.runs.set(
    m.head,
    c.jobs.map((j) => ci({ id: j.id, suite: j.suite, app: j.app ?? ACTIONS_ID, url: pageOf(j), status: j.status ?? 'completed', conclusion: (j.status ?? 'completed') === 'completed' ? (j.conclusion ?? 'success') : null, startedAt: iso(T - (60 - j.id) * 60_000), completedAt: (j.status ?? 'completed') === 'completed' ? iso(T - (59 - j.id) * 60_000) : null })),
  );
  s.gh.sources.set(m.head, Object.fromEntries(Object.entries(c.files ?? {}).map(([suite, path]) => [suite, { run: Number(suite) * 100, url: `https://github.com/${AGREE_REPO}/actions/runs/${Number(suite) * 100}`, path, repo: AGREE_REPO, sha: m.head }])));
  s.gh.statuses.set(m.head, (c.statuses ?? []).map((x) => ({ ...x, createdAt: iso(T - 30 * 60_000) })));
  await run(s.gh, s.watch, 10);
  const why = s.unaccounted[0]?.reason;
  if (!why) return s.checked.length ? 'pass' : 'none';
  const hit = /: ci (\w+)$/.exec(why)?.[1];
  return hit ?? why;
}

test('readiness and the main watch agree on every pinned case, under a workflow pin, an Actions-App pin and a non-Actions App pin (#727 round 6)', async () => {
  const ciYml = '.github/workflows/ci.yml';
  const actions: Case[] = [
    { what: "owner 1: run 100 cancelled, then run 200 passed", jobs: [{ id: 10, suite: 1, conclusion: 'cancelled' }, { id: 20, suite: 2 }], files: { 1: ciYml, 2: ciYml }, expect: 'pass' },
    { what: 'owner 2: run 100 failed, then run 200 passed', jobs: [{ id: 10, suite: 1, conclusion: 'failure' }, { id: 20, suite: 2 }], files: { 1: ciYml, 2: ciYml }, expect: 'pass' },
    { what: "owner 3: the pinned pass, and another App's same-name failure", jobs: [{ id: 20, suite: 2 }, { id: 30, suite: 9, app: OTHER_APP, conclusion: 'failure' }], files: { 2: ciYml }, expect: 'fail' },
    { what: 'tightening: run 200 passed, then run 100 re-run and failed', jobs: [{ id: 10, suite: 1 }, { id: 20, suite: 2 }, { id: 30, suite: 1, conclusion: 'failure' }], files: { 1: ciYml, 2: ciYml }, expect: 'fail' },
    { what: 'a normal re-run: run 100 cancelled, run 200 failed then its re-run attempt passed', jobs: [{ id: 10, suite: 1, conclusion: 'cancelled' }, { id: 20, suite: 2, conclusion: 'failure' }, { id: 30, suite: 2 }], files: { 1: ciYml, 2: ciYml }, expect: 'pass' },
    { what: 'a re-run attempt of the latest run still running', jobs: [{ id: 20, suite: 2, conclusion: 'failure' }, { id: 30, suite: 2, status: 'in_progress' }], files: { 2: ciYml }, expect: 'pending' },
    { what: 'ci.yml failed, then a PR-added evil.yml passed later', jobs: [{ id: 10, suite: 1, conclusion: 'failure' }, { id: 20, suite: 3 }], files: { 1: ciYml, 3: '.github/workflows/evil.yml' }, expect: 'fail' },
    { what: "the pinned pass, and the name's failing commit status", jobs: [{ id: 20, suite: 2 }], files: { 2: ciYml }, statuses: [{ context: 'ci', state: 'failure' }], expect: 'fail' },
  ];
  const app: Case[] = [
    { what: 'owner 1 under a non-Actions App: suite 11 cancelled, suite 12 passed (no file to group by: fail closed)', jobs: [{ id: 10, suite: 11, app: NON_ACTIONS_APP, conclusion: 'cancelled' }, { id: 20, suite: 12, app: NON_ACTIONS_APP }], expect: 'fail' },
    { what: 'owner 2 under a non-Actions App: suite 11 failed, suite 12 passed', jobs: [{ id: 10, suite: 11, app: NON_ACTIONS_APP, conclusion: 'failure' }, { id: 20, suite: 12, app: NON_ACTIONS_APP }], expect: 'fail' },
    { what: 'a re-run in the same suite passed over its failure', jobs: [{ id: 10, suite: 11, app: NON_ACTIONS_APP, conclusion: 'failure' }, { id: 20, suite: 11, app: NON_ACTIONS_APP }], expect: 'pass' },
    { what: "owner 3 under a non-Actions App: its pass, and another App's failure", jobs: [{ id: 20, suite: 12, app: NON_ACTIONS_APP }, { id: 30, suite: 9, app: OTHER_APP, conclusion: 'failure' }], expect: 'fail' },
    { what: 'two suites of the App, both passed', jobs: [{ id: 10, suite: 11, app: NON_ACTIONS_APP }, { id: 20, suite: 12, app: NON_ACTIONS_APP }], expect: 'pass' },
    { what: 'only an Actions run of the name', jobs: [{ id: 20, suite: 2 }], files: { 2: ciYml }, expect: 'missing' },
  ];
  const kinds = [
    { kind: 'workflow pin', cases: actions, ready: { configured: { ci: { workflow: ciYml } }, github: {} }, watch: { config: `required_checks: [ci]\nrequired_check_sources:\n  ci: { workflow: ${ciYml} }\n`, github: {} } },
    { kind: 'Actions-App pin', cases: actions, ready: { configured: {}, github: { ci: ACTIONS_ID } }, watch: { config: 'required_checks: [ci]\n', github: { ci: ACTIONS_ID } } },
    { kind: 'non-Actions App pin', cases: app, ready: { configured: { ci: { app_id: NON_ACTIONS_APP } }, github: {} }, watch: { config: `required_checks: [ci]\nrequired_check_sources:\n  ci: { app_id: ${NON_ACTIONS_APP} }\n`, github: {} } },
  ];
  // Under a workflow pin evil.yml is another source (its pass can't count, ci.yml's failure stands): fail either way.
  const rows: string[] = [];
  for (const k of kinds) {
    for (const c of k.cases) {
      const head = 'f'.repeat(40);
      const r = await readinessVerdict(c, head, k.ready);
      const w = await watchVerdict(c, k.watch);
      rows.push(`${k.kind} | ${c.what} | readiness ${r} | watch ${w}`);
      assert.equal(r, c.expect, `readiness, ${k.kind}: ${c.what}`);
      assert.equal(w, c.expect, `main watch, ${k.kind}: ${c.what}`);
    }
  }
  assert.equal(rows.length, 22);
});
