// The main watch wired into the coordinator, and people's PRs in the PR batches: an unaccounted commit stops
// auto-merge, alerts and opens a revert PR the harness can never merge; an admin clears the stop on the dashboard
// (audited); a writer's PR gets the full run and check on its head, is never auto-merged, and merging it trips nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { CommitCheck, PullRequest } from '../src/backlog/types.js';
import type { Role } from '../src/dashboard-auth.js';
import { startDashboard } from '../src/dashboard.js';
import type { EventPayload } from '../src/events/types.js';
import { CONFIG_PATH, type CheckRunAt, type MainWatchApi, type MergedPull } from '../src/main-watch.js';
import type { PrTestRuns, OpenPr } from '../src/coordinator/test-runs.js';
import type { TestRunRequest, TestRuns } from '../src/coordinator/pr-batch.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture, git, passing, type Fixture } from './repro-state-graph/harness.js';
import { asPerson, exampleRoles } from './helpers.js';

const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];

/** A GitHub for the main watch: no protection, and whatever PRs, checks and roles the test sets. */
function watchApi(f: Fixture) {
  const pulls = new Map<string, MergedPull[]>();
  const roles = new Map<string, Role | null>();
  const mergedAt = new Map<string, string>();
  const calls: string[] = [];
  // Check runs as the backlog has them, all finished a minute before the merge they are read for.
  const runsOf = async (sha: string): Promise<CheckRunAt[]> => {
    const at = Date.parse([...mergedAt.values()].at(-1) ?? new Date().toISOString()) - 60_000;
    return (await f.backlog.checks(sha)).map((c: CommitCheck) => ({ name: c.name, status: c.status, conclusion: c.conclusion, startedAt: new Date(at - 60_000).toISOString(), completedAt: new Date(at).toISOString() }));
  };
  const api: MainWatchApi = {
    protection: async () => (calls.push('protection'), 'none'),
    commitPulls: async (sha) => (calls.push('pulls'), pulls.get(sha) ?? []),
    pull: async (n) => (calls.push('pull'), [...pulls.values()].flat().find((p) => p.number === n)!),
    checkRuns: async (sha) => (calls.push('runs'), runsOf(sha)),
    statuses: async () => (calls.push('statuses'), []),
    role: async (login) => (calls.push('role'), roles.get(login) ?? null),
    compare: async () => (calls.push('compare'), { status: 'behind', aheadBy: 0, behindBy: 1 }),
  };
  return { api, pulls, roles, mergedAt, calls };
}

function world(o: { batching?: boolean; listing?: () => OpenPr[]; testRuns?: TestRuns } = {}) {
  const f = fixture();
  mkdirSync(f.stateDir, { recursive: true });
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  if (o.batching) {
    f.cfg.project.required_checks = ['ci', 'full'];
    f.cfg.tests.land.pr_batch = { enabled: true, max: 8, shards: 1, fast_checks: ['ci'], full_checks: ['full'] };
  }
  const gh = watchApi(f);
  const clock = { t: Date.now() };
  const prTestRuns = o.listing ? ({ tick: async () => ({ started: [], cancelled: [] }), idle: async () => undefined, stop: () => undefined, recover: async () => [], listing: o.listing } as unknown as PrTestRuns) : undefined;
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), {
    prPollMs: 0,
    autoMerge: () => true,
    roleOf: exampleRoles,
    mainWatch: { api: gh.api, now: () => clock.t },
    ...(prTestRuns ? { prTestRuns } : {}),
    ...(o.testRuns ? { testRuns: o.testRuns } : {}),
  });
  const watch = async (minutes = 1) => {
    for (let i = 0; i < minutes; i++) {
      clock.t += 61_000;
      await (c as unknown as { watchMain(): Promise<void> }).watchMain();
    }
  };
  // Someone else's clone of the repo, to push and merge from.
  const person = join(mkdtempSync(join(tmpdir(), 'person-')), 'p');
  git(f.base, 'clone', '-q', f.remote, person);
  // The watch judges a merge by the required_checks committed at its parent, so the default branch carries them too.
  appendFileSync(join(person, CONFIG_PATH), `\nrequired_checks: ${JSON.stringify(f.cfg.project.required_checks)}\n`);
  git(person, 'add', CONFIG_PATH);
  // The coordinator follows the default branch's config (src/config/live.ts): batching must be committed there too.
  if (o.batching) {
    const tests = join(BRAND.configDir, 'tests.yaml');
    writeFileSync(join(person, tests), readFileSync(join(person, tests), 'utf8').replace('land:\n  pre: []\n', `land:\n  pre: []\n  pr_batch: ${JSON.stringify(f.cfg.tests.land.pr_batch)}\n`));
    git(person, 'add', tests);
  }
  git(person, ...ident, 'commit', '-q', '-m', 'required_checks');
  git(person, 'push', '-q', 'origin', 'main');
  const commit = (file: string) => {
    writeFileSync(join(person, file), `${file}\n`);
    git(person, 'add', '-A');
    git(person, ...ident, 'commit', '-q', '-m', `add ${file}`);
    return git(person, 'rev-parse', 'HEAD');
  };
  return { f, gh, c, watch, person, commit, clock };
}

