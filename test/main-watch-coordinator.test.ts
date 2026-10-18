// The main watch wired into the coordinator, and people's PRs in the PR batches: an unaccounted commit stops
// auto-merge, alerts and opens a revert PR the harness can never merge; an admin clears the stop on the dashboard
// (audited); a writer's PR gets the full run and check on its head, is never auto-merged, and merging it trips nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { CommitCheck, PullRequest } from '../src/backlog/types.js';
import type { Role } from '../src/dashboard-auth.js';
import { protectionState, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { mainWatchPost } from '../src/intake/channel.js';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import { CONFIG_PATH, protectionView, type CheckRunAt, type MainWatchApi, type MergedPull, type WorkflowAt } from '../src/main-watch.js';
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
  /** GitHub's compare, by `base...head`; not set: head is behind base (not in that merge). */
  const compares = new Map<string, { status: string; aheadBy: number; behindBy: number }>();
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
    compare: async (base, head) => (calls.push('compare'), compares.get(`${base}...${head}`) ?? { status: 'behind', aheadBy: 0, behindBy: 1 }),
    workflows: async () => (calls.push('workflows'), wf.list),
  };
  /** The Actions workflows' list; null: GitHub answers 403 or 404. */
  const wf = { list: null as WorkflowAt[] | null };
  return { api, pulls, roles, mergedAt, calls, compares, wf };
}

/** A chat source that records every post (Discord itself is never called). */
function fakeChat() {
  const posts: { where: string; text: string }[] = [];
  const src: IntakeSource & { posts: typeof posts } = {
    name: 'discord',
    posts,
    take: async () => [],
    reply: async (t, text) => (posts.push({ where: t.id, text }), true),
    openThread: async () => '900000',
    watch: () => undefined,
  };
  return src;
}
const OPS_CHANNEL = '300000000001';