const stopFile = (f: Fixture) => join(f.stateDir, 'auto-merge-stopped.json');
const of = <T>(f: Fixture, type: Parameters<Fixture['log']['read']>[1] extends (infer U)[] | undefined ? U : never) => f.log.read(0, [type]).map((e) => e.payload as T);
const mergeOurs = (c: unknown, pr: PullRequest) => (c as { mergeOurs(pr: PullRequest): Promise<{ ok: boolean; why?: string }> }).mergeOurs(pr);

test('main watch: a direct push stops auto-merge, alerts, and opens a revert PR the harness can never merge', async () => {
  const w = world();
  await w.watch(2); // protection asked; main's tip is the baseline
  assert.ok(!existsSync(stopFile(w.f)));
  const main = git(w.f.remote, 'rev-parse', 'main');
  const sha = w.commit('direct.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(4); // GitHub's empty commit-to-PR link is asked again for LINK_LAG_MS first
  // Stopped, with the reason, in the existing stopped state.
  const stop = JSON.parse(readFileSync(stopFile(w.f), 'utf8')) as { reason: string; by: string; sha: string };
  assert.equal(stop.by, 'main_watch');
  assert.equal(stop.sha, sha);
  assert.match(w.c.autoMergeStopped() ?? '', /main watch: .* was pushed to main directly/);
  assert.equal(of<EventPayload<'merge.stopped'>>(w.f, 'merge.stopped').length, 1);
  // One alert, with the commit's link and the revert PR.
  const alerts = of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.url, `https://github.com/${w.f.cfg.project.project.repo}/commit/${sha}`);
  const revert = w.f.backlog.prs().find((p) => p.head === `${BRAND.cli}/revert-${sha.slice(0, 12)}`)!;
  assert.ok(revert, 'a revert PR is open');
  assert.equal(alerts[0]!.revert, revert.url);
  assert.ok(revert.labels.includes('needs-owner'));
  assert.ok(!git(w.f.remote, 'ls-tree', '--name-only', revert.headSha).split('\n').includes('direct.txt'), 'the revert takes the commit out');
  // The harness can't merge it, whatever path leads there; nor any PR it didn't open.
  const r = await mergeOurs(w.c, await w.f.backlog.pullRequest(revert.number));
  assert.equal(r.ok, false);
  assert.match(r.why ?? '', /never auto-merged: .*revert the harness opened/);
  assert.ok(!w.f.backlog.prs().find((p) => p.number === revert.number)!.merged);
  // Nothing pushed main: the revert is a branch, and main is where the push left it.
  assert.equal(git(w.f.remote, 'rev-parse', 'main'), sha);
  assert.notEqual(main, sha);
  // Later passes alert nothing more for it.
  await w.watch(3);
  assert.equal(of(w.f, 'main_watch.unaccounted').length, 1);
});

test('main watch: only an admin clears the stop on the dashboard; it is audited, and a viewer sees the mode only', async () => {
  const w = world();
  await w.watch(2);
  w.commit('direct.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(4); // GitHub's empty commit-to-PR link is asked again for LINK_LAG_MS first
  const d = await startDashboard({ root: w.f.repo, cfg: w.f.cfg, eventsDb: join(w.f.base, 'events.db'), stateDir: w.f.stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: w.f.slotsDir, instance: 'alice' });
  const base = d.url.split('/?')[0]!;
  const call = (who: string, path: string, method = 'GET') => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(who) }, ...(method === 'POST' ? { body: '{}' } : {}) });
  try {
    const owner = (await (await call('example-owner', '/api/state')).json()) as { protection: { mode: string; lastChecked: { sha: string } | null; alert: { url: string } | null; canClear: boolean } };
    assert.equal(owner.protection.mode, 'main_watch');
    assert.ok(owner.protection.lastChecked?.sha);
    assert.match(owner.protection.alert?.url ?? '', /\/commit\/[0-9a-f]{40}$/);
    assert.equal(owner.protection.canClear, true);
    const viewer = (await (await call('someone-else', '/api/state')).json()) as { protection: unknown };
    assert.deepEqual(viewer.protection, { mode: 'main_watch' }, 'a viewer sees the mode only');
    assert.equal((await call('example-collaborator', '/api/auto-merge/clear', 'POST')).status, 403, 'a writer may not clear it');
    assert.ok(existsSync(stopFile(w.f)));
    assert.equal((await call('example-owner', '/api/auto-merge/clear', 'POST')).status, 200);
    assert.ok(!existsSync(stopFile(w.f)), 'cleared');
    assert.equal(w.c.autoMergeStopped(), null);
    const audit = of<EventPayload<'dashboard.audit'>>(w.f, 'dashboard.audit').at(-1)!;
    assert.equal(audit.action, 'auto_merge.cleared');
    assert.equal(audit.login, 'example-owner');
    assert.match(of<EventPayload<'merge.resumed'>>(w.f, 'merge.resumed').at(-1)!.detail, /@example-owner cleared the stop on the dashboard/);
    assert.equal((await call('example-owner', '/api/auto-merge/clear', 'POST')).status, 409, 'nothing left to clear');
  } finally {
    await d.close();
  }
});

/** A test-run service whose full runs pass, posting the `full` check on each head as the App would. */
function service(f: () => Fixture) {
  const runs: TestRunRequest[] = [];
  const full = { name: 'full', source: 'check_run' as const, status: 'completed', conclusion: 'success', id: 2 };
  const t: TestRuns = {
    async startTestRun(req) {
      runs.push(req);
      return { id: `run-${runs.length}`, sha: req.sha, kind: 'full', ok: true, tiers: [{ tier: 'unit', ok: true, durationMs: 1, summary: 'ok', logRef: 'log://1' }] };
    },
    async postChecks(sha) {
      f().backlog.setChecks(sha, [...(await f().backlog.checks(sha)), full]);
    },
    checkNames: () => ({ unit: 'full' }),
  };
  return { t, runs };
}