function world(o: { batching?: boolean; listing?: () => OpenPr[]; testRuns?: TestRuns; chat?: IntakeSource } = {}) {
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
  const prTestRuns = o.listing ? ({ tick: async () => ({ started: [], cancelled: [] }), idle: async () => undefined, stop: () => undefined, recover: async () => [], ready: () => true, listing: o.listing } as unknown as PrTestRuns) : undefined;
  const intakeCfg = IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: ['100000000001'], people: { '100000000001': 'example-owner' }, ops_channel: OPS_CHANNEL, dashboard_url: 'https://dashboard.example.test' } });
  /** A coordinator over the fixture: `log`, another handle on the same event log (a restart). */
  const start = (log = f.log) =>
    coordinator({ ...f, log }, new FakeRunner(() => ({ structured: {} })), {
      prPollMs: 0,
      autoMerge: () => true,
      roleOf: exampleRoles,
      mainWatch: { api: gh.api, now: () => clock.t },
      ...(prTestRuns ? { prTestRuns } : {}),
      ...(o.testRuns ? { testRuns: o.testRuns } : {}),
      ...(o.chat ? { intake: { config: () => intakeCfg, sources: [o.chat] } } : {}),
    });
  let c = start();
  const watch = async (minutes = 1) => {
    for (let i = 0; i < minutes; i++) {
      clock.t += 61_000;
      await (c as unknown as { watchMain(): Promise<void> }).watchMain();
    }
  };
  /** A restart: a new coordinator (and main watch) over the same state directory and event log file. */
  const restart = () => {
    c = start(new EventLog(join(f.base, 'events.db')));
    return c;
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
  return {
    f,
    gh,
    get c() {
      return c;
    },
    watch,
    restart,
    person,
    commit,
    clock,
  };
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

/** The revert PRs the harness opened. */
const reverts = (f: Fixture) => f.backlog.prs().filter((p) => p.head.startsWith(`${BRAND.cli}/revert-`));

test('main watch caps: a multi-commit trip with a missing check opens one revert PR, the others\' alerts say why and list the trip; a direct push in the same pass still trips with its own alert and revert', async () => {
  const w = world();
  await w.watch(2);
  // One fetch sees four commits: PR #42 rebased onto main as three, its required check never run (it can't), then a direct push.
  const c1 = w.commit('r1.txt');
  const c2 = w.commit('r2.txt');
  const c3 = w.commit('r3.txt');
  const direct = w.commit('direct.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  const at = new Date(w.clock.t).toISOString();
  const pr: MergedPull = { number: 42, url: 'https://github.com/x/y/pull/42', mergedAt: at, mergeCommit: c3, mergedBy: 'example-owner', mergedByBot: false, head: 'e'.repeat(40), base: 'main', commits: 3 };
  for (const c of [c1, c2, c3]) w.gh.pulls.set(c, [pr]);
  w.gh.mergedAt.set(c3, at);
  w.gh.compares.set(`${c1}...${c3}`, { status: 'ahead', aheadBy: 2, behindBy: 0 });
  w.gh.compares.set(`${c2}...${c3}`, { status: 'ahead', aheadBy: 1, behindBy: 0 });
  w.gh.roles.set('example-owner', 'owner');
  await w.watch(30);
  const alerts = of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted');
  assert.deepEqual(alerts.map((a) => a.sha), [c1, c2, c3, direct], 'every commit judged, each with its own alert');
  assert.match(alerts[0]!.reason, /#42 was merged into main with required checks not green .*ci missing/);
  // One revert PR for the trip, one for the direct push.
  const opened = reverts(w.f);
  assert.deepEqual(opened.map((p) => p.head).sort(), [c1, direct].map((s) => `${BRAND.cli}/revert-${s.slice(0, 12)}`).sort());
  const tripPr = opened.find((p) => p.head.endsWith(c1.slice(0, 12)))!.url;
  assert.equal(alerts[0]!.revert, tripPr);
  assert.equal(alerts[0]!.no_revert, null);
  assert.ok(alerts[0]!.trip && alerts.slice(0, 3).every((a) => a.trip === alerts[0]!.trip), 'one trip');
  for (const a of alerts.slice(1, 3)) {
    assert.equal(a.revert, null);
    assert.match(a.no_revert ?? '', /^the per-trip cap is reached \(main_watch\.revert_prs_per_trip: 1\): this trip's revert PR /);
    assert.ok(a.no_revert!.includes(tripPr), 'names the trip\'s revert PR');
  }
  assert.match(alerts[2]!.no_revert ?? '', new RegExp(`the trip's commits so far: ${c1.slice(0, 8)}, ${c2.slice(0, 8)}, ${c3.slice(0, 8)}$`));
  assert.match(mainWatchPost(alerts[1]!, { dashboardUrl: 'https://dashboard.example.test' }).text, /No revert PR was opened: the per-trip cap is reached/, 'the asks channel says so too');
  // The direct push: a trip of its own, with its own alert, revert PR and direct-push record.
  assert.notEqual(alerts[3]!.trip, alerts[0]!.trip);
  assert.equal(alerts[3]!.revert, opened.find((p) => p.head.endsWith(direct.slice(0, 12)))!.url);
  assert.deepEqual(of<EventPayload<'main_watch.direct_push'>>(w.f, 'main_watch.direct_push').map((p) => p.sha), [direct]);
  // Fail closed: a capped commit still stops auto-merge.
  assert.equal(of(w.f, 'merge.stopped').length, 4);
  assert.notEqual(w.c.autoMergeStopped(), null);
  // The dashboard's banner, as it stood after c3's alert: why it has no revert PR, and its trip's.
  const upToC3 = w.f.log.read(0).filter((e) => !(e.type === 'main_watch.unaccounted' && (e.payload as { sha: string }).sha === direct));
  const banner = protectionState({ stateDir: w.f.stateDir, repo: w.f.cfg.project.project.repo, events: upToC3, role: 'owner' }).alert!;
  assert.deepEqual([banner.sha, banner.revert, banner.trip_revert], [c3, null, tripPr]);
  assert.equal(banner.no_revert, alerts[2]!.no_revert);
});

test('main watch caps: at most 3 revert PRs a day on an instance, across a restart; past the cap the alert says so and opens none, and the commit still stops auto-merge', async () => {
  const w = world();
  await w.watch(2);
  for (const x of ['d1.txt', 'd2.txt', 'd3.txt']) w.commit(x);
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(15);
  assert.equal(reverts(w.f).length, 3);
  // A restart, then an admin clears the stop.
  w.restart();
  unlinkSync(stopFile(w.f));
  assert.equal(w.c.autoMergeStopped(), null);
  const fourth = w.commit('d4.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(6);
  const last = of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted').at(-1)!;
  assert.equal(last.sha, fourth);
  assert.equal(last.revert, null);
  assert.equal(last.no_revert, 'the per-day cap is reached (main_watch.revert_prs_per_day: 3): the main watch opened 3 revert PRs in the last 24 hours');
  assert.equal(reverts(w.f).length, 3, 'no fourth revert PR');
  const banner = protectionState({ stateDir: w.f.stateDir, repo: w.f.cfg.project.project.repo, events: w.f.log.read(0), role: 'owner' }).alert!;
  assert.deepEqual([banner.sha, banner.revert, banner.trip_revert, banner.no_revert], [fourth, null, null, last.no_revert], 'the banner says why');
  // Fail closed: stopped again, by this commit.
  assert.equal((JSON.parse(readFileSync(stopFile(w.f), 'utf8')) as { sha: string }).sha, fourth);
  assert.notEqual(w.c.autoMergeStopped(), null);
  // A day later the cap has room again.
  w.clock.t += 24 * 3600_000;
  const fifth = w.commit('d5.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(8);
  assert.equal(of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted').at(-1)!.sha, fifth);
  assert.equal(reverts(w.f).length, 4);
});

/** A commit in the person's clone that writes `text` to `file`. */
const edit = (w: ReturnType<typeof world>, file: string, text: string) => {
  writeFileSync(join(w.person, file), text);
  git(w.person, 'add', '-A');
  git(w.person, ...ident, 'commit', '-q', '-m', `${file}: ${text.trim()}`);
  return git(w.person, 'rev-parse', 'HEAD');
};

/**
 * PR #n rebased onto main as `shas` (first-parent commits, oldest first), merged by an owner with its required check
 * never run. `commits`: the PR's commit count as GitHub gives it (default: as many as `shas`); compare's answers
 * agree with it, so a smaller count is GitHub saying fewer than git shows.
 */
const rebaseMerged = (w: ReturnType<typeof world>, n: number, shas: string[], commits = shas.length) => {
  const at = new Date(w.clock.t).toISOString();
  const last = shas.at(-1)!;
  const pr: MergedPull = { number: n, url: `https://github.com/x/y/pull/${n}`, mergedAt: at, mergeCommit: last, mergedBy: 'example-owner', mergedByBot: false, head: 'e'.repeat(40), base: 'main', commits };
  for (const c of shas) w.gh.pulls.set(c, [pr]);
  w.gh.mergedAt.set(last, at);
  shas.forEach((c, i) => c !== last && w.gh.compares.set(`${c}...${last}`, { status: 'ahead', aheadBy: Math.min(shas.length - 1 - i, commits - 1), behindBy: 0 }));
  w.gh.roles.set('example-owner', 'owner');
};

test('main watch revert: a rebased PR whose commits edit one file trips as one trip and gets one revert PR of its whole range (a revert of its first commit alone conflicts); the others\' alerts say that PR reverts them too', async () => {
  const w = world();
  await w.watch(2);
  const c1 = edit(w, 'a.txt', 'one\n');
  const c2 = edit(w, 'a.txt', 'two\n');
  const c3 = edit(w, 'a.txt', 'three\n');
  git(w.person, 'push', '-q', 'origin', 'main');
  rebaseMerged(w, 43, [c1, c2, c3]);
  await w.watch(30);
  const alerts = of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted');
  assert.deepEqual(alerts.map((a) => a.sha), [c1, c2, c3], 'every commit judged, each with its own alert');
  const opened = reverts(w.f);
  const branch = `${BRAND.cli}/revert-${c1.slice(0, 12)}`;
  assert.deepEqual(opened.map((p) => p.head), [branch], 'one revert PR, opened at the trip\'s first commit');
  assert.equal(alerts[0]!.revert, opened[0]!.url);
  assert.equal(alerts[0]!.revert_through, c3, 'it reverts the PR\'s commits through its last');
  assert.equal(alerts[0]!.no_revert, null);
  // One commit on the tip that puts the tree back as it was before the PR.
  assert.equal(git(w.f.remote, 'rev-parse', `${branch}^`), c3);
  assert.equal(git(w.f.remote, 'rev-parse', `${branch}^{tree}`), git(w.f.remote, 'rev-parse', `${c1}^^{tree}`));
  assert.match(opened[0]!.title, new RegExp(`^Revert ${c1.slice(0, 8)}\\.\\.${c3.slice(0, 8)} \\(#43, 3 commits, unaccounted on main\\)$`));
  for (const a of alerts.slice(1)) {
    assert.equal(a.revert, null);
    assert.match(a.no_revert ?? '', new RegExp(`^the per-trip cap is reached \\(main_watch\\.revert_prs_per_trip: 1\\): this trip's revert PR ${opened[0]!.url} reverts this commit too \\(${c1.slice(0, 8)}\\.\\.${c3.slice(0, 8)}\\); `));
  }
  // Fail closed: each still stops auto-merge.
  assert.equal(of(w.f, 'merge.stopped').length, 3);
  assert.notEqual(w.c.autoMergeStopped(), null);
});

test('main watch revert: when a revert PR can\'t be opened (a conflict with a later commit, a push the push checks refuse), the alert and the asks-channel notice say why, and each commit still stops auto-merge', async () => {
  const w = world();
  w.f.cfg.guardrails.push.refuse_paths = ['secret.txt'];
  await w.watch(2);
  // PR #44 rebased onto main as two commits editing a.txt; then a direct push edits a.txt again, and another adds a
  // path the push checks refuse.
  const c1 = edit(w, 'a.txt', 'one\n');
  const c2 = edit(w, 'a.txt', 'two\n');
  const later = edit(w, 'a.txt', 'three\n');
  const secret = edit(w, 'secret.txt', 'x\n');
  git(w.person, 'push', '-q', 'origin', 'main');
  rebaseMerged(w, 44, [c1, c2]);
  await w.watch(30);
  const alerts = of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted');
  assert.deepEqual(alerts.map((a) => a.sha), [c1, c2, later, secret], 'every commit judged, each with its own alert');
  const tip = secret.slice(0, 8);
  // The PR's trip: its revert conflicts with the later edit, so no PR; the next commit of the trip tries again, and says why too.
  assert.equal(alerts[0]!.revert, null);
  assert.match(alerts[0]!.no_revert ?? '', new RegExp(`^opening the revert PR failed: git revert of ${c1.slice(0, 8)}\\.\\.${c2.slice(0, 8)} on main's tip ${tip} conflicts with later commits: CONFLICT \\(content\\): Merge conflict in a\\.txt`));
  assert.equal(alerts[1]!.revert, null);
  assert.match(alerts[1]!.no_revert ?? '', new RegExp(`^opening the revert PR failed: git revert of ${c2.slice(0, 8)} on main's tip ${tip} conflicts with later commits: CONFLICT \\(content\\): Merge conflict in a\\.txt`));
  assert.match(mainWatchPost(alerts[0]!, { dashboardUrl: 'https://dashboard.example.test' }).text, /No revert PR was opened: opening the revert PR failed: git revert of .* conflicts with later commits/, 'the asks channel says why');
  // The later edit reverts cleanly (nothing after it touches a.txt).
  assert.equal(alerts[2]!.revert, reverts(w.f).find((p) => p.head.endsWith(later.slice(0, 12)))!.url);
  assert.equal(alerts[2]!.no_revert, null);
  // The refused path: the push checks say no, and the alert says so.
  assert.equal(alerts[3]!.revert, null);
  assert.match(alerts[3]!.no_revert ?? '', /^opening the revert PR failed: the push checks refused the revert branch: .*secret\.txt/);
  assert.equal(reverts(w.f).length, 1);
  // Fail closed: a revert that failed never suppresses the stop or the alert.
  assert.equal(of(w.f, 'merge.stopped').length, 4);
  assert.notEqual(w.c.autoMergeStopped(), null);
  // The dashboard's banner (the latest alert, the refused path) says why, through protectionState.
  const banner = protectionState({ stateDir: w.f.stateDir, repo: w.f.cfg.project.project.repo, events: w.f.log.read(0), role: 'owner' }).alert!;
  assert.deepEqual([banner.sha, banner.revert, banner.trip_revert, banner.no_revert], [secret, null, null, alerts[3]!.no_revert]);
});

/** The files that differ between two commits, as git's name-status lines. */
const changed = (f: Fixture, a: string, b: string) => git(f.remote, 'diff', '--name-status', a, b).split('\n');

test('main watch revert: a rebased PR whose last commit is reached through a merge commit (not one straight line) gets its first commit reverted alone, with no revert_through', async () => {
  const w = world();
  await w.watch(2);
  const c1 = edit(w, 'a1.txt', 'one\n');
  git(w.person, 'checkout', '-q', '-b', 'side');
  edit(w, 's.txt', 'side\n');
  git(w.person, 'checkout', '-q', 'main');
  git(w.person, ...ident, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const m = git(w.person, 'rev-parse', 'HEAD');
  const c3 = edit(w, 'a3.txt', 'three\n');
  git(w.person, 'push', '-q', 'origin', 'main');
  // GitHub counts all 4 commits (c1, the side one, the merge, c3), so only git's straight-line check can refuse the range.
  rebaseMerged(w, 45, [c1, m, c3], 4);
  await w.watch(30);
  const alerts = of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted');
  assert.deepEqual(alerts.map((a) => a.sha), [c1, m, c3]);
  const branch = `${BRAND.cli}/revert-${c1.slice(0, 12)}`;
  const opened = reverts(w.f);
  assert.deepEqual(opened.map((p) => p.head), [branch]);
  assert.equal(alerts[0]!.revert, opened[0]!.url);
  assert.equal(alerts[0]!.revert_through, undefined, 'not a range');
  assert.match(opened[0]!.title, new RegExp(`^Revert ${c1.slice(0, 8)} \\(unaccounted on main\\)$`));
  // c1 alone, on the tip: its file goes, the side commit's and c3's stay.
  assert.equal(git(w.f.remote, 'rev-parse', `${branch}^`), c3);
  assert.deepEqual(changed(w.f, c3, branch), ['D\ta1.txt']);
});

test('main watch revert: a range with more commits than GitHub says the PR has is never reverted as one; the first commit is reverted alone', async () => {
  const w = world();
  await w.watch(2);
  const c1 = w.commit('g1.txt');
  const c2 = w.commit('g2.txt');
  const c3 = w.commit('g3.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  // GitHub says the PR has 2 commits, but git shows 3 from c1 through its merge commit.
  rebaseMerged(w, 47, [c1, c2, c3], 2);
  await w.watch(30);
  const alerts = of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted');
  assert.deepEqual(alerts.map((a) => a.sha), [c1, c2, c3]);
  const branch = `${BRAND.cli}/revert-${c1.slice(0, 12)}`;
  assert.deepEqual(reverts(w.f).map((p) => p.head), [branch]);
  assert.equal(alerts[0]!.revert_through, undefined, 'not a range');
  assert.deepEqual(changed(w.f, c3, branch), ['D\tg1.txt']);
});

test('main watch revert: below the per-trip cap, a later commit the trip\'s range revert covers opens no PR of its own, and its alert says that PR reverts it too', async () => {
  const w = world();
  // revert_prs_per_trip: 2, committed before the pass (so the trip may open a second PR, but needs none).
  appendFileSync(join(w.person, CONFIG_PATH), '\nmain_watch:\n  revert_prs_per_trip: 2\n');
  git(w.person, 'add', CONFIG_PATH);
  git(w.person, ...ident, 'commit', '-q', '-m', 'revert_prs_per_trip: 2');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(2);
  const c1 = edit(w, 'b.txt', 'one\n');
  const c2 = edit(w, 'b.txt', 'two\n');
  const c3 = edit(w, 'b.txt', 'three\n');
  git(w.person, 'push', '-q', 'origin', 'main');
  rebaseMerged(w, 46, [c1, c2, c3]);
  await w.watch(30);
  const alerts = of<EventPayload<'main_watch.unaccounted'>>(w.f, 'main_watch.unaccounted');
  assert.deepEqual(alerts.map((a) => a.sha), [c1, c2, c3]);
  const opened = reverts(w.f);
  assert.deepEqual(opened.map((p) => p.head), [`${BRAND.cli}/revert-${c1.slice(0, 12)}`], 'one revert PR: no second one for a covered commit');
  assert.equal(alerts[0]!.revert_through, c3);
  for (const a of alerts.slice(1)) {
    assert.equal(a.revert, null);
    // Not the cap's words: the cap (2) isn't reached.
    assert.match(a.no_revert ?? '', new RegExp(`^this trip's revert PR ${opened[0]!.url} reverts this commit too \\(${c1.slice(0, 8)}\\.\\.${c3.slice(0, 8)}\\); the trip's commits so far: `));
  }
  assert.equal(of(w.f, 'merge.stopped').length, 3);
});

test('main watch dead check: a required check with no run for dead_check_days is posted to the ops channel once and shown on the dashboard, and cleared when it runs again', async () => {
  const chat = fakeChat();
  const w = world({ chat });
  await w.watch(2);
  w.gh.roles.set('example-owner', 'owner');
  const merge = async (branch: string, checks: boolean) => {
    const pr = await personPr(w, branch);
    if (!checks) w.f.backlog.setChecks(pr.head, []);
    git(w.person, 'fetch', '-q', 'origin');
    git(w.person, 'reset', '-q', '--hard', 'origin/main');
    git(w.person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.head);
    git(w.person, 'push', '-q', 'origin', 'main');
    const m = git(w.person, 'rev-parse', 'HEAD');
    const at = new Date(w.clock.t).toISOString();
    w.gh.mergedAt.set(m, at);
    w.gh.pulls.set(m, [{ number: pr.number, url: `https://github.com/x/y/pull/${pr.number}`, mergedAt: at, mergeCommit: m, mergedBy: 'example-owner', mergedByBot: false, head: pr.head, base: 'main' }]);
  };
  const dead = () => of<EventPayload<'main_watch.dead_check'>>(w.f, 'main_watch.dead_check').map((d) => [d.check, d.state]);
  const posts = (re: RegExp) => chat.posts.filter((p) => p.where === OPS_CHANNEL && re.test(p.text));
  const view = () => protectionView(join(w.f.stateDir, 'main-watch.json'), w.f.cfg.project.project.repo).deadChecks.map((d) => d.check);
  await merge('feature/one', false);
  await w.watch(8);
  assert.equal(of(w.f, 'main_watch.unaccounted').length, 1);
  assert.deepEqual(dead(), [], 'one merge without it is not a dead check yet');
  w.clock.t += 7 * 24 * 3600_000;
  await w.watch(3);
  assert.deepEqual(dead(), [['ci', 'raised']]);
  assert.equal(posts(/the required check "ci" has had no run on any commit judged since .* keep tripping the watch until it posts/).length, 1);
  assert.deepEqual(view(), ['ci'], 'on the dashboard');
  await w.watch(3);
  assert.equal(dead().length, 1, 'once');
  assert.equal(posts(/"ci" has had no run/).length, 1, 'posted once');
  await merge('feature/two', true);
  await w.watch(8);
  assert.deepEqual(dead(), [['ci', 'raised'], ['ci', 'cleared']]);
  assert.equal(posts(/"ci" has a run again/).length, 1);
  assert.deepEqual(view(), []);
});

/** A world whose required check `ci` is raised dead while `workflows` is the Actions workflows' list. */
async function deadWith(workflows: WorkflowAt[]) {
  const chat = fakeChat();
  const w = world({ chat });
  w.gh.wf.list = workflows;
  await w.watch(2);
  w.gh.roles.set('example-owner', 'owner');
  const pr = await personPr(w, 'feature/one');
  w.f.backlog.setChecks(pr.head, []);
  git(w.person, 'fetch', '-q', 'origin');
  git(w.person, 'reset', '-q', '--hard', 'origin/main');
  git(w.person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.head);
  git(w.person, 'push', '-q', 'origin', 'main');
  const m = git(w.person, 'rev-parse', 'HEAD');
  const at = new Date(w.clock.t).toISOString();
  w.gh.mergedAt.set(m, at);
  w.gh.pulls.set(m, [{ number: pr.number, url: `https://github.com/x/y/pull/${pr.number}`, mergedAt: at, mergeCommit: m, mergedBy: 'example-owner', mergedByBot: false, head: pr.head, base: 'main' }]);
  await w.watch(8);
  w.clock.t += 7 * 24 * 3600_000;
  await w.watch(3);
  const raised = of<EventPayload<'main_watch.dead_check'>>(w.f, 'main_watch.dead_check');
  const posts = chat.posts.filter((p) => p.where === OPS_CHANNEL && /"ci" has had no run/.test(p.text)).map((p) => p.text);
  return { raised, posts };
}

test('regression: the dead-check ops post names the disabled workflow and its state; without one, its text is as before', async () => {
  const a = await deadWith([{ name: 'Tests', path: '.github/workflows/ci.yml', state: 'disabled_manually' }]);
  assert.equal(a.raised.length, 1);
  assert.deepEqual(a.posts, [
    `Main watch: the required check "ci" has had no run on any commit judged since ${a.raised[0]!.since}. Its workflow \`Tests\` (\`.github/workflows/ci.yml\`) is disabled on GitHub (\`disabled_manually\`), so it can't post the check until someone enables it again. Merges into main keep tripping the watch until it posts, or until it leaves required_checks in config.yaml.`,
  ]);
  const b = await deadWith([]);
  assert.equal(b.raised[0]!.workflow, undefined);
  assert.deepEqual(b.posts, [`Main watch: the required check "ci" has had no run on any commit judged since ${b.raised[0]!.since}. Merges into main keep tripping the watch until it posts, or until it leaves required_checks in config.yaml.`], 'as before');
});

test('regression: a hostile workflow name in the dead-check ops post is inert: no mention, link or markdown outside a code span', async () => {
  const name = '@everyone [x](http://evil.example/a) `**b**` <@123>';
  const a = await deadWith([{ name, path: '.github/workflows/ci.yml', state: 'disabled_inactivity' }]);
  assert.equal(a.raised[0]!.workflow?.name, name, 'the event keeps the name; only the post neutralizes it');
  assert.equal(a.posts.length, 1);
  const post = a.posts[0]!;
  // The name is one code span (its own backticks replaced, so it can't close the span): Discord renders nothing in it.
  const spans = [...post.matchAll(/`([^`]*)`/g)].map((x) => x[1]);
  assert.deepEqual(spans, ["@everyone [x](http://evil.example/a) '**b**' <@123>", '.github/workflows/ci.yml', 'disabled_inactivity']);
  assert.doesNotMatch(post.replace(/`[^`]*`/g, ''), /@everyone|<@|\]\(|\*\*|evil\.example/, 'nothing of the name outside its code span');
});

test('main watch dead check: the raised warning records the disabled workflow that would post the check, and is shown with it; posted once', async () => {
  const chat = fakeChat();
  const w = world({ chat });
  const disabled: WorkflowAt = { name: 'ci', path: '.github/workflows/ci.yml', state: 'disabled_inactivity' };
  w.gh.wf.list = [disabled];
  await w.watch(2);
  w.gh.roles.set('example-owner', 'owner');
  const pr = await personPr(w, 'feature/one');
  w.f.backlog.setChecks(pr.head, []);
  git(w.person, 'fetch', '-q', 'origin');
  git(w.person, 'reset', '-q', '--hard', 'origin/main');
  git(w.person, ...ident, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.head);
  git(w.person, 'push', '-q', 'origin', 'main');
  const m = git(w.person, 'rev-parse', 'HEAD');
  const at = new Date(w.clock.t).toISOString();
  w.gh.mergedAt.set(m, at);
  w.gh.pulls.set(m, [{ number: pr.number, url: `https://github.com/x/y/pull/${pr.number}`, mergedAt: at, mergeCommit: m, mergedBy: 'example-owner', mergedByBot: false, head: pr.head, base: 'main' }]);
  await w.watch(8);
  assert.equal(of(w.f, 'main_watch.unaccounted').length, 1);
  w.clock.t += 7 * 24 * 3600_000;
  await w.watch(3);
  const raised = of<EventPayload<'main_watch.dead_check'>>(w.f, 'main_watch.dead_check');
  assert.deepEqual(raised.map((d) => [d.check, d.state, d.workflow]), [['ci', 'raised', disabled]], 'the event log took the note');
  assert.deepEqual(protectionView(join(w.f.stateDir, 'main-watch.json'), w.f.cfg.project.project.repo).deadChecks.map((d) => d.workflow), [disabled]);
  assert.equal(chat.posts.filter((p) => p.where === OPS_CHANNEL && /"ci" has had no run/.test(p.text)).length, 1);
  assert.equal(w.gh.calls.filter((c) => c === 'workflows').length, 1);
  assert.equal(of(w.f, 'merge.stopped').length, 1, 'the stop as before');
});