/** A person's PR: a branch pushed from their clone and opened, with its fast check green. */
async function personPr(w: ReturnType<typeof world>, branch: string) {
  git(w.person, 'checkout', '-q', '-b', branch);
  const head = w.commit(`${branch.replace(/\W/g, '-')}.txt`);
  git(w.person, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  git(w.person, 'checkout', '-q', 'main');
  const pr = await w.f.backlog.openPr(branch, 'main', `Change ${branch}`, '', { headSha: head });
  w.f.backlog.setChecks(head, passing);
  return { number: pr.number, head };
}

async function settle(w: ReturnType<typeof world>, passes = 4) {
  for (let i = 0; i < passes; i++) {
    await w.c.tick();
    await w.c.idle();
  }
}

test("people's PRs: a writer's gets the full run and check on its head, is never auto-merged, and merging it trips nothing", async () => {
  let fx: Fixture | null = null;
  const s = service(() => fx!);
  const listing: OpenPr[] = [];
  const w = world({ batching: true, listing: () => listing, testRuns: s.t });
  fx = w.f;
  await w.watch(2); // the watch is on before anything merges
  const pr = await personPr(w, 'feature/totals');
  listing.push({ number: pr.number, headSha: pr.head, base: 'main', author: 'example-collaborator', bot: false });
  await settle(w);
  assert.deepEqual(s.runs.map((r) => [r.kind, r.prs]), [['full', [pr.number]]], 'one full run, of this PR');
  assert.ok((await w.f.backlog.checks(pr.head)).some((c) => c.name === 'full'), 'the full check is on its head');
  const queued = of<EventPayload<'pr_batch.queued'>>(w.f, 'pr_batch.queued');
  assert.deepEqual(queued.map((q) => [q.number, q.by]), [[pr.number, 'example-collaborator']]);
  // Never auto-merged: not by the batch, not by the merge policy, not if asked directly.
  await settle(w, 2);
  assert.ok(!w.f.backlog.prs().find((p) => p.number === pr.number)!.merged, 'not merged');
  assert.equal(of(w.f, 'merge.done').length, 0);
  const r = await mergeOurs(w.c, await w.f.backlog.pullRequest(pr.number));
  assert.equal(r.ok, false);
  assert.match(r.why ?? '', /the harness did not open this PR/);
  // The writer merges it on GitHub: required_checks (ci and full) were green on its head then, so the watch is quiet.
  git(w.person, 'fetch', '-q', 'origin');
  git(w.person, 'reset', '-q', '--hard', 'origin/main');
  git(w.person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.head);
  git(w.person, 'push', '-q', 'origin', 'main');
  const merge = git(w.person, 'rev-parse', 'HEAD');
  const at = new Date(w.clock.t).toISOString();
  w.gh.mergedAt.set(merge, at);
  w.gh.pulls.set(merge, [{ number: pr.number, url: `https://github.com/x/y/pull/${pr.number}`, mergedAt: at, mergeCommit: merge, mergedBy: 'example-collaborator', mergedByBot: false, head: pr.head, base: 'main' }]);
  w.gh.roles.set('example-collaborator', 'writer');
  await w.watch(6);
  assert.deepEqual(of<EventPayload<'main_watch.checked'>>(w.f, 'main_watch.checked').map((x) => [x.sha, x.how]), [[merge, 'person']]);
  assert.equal(of(w.f, 'main_watch.unaccounted').length, 0, 'nothing unaccounted');
  assert.ok(!existsSync(stopFile(w.f)), 'auto-merge goes on');
});

test("people's PRs: a bot's and an unmapped author's stay fast-only", async () => {
  let fx: Fixture | null = null;
  const s = service(() => fx!);
  const listing: OpenPr[] = [];
  const w = world({ batching: true, listing: () => listing, testRuns: s.t });
  fx = w.f;
  const bot = await personPr(w, 'deps/bump');
  const stranger = await personPr(w, 'feature/drive-by');
  listing.push({ number: bot.number, headSha: bot.head, base: 'main', author: 'dependabot[bot]', bot: true });
  listing.push({ number: stranger.number, headSha: stranger.head, base: 'main', author: 'someone-else', bot: false });
  await settle(w);
  assert.deepEqual(s.runs, [], 'no full run');
  assert.deepEqual(of(w.f, 'pr_batch.queued'), [], 'neither is queued');
  // An admin's approval lets the unmapped author's PR in, as before.
  w.f.backlog.addReview(stranger.number, { author: 'example-owner', state: 'APPROVED', body: 'ok' });
  await settle(w);
  assert.deepEqual(of<EventPayload<'pr_batch.queued'>>(w.f, 'pr_batch.queued').map((q) => q.number), [stranger.number]);
});

test('main watch: an admin accepts a PR as a bootstrap merge on the dashboard (audited), then merges it: no stop, alert or revert; a writer and a viewer are refused (audited); a stop in force stays', async () => {
  const w = world();
  await w.watch(2);
  // A stop in force already: an earlier direct push.
  w.commit('direct.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(4); // GitHub's empty commit-to-PR link is asked again for LINK_LAG_MS first
  assert.ok(existsSync(stopFile(w.f)));
  // The admin's PR; the project's required check can't run yet, so it has none.
  const pr = await personPr(w, 'feature/bootstrap');
  w.f.backlog.setChecks(pr.head, []);
  git(w.person, 'push', '-q', 'origin', `${pr.head}:refs/pull/${pr.number}/head`);
  const d = await startDashboard({ root: w.f.repo, cfg: w.f.cfg, eventsDb: join(w.f.base, 'events.db'), stateDir: w.f.stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: w.f.slotsDir, instance: 'alice' });
  const base = d.url.split('/?')[0]!;
  const call = (who: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(who) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const audits = () => of<EventPayload<'dashboard.audit'>>(w.f, 'dashboard.audit').filter((a) => a.action.startsWith('main_watch.'));
  try {
    const ask = { pr: pr.number, reason: "bootstrap: the suite can't run until this merges" };
    assert.equal((await call('example-collaborator', '/api/main-watch/accept', ask)).status, 403, 'a writer may not accept');
    assert.equal((await call('someone-else', '/api/main-watch/accept', ask)).status, 403, 'nor a viewer');
    assert.deepEqual(audits().map((a) => [a.action, a.login, a.detail.status]), [['main_watch.accept_refused', 'example-collaborator', 403], ['main_watch.accept_refused', 'someone-else', 403]], 'both refusals audited');
    const ok = await call('example-owner', '/api/main-watch/accept', ask);
    assert.equal(ok.status, 200, await ok.clone().text());
    const a = audits().at(-1)!;
    assert.deepEqual([a.action, a.login, a.detail.pr, a.detail.head, a.detail.reason], ['main_watch.accept', 'example-owner', pr.number, pr.head, ask.reason]);
    assert.equal((await call('example-owner', '/api/main-watch/accept', { reason: 'x' })).status, 400, 'a sha or a PR is named');
    // Accepting leaves the stop where it was: clearing it stays separate.
    assert.ok(existsSync(stopFile(w.f)), 'the stop stays');
    assert.notEqual(w.c.autoMergeStopped(), null);
    type P = { protection: { accepted?: { pr: number | null; appliedTo: string | null }[]; canAccept?: boolean } };
    const owner = (await (await call('example-owner', '/api/state')).json()) as P;
    assert.equal(owner.protection.canAccept, true);
    assert.deepEqual(owner.protection.accepted?.map((x) => [x.pr, x.appliedTo]), [[pr.number, null]]);
    const writer = (await (await call('example-collaborator', '/api/state')).json()) as P;
    assert.equal(writer.protection.canAccept, false, 'a writer sees the list, read-only');
    assert.equal(writer.protection.accepted?.length, 1);
    const viewer = (await (await call('someone-else', '/api/state')).json()) as P;
    assert.deepEqual(viewer.protection, { mode: 'main_watch' });
    // The owner merges it on GitHub, with its required check missing.
    git(w.person, 'fetch', '-q', 'origin');
    git(w.person, 'reset', '-q', '--hard', 'origin/main');
    git(w.person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.head);
    git(w.person, 'push', '-q', 'origin', 'main');
    const merge = git(w.person, 'rev-parse', 'HEAD');
    const at = new Date(w.clock.t).toISOString();
    w.gh.mergedAt.set(merge, at);
    w.gh.pulls.set(merge, [{ number: pr.number, url: `https://github.com/x/y/pull/${pr.number}`, mergedAt: at, mergeCommit: merge, mergedBy: 'example-owner', mergedByBot: false, head: pr.head, base: 'main' }]);
    w.gh.roles.set('example-owner', 'owner');
    await w.watch(6);
    assert.deepEqual(of<EventPayload<'main_watch.accepted'>>(w.f, 'main_watch.accepted').map((x) => [x.sha, x.number, x.by, x.reason]), [[merge, pr.number, 'example-owner', ask.reason]]);
    assert.equal(of(w.f, 'main_watch.unaccounted').length, 1, 'no alert for it: only the direct push');
    assert.equal(of(w.f, 'merge.stopped').length, 1);
    assert.ok(!w.f.backlog.prs().some((p) => p.head === `${BRAND.cli}/revert-${merge.slice(0, 12)}`), 'no revert PR');
    const after = (await (await call('example-owner', '/api/state')).json()) as P;
    assert.deepEqual(after.protection.accepted?.map((x) => x.appliedTo), [merge]);
    // Judged now: it can't be accepted again.
    const again = await call('example-owner', '/api/main-watch/accept', ask);
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /judged already/);
  } finally {
    await d.close();
  }
});
