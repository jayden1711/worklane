// The main watch wired into the coordinator, and people's PRs in the PR batches: an unaccounted commit stops
// auto-merge, alerts and opens a revert PR the harness can never merge; an admin clears the stop on the dashboard
// (audited); a writer's PR gets the full run and check on its head, is never auto-merged, and merging it trips nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgement, measureMain, remoteTip } from '../src/auto-merge-resume.js';
import { BRAND } from '../src/brand.js';
import type { CommitCheck, PullRequest } from '../src/backlog/types.js';
import type { Role } from '../src/dashboard-auth.js';
import { clearAutoMergeStop, protectionState, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { mainWatchPost } from '../src/intake/channel.js';
import { DiscordIntake, REPLY_CHARS } from '../src/intake/discord.js';
import { IntakeConfig, type IntakeSource } from '../src/intake/report.js';
import { CONFIG_PATH, disabledWorkflowFor, protectionView, type CheckRunAt, type MainWatchApi, type MergedPull, type WorkflowAt } from '../src/main-watch.js';
import type { PrTestRuns, OpenPr } from '../src/coordinator/test-runs.js';
import type { TestRunRequest, TestRuns } from '../src/coordinator/pr-batch.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, failing, fixture, git, passing, type Fixture } from './repro-state-graph/harness.js';
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
  // Precondition (#776): the default branch is green on its tip again, so the main watch's stop may resume.
  w.f.backlog.setChecks(git(w.f.remote, 'rev-parse', 'main'), passing);
  const d = await startDashboard({ root: w.f.repo, cfg: w.f.cfg, eventsDb: join(w.f.base, 'events.db'), stateDir: w.f.stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: w.f.slotsDir, instance: 'alice', backlog: () => w.f.backlog });
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

// ---- #776: a stop the default branch caused resumes only once it is green on its tip, or with a recorded acknowledgement.

/** The coordinator's own red-main stop (fix-forward reverted the culprit, or gave up), on main's current tip. */
const redMainStop = (w: ReturnType<typeof world>) => {
  const tip = git(w.f.remote, 'rev-parse', 'main');
  (w.c as unknown as { stopFor(reason: string, n: number | null, sha: string, revert: string | null): void }).stopFor(`main's required checks failed (ci) on \`${tip.slice(0, 8)}\``, null, tip, null);
  return tip;
};
const watchMerges = (w: ReturnType<typeof world>) => (w.c as unknown as { watchMerges(): Promise<void> }).watchMerges();
/** The last event of `type`, whole (its actor and time too). */
const f776Last = (w: ReturnType<typeof world>, type: 'merge.resumed' | 'merge.stopped') => w.f.log.read(0, [type]).at(-1)!;

/** A dashboard over the world, its backlog the one the checks are read from; `cfg` stands in for the instance's config. */
async function resumeDashboard(w: ReturnType<typeof world>, cfg = w.f.cfg, extra: Record<string, unknown> = {}) {
  const d = await startDashboard({ root: w.f.repo, cfg, eventsDb: join(w.f.base, 'events.db'), stateDir: w.f.stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: w.f.slotsDir, instance: 'alice', backlog: () => w.f.backlog, ...extra });
  const base = d.url.split('/?')[0]!;
  const resume = async (body: unknown = {}, who = 'example-owner') => {
    const r = await fetch(`${base}/api/auto-merge/clear`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(who) }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { ok?: boolean; how?: string; error?: string; needsAck?: boolean } };
  };
  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson('example-owner') } });
  return { d, resume, get };
}

/** A remote whose upload-pack hangs for `seconds` (a stand-in for a remote that stops answering). */
const hangRemote = (w: ReturnType<typeof world>, seconds: number) => {
  const script = join(w.f.base, 'hang-upload-pack');
  writeFileSync(script, `#!/bin/sh\nsleep ${seconds}\n`);
  chmodSync(script, 0o755);
  git(w.f.repo, 'config', 'remote.origin.uploadpack', script);
};

test("resume (#776): main's tip is the exact ref refs/heads/<branch>: a green decoy branch or tag whose name ends in refs/heads/main never stands in for a red main", async () => {
  const w = world();
  await w.watch(2);
  const green = git(w.f.remote, 'rev-parse', 'main');
  w.f.backlog.setChecks(green, passing);
  // Main goes red; anyone who can push a branch or a tag plants green decoys.
  const tip = w.commit('red.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  w.f.backlog.setChecks(tip, failing(11));
  git(w.person, 'push', '-q', 'origin', `${green}:refs/heads/a/refs/heads/main`, `${green}:refs/tags/refs/heads/main`);
  assert.match(git(w.f.repo, 'ls-remote', 'origin', 'refs/heads/main'), /refs\/heads\/a\/refs\/heads\/main[\s\S]*refs\/heads\/main[\s\S]*refs\/tags\/refs\/heads\/main/, 'git itself lists the decoys for that pattern');
  assert.equal(await remoteTip(w.f.repo, 'origin', 'main'), tip, 'the exact ref only');
  redMainStop(w);
  const { d, resume } = await resumeDashboard(w);
  try {
    const r = await resume();
    assert.equal(r.status, 409, 'the dashboard measures the real, red main');
    assert.match(r.body.error ?? '', new RegExp(`tip ${tip.slice(0, 8)} are not all green`));
  } finally {
    await d.close();
  }
  // The coordinator too: a hand deletion is written back.
  unlinkSync(stopFile(w.f));
  await watchMerges(w);
  assert.ok(existsSync(stopFile(w.f)), 'written back');
  assert.equal(of(w.f, 'merge.resumed').length, 0);
});

test('resume (#776): reading main never blocks: a hung remote times out as not green, and the dashboard answers other requests meanwhile', async () => {
  const w = world();
  await w.watch(2);
  redMainStop(w);
  hangRemote(w, 4);
  // The read itself: the event loop runs while it waits, and a timeout is no tip.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 50);
  const started = performance.now();
  const read = await remoteTip(w.f.repo, 'origin', 'main', { timeoutMs: 1000 });
  clearInterval(timer);
  assert.equal(read, null, 'timed out: unreadable');
  assert.ok(ticks >= 5, `the event loop ran while git waited (${ticks} ticks)`);
  assert.ok(performance.now() - started < 3500, 'bounded by the timeout, not the remote');
  // The dashboard: a resume waits on the hung remote; another request is served at once.
  const { d, resume, get } = await resumeDashboard(w, w.f.cfg, { mainTipTimeoutMs: 1500 });
  try {
    const pending = resume();
    await new Promise((r) => setTimeout(r, 200));
    const t0 = performance.now();
    const s = await get('/api/state');
    const took = Math.round(performance.now() - t0);
    assert.equal(s.status, 200);
    // The remote hangs for 4 s: a request queued behind a blocking read would take over 3.5 s.
    assert.ok(took < 2000, `another request answered while main was read (${took} ms)`);
    const r = await pending;
    assert.equal(r.status, 409);
    assert.match(r.body.error ?? '', /tip can't be read from the remote/);
    assert.ok(existsSync(stopFile(w.f)));
  } finally {
    await d.close();
  }
});

test('resume (#776): a timed-out read of main leaves nothing running: git and everything it started (the transport, its children) are killed', async () => {
  const w = world();
  await w.watch(2);
  // The transport stand-in records its own pid and its child's, then waits on the child, as a hung connection would.
  const pids = join(w.f.base, 'upload-pack.pids');
  const script = join(w.f.base, 'hang-upload-pack-tree');
  writeFileSync(script, `#!/bin/sh\necho $$ >> '${pids}'\nsleep 30 &\necho $! >> '${pids}'\nwait\n`);
  chmodSync(script, 0o755);
  git(w.f.repo, 'config', 'remote.origin.uploadpack', script);
  assert.equal(await remoteTip(w.f.repo, 'origin', 'main', { timeoutMs: 1000 }), null, 'timed out: unreadable');
  const started = readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.equal(started.length, 2, 'the transport and its child had started');
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Killed processes are reaped by their new parent shortly after; give it a moment.
  for (let i = 0; i < 20 && started.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  const left = started.filter(alive);
  for (const pid of left) process.kill(pid, 'SIGKILL'); // never leave them behind, even when the test fails
  assert.deepEqual(left, [], 'no descendant of git survives the timeout');
});

test('resume (#776): characters that print as blanks (Hangul fillers, the braille blank, other default-ignorables) never count toward the minimum', () => {
  for (const [what, ch] of [['U+3164', 'ㅤ'], ['U+115F', 'ᅟ'], ['U+1160', 'ᅠ'], ['U+FFA0', 'ﾠ'], ['U+2800', '⠀']] as const) {
    assert.ok('error' in acknowledgement({ acknowledge: { reason: ch.repeat(12) } }), `${what} alone is refused`);
    assert.ok('error' in acknowledgement({ acknowledge: { reason: `abc${ch.repeat(9)}` } }), `${what} padding 3 letters is refused`);
  }
  assert.deepEqual(acknowledgement({ acknowledge: { reason: '한국어로 된 이유를 적습니다' } }), { reason: '한국어로 된 이유를 적습니다' }, 'real Hangul counts');
});

test('resume (#776): a red-main stop with main still red refuses on the dashboard, and is recorded; once main is green on its tip it resumes', async () => {
  const w = world();
  await w.watch(2);
  const tip = redMainStop(w);
  assert.equal((JSON.parse(readFileSync(stopFile(w.f), 'utf8')) as { by: string }).by, 'red_main', 'why it stopped is recorded');
  assert.equal(of<EventPayload<'merge.stopped'>>(w.f, 'merge.stopped').at(-1)!.by, 'red_main');
  w.f.backlog.setChecks(tip, failing(7));
  const { d, resume } = await resumeDashboard(w);
  try {
    const refused = await resume();
    assert.equal(refused.status, 409);
    assert.equal(refused.body.needsAck, true);
    assert.match(refused.body.error ?? '', /not all green \(ci: fail\)/);
    assert.ok(existsSync(stopFile(w.f)), 'still stopped');
    assert.equal(of(w.f, 'merge.resumed').length, 0);
    const audit = of<EventPayload<'dashboard.audit'>>(w.f, 'dashboard.audit').at(-1)!;
    assert.equal(audit.action, 'auto_merge.resume_refused');
    assert.equal(audit.login, 'example-owner');
    // Still pending on the tip: not green either.
    w.f.backlog.setChecks(tip, [{ name: 'ci', source: 'check_run', status: 'in_progress', conclusion: null, id: 8 }]);
    assert.equal((await resume()).status, 409);
    // Green on the tip, measured now: it resumes, and says so.
    w.f.backlog.setChecks(tip, passing);
    const ok = await resume();
    assert.equal(ok.status, 200);
    assert.equal(ok.body.how, 'green');
    assert.ok(!existsSync(stopFile(w.f)));
    assert.match(of<EventPayload<'merge.resumed'>>(w.f, 'merge.resumed').at(-1)!.detail, new RegExp(`^@example-owner cleared the stop on the dashboard, with the default branch green on ${tip.slice(0, 8)}`));
    assert.equal(w.c.autoMergeStopped(), null);
  } finally {
    await d.close();
  }
});

test('resume (#776): with main still red, an explicit acknowledgement (a typed reason) resumes and records who, why and what main was; no reason, or a short one, is refused', async () => {
  const w = world();
  await w.watch(2);
  const tip = redMainStop(w);
  w.f.backlog.setChecks(tip, failing(9));
  const { d, resume } = await resumeDashboard(w);
  try {
    assert.equal((await resume({ acknowledge: true })).status, 400, 'no typed reason');
    assert.equal((await resume({ acknowledge: { reason: 'ok' } })).status, 400, 'too short');
    assert.equal((await resume({ acknowledge: { reason: 'the fix PR is ready; merging it needs auto-merge' } }, 'example-collaborator')).status, 403, 'a writer may not, acknowledged or not');
    assert.ok(existsSync(stopFile(w.f)));
    const ok = await resume({ acknowledge: { reason: 'the fix PR is ready; merging it needs auto-merge' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.how, 'acknowledged');
    assert.ok(!existsSync(stopFile(w.f)));
    const resumed = f776Last(w, 'merge.resumed');
    assert.equal(resumed.actor, 'example-owner');
    assert.match((resumed.payload as EventPayload<'merge.resumed'>).detail, /^@example-owner cleared the stop on the dashboard, acknowledging the default branch isn't green \(.*ci: fail.*\): "the fix PR is ready; merging it needs auto-merge"/);
    const audit = of<EventPayload<'dashboard.audit'>>(w.f, 'dashboard.audit').at(-1)!;
    assert.equal(audit.action, 'auto_merge.cleared');
    assert.equal(audit.detail.how, 'acknowledged');
    assert.equal(audit.detail.acknowledged, 'the fix PR is ready; merging it needs auto-merge');
    assert.deepEqual((audit.detail.main as { tip: string; green: boolean }).green, false);
    assert.equal((audit.detail.main as { tip: string }).tip, tip);
  } finally {
    await d.close();
  }
});

test('resume (#776): an acknowledgement is a readable typed reason: control and format characters are refused, and only visible characters count toward the minimum', async () => {
  const refused = {
    'zero-width spaces': '​'.repeat(12),
    'word joiners': '⁠'.repeat(12),
    'one letter and combining marks': `a${'́'.repeat(12)}`,
    'a bidi override': '‮evitcepsorter si siht ok',
    'NULs': '\u0000'.repeat(12),
    'terminal escapes': '\u001b[2J\u001b[31mmain is fine, resume',
    'a zero-width space inside a real reason': 'the fix PR​ is ready to merge',
    'spaces only': ' '.repeat(20),
    'no-break spaces only': ' '.repeat(20),
    'nine visible characters': 'a b c d e f g h i',
  };
  for (const [what, reason] of Object.entries(refused)) assert.ok('error' in acknowledgement({ acknowledge: { reason } }), `${what} is refused`);
  // Accented letters (composed or not), newlines folded: accepted, stored as typed, whitespace folded.
  const ok = acknowledgement({ acknowledge: { reason: 'Le correctif était\nprêt à fusionner' } });
  assert.deepEqual(ok, { reason: 'Le correctif était prêt à fusionner' });
  // Through the route: refused with 400, nothing written raw into the log.
  const w = world();
  await w.watch(2);
  const tip = redMainStop(w);
  w.f.backlog.setChecks(tip, failing(10));
  const { d, resume } = await resumeDashboard(w);
  try {
    for (const reason of [refused['terminal escapes'], refused['zero-width spaces']]) assert.equal((await resume({ acknowledge: { reason } })).status, 400);
    assert.ok(existsSync(stopFile(w.f)));
    assert.ok(!w.f.log.read(0).some((e) => JSON.stringify(e.payload).includes('\\u001b')), 'no escape in the log');
  } finally {
    await d.close();
  }
});

test("resume (#776): fail closed: the main watch's stop, a stop with no `by`, an unreadable one, no required checks and a tip that can't be read all wait; only another kind of stop resumes as before", async () => {
  const w = world();
  await w.watch(2);
  w.commit('direct.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(4);
  assert.equal((JSON.parse(readFileSync(stopFile(w.f), 'utf8')) as { by: string }).by, 'main_watch');
  // The direct push's tip has no checks at all: missing is not green.
  const { d, resume } = await resumeDashboard(w);
  try {
    const r = await resume();
    assert.equal(r.status, 409);
    assert.match(r.body.error ?? '', /ci: missing/);
    // Someone with file access rewrites the stop with no `by`, then unreadable: both still wait (the last merge.stopped is the main watch's).
    writeFileSync(stopFile(w.f), JSON.stringify({ reason: 'edited' }));
    assert.equal((await resume()).status, 409);
    writeFileSync(stopFile(w.f), '{not json');
    assert.equal((await resume()).status, 409);
    // Rewriting `by` to a kind that resumes as before doesn't help either: the log's last stop is the main watch's.
    writeFileSync(stopFile(w.f), JSON.stringify({ reason: 'edited', by: 'owner' }));
    assert.equal((await resume()).status, 409);
    assert.ok(existsSync(stopFile(w.f)));
  } finally {
    await d.close();
  }
  // No required checks configured: nothing measures main green.
  const none = structuredClone(w.f.cfg);
  none.project.required_checks = [];
  w.f.backlog.setChecks(git(w.f.remote, 'rev-parse', 'main'), passing);
  writeFileSync(stopFile(w.f), JSON.stringify({ reason: 'main watch: x', by: 'main_watch' }));
  const n = await resumeDashboard(w, none);
  try {
    const r = await n.resume();
    assert.equal(r.status, 409);
    assert.match(r.body.error ?? '', /no required checks are configured/);
  } finally {
    await n.d.close();
  }
  // A tip that can't be read (or isn't a sha), and checks that can't be read: not green.
  const checks = async () => passing;
  assert.equal((await measureMain({ branch: 'main', required: ['ci'], tip: () => null, checks })).green, false);
  assert.equal((await measureMain({ branch: 'main', required: ['ci'], tip: () => 'refs/heads/main', checks })).green, false);
  assert.equal((await measureMain({ branch: 'main', required: ['ci'], tip: () => { throw new Error('ls-remote failed'); }, checks })).green, false);
  const unreadable = await measureMain({ branch: 'main', required: ['ci'], tip: () => 'a'.repeat(40), checks: async () => { throw new Error('HTTP 502'); } });
  assert.equal(unreadable.green, false);
  assert.match(!unreadable.green ? unreadable.why : '', /can't be read \(HTTP 502\)/);
  assert.equal((await measureMain({ branch: 'main', required: ['ci'], tip: () => 'a'.repeat(40), checks })).green, true, 'control');
  // A stop that isn't the default branch's (an owner's, with no merge.stopped of the branch's last), with main red: as before.
  w.f.log.append('merge.resumed', { detail: 'test: an earlier resume' }, 'example-owner', 'human');
  writeFileSync(stopFile(w.f), JSON.stringify({ reason: 'paused by the owner', by: 'owner' }));
  w.f.backlog.setChecks(git(w.f.remote, 'rev-parse', 'main'), failing(3));
  const o = await resumeDashboard(w);
  try {
    const r = await o.resume();
    assert.equal(r.status, 200);
    assert.equal(r.body.how, 'as_before');
  } finally {
    await o.d.close();
  }
});

test('resume (#776): a stop changed while main is measured is not resumed: the new stop stands', async () => {
  const w = world();
  await w.watch(2);
  const tip = redMainStop(w);
  w.f.backlog.setChecks(tip, passing);
  const r = await clearAutoMergeStop({
    stateDir: w.f.stateDir,
    eventsDb: join(w.f.base, 'events.db'),
    by: 'example-owner',
    measure: async () => {
      // The main watch stops auto-merge again for a new commit while the resume reads main.
      writeFileSync(stopFile(w.f), JSON.stringify({ reason: 'main watch: a newer commit', by: 'main_watch', sha: 'b'.repeat(40) }));
      return { green: true, tip };
    },
  });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /the stop changed/);
  assert.match(readFileSync(stopFile(w.f), 'utf8'), /a newer commit/);
  assert.equal(of(w.f, 'merge.resumed').length, 0);
});

test("resume (#776): the dashboard reads main's tip from the remote now: a fetch that fails while the clone's last-fetched main is green refuses (fail closed)", async () => {
  const w = world();
  await w.watch(2); // the clone's refs/remotes/origin/main is main's tip now
  const stale = git(w.f.repo, 'rev-parse', 'refs/remotes/origin/main');
  w.f.backlog.setChecks(stale, passing);
  // Main moves on and goes red; the clone hasn't fetched it.
  const tip = w.commit('red.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  w.f.backlog.setChecks(tip, failing(5));
  redMainStop(w);
  assert.equal(git(w.f.repo, 'rev-parse', 'refs/remotes/origin/main'), stale, 'the clone still has the old, green main');
  // Then the remote can't be reached (network, auth): nothing can say what main's tip is now.
  git(w.f.repo, 'remote', 'set-url', 'origin', join(w.f.base, 'unreachable.git'));
  const { d, resume } = await resumeDashboard(w);
  try {
    const r = await resume();
    assert.equal(r.status, 409, 'the stale green tip is never measured as main now');
    assert.match(r.body.error ?? '', /tip can't be read from the remote/);
    assert.ok(existsSync(stopFile(w.f)));
  } finally {
    await d.close();
  }
});

test('resume (#776): every stop is logged before its file is written, so no stop file exists without its merge.stopped', async () => {
  const w = world();
  await w.watch(2);
  const seen: boolean[] = [];
  const c = w.c as unknown as { emit(type: string, p: unknown): unknown };
  const emit = c.emit.bind(c);
  c.emit = (type, p) => {
    if (type === 'merge.stopped') seen.push(existsSync(stopFile(w.f)));
    return emit(type, p);
  };
  redMainStop(w); // fix-forward's stop
  unlinkSync(stopFile(w.f));
  w.f.backlog.setChecks(git(w.f.remote, 'rev-parse', 'main'), failing(6));
  await watchMerges(w); // written back
  unlinkSync(stopFile(w.f));
  w.f.log.append('merge.resumed', { detail: 'test: an earlier resume' }, 'example-owner', 'human');
  w.commit('direct.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(4); // the main watch's stop
  assert.equal(seen.length, 3, 'three stops');
  assert.deepEqual(seen, [false, false, false], 'each logged before its file exists');
  assert.ok(existsSync(stopFile(w.f)));
});

test('resume (#776): a stop file deleted by hand while main is still red is written back (same rule as the dashboard); with main green on its tip it resumes', async () => {
  const w = world();
  await w.watch(2);
  const tip = redMainStop(w);
  w.f.backlog.setChecks(tip, failing(4));
  unlinkSync(stopFile(w.f));
  // Before the coordinator's next look at main (a merge step runs before it in a tick), the stop still holds.
  assert.match(w.c.autoMergeStopped() ?? '', /deleted by hand; auto-merge stays stopped until main is measured green/);
  await watchMerges(w);
  assert.ok(existsSync(stopFile(w.f)), 'written back');
  const back = JSON.parse(readFileSync(stopFile(w.f), 'utf8')) as { by: string; reason: string; restored: string };
  assert.equal(back.by, 'red_main');
  assert.match(back.reason, /required checks failed/);
  assert.match(back.restored, /deleted by hand while .*not all green \(ci: fail\).*acknowledgement/);
  assert.match(of<EventPayload<'merge.stopped'>>(w.f, 'merge.stopped').at(-1)!.restored ?? '', /deleted by hand/);
  assert.equal(of(w.f, 'merge.resumed').length, 0, 'not resumed');
  assert.notEqual(w.c.autoMergeStopped(), null);
  // Again on the next pass: nothing more (the stop is in force).
  await watchMerges(w);
  assert.equal(of(w.f, 'merge.stopped').length, 2);
  // Main green on its tip: a hand deletion resumes, as before, and says main was green.
  w.f.backlog.setChecks(tip, passing);
  unlinkSync(stopFile(w.f));
  await watchMerges(w);
  assert.ok(!existsSync(stopFile(w.f)));
  assert.match(of<EventPayload<'merge.resumed'>>(w.f, 'merge.resumed').at(-1)!.detail, new RegExp(`by hand, with main green on ${tip.slice(0, 8)}`));
  assert.equal(w.c.autoMergeStopped(), null);
});

test("resume (#776): the main watch's stop deleted by hand comes back as the main watch's (its alert stays); a dashboard resume logged while main is measured is never undone", async () => {
  const w = world();
  await w.watch(2);
  w.commit('direct.txt');
  git(w.person, 'push', '-q', 'origin', 'main');
  await w.watch(4);
  unlinkSync(stopFile(w.f));
  await watchMerges(w);
  assert.equal((JSON.parse(readFileSync(stopFile(w.f), 'utf8')) as { by: string }).by, 'main_watch');
  assert.ok(protectionState({ stateDir: w.f.stateDir, repo: w.f.cfg.project.project.repo, events: w.f.log.read(0), role: 'owner' }).alert, 'the alert (and its resume) still shows');
  // The dashboard's acknowledged resume: the file goes, then merge.resumed is logged. A coordinator pass that sees the
  // file gone first, and the resume logged while it measures main, leaves it resumed.
  const c = w.c as unknown as { headChecksOf(sha: string): Promise<unknown> };
  const read = c.headChecksOf.bind(c);
  c.headChecksOf = async (sha) => {
    w.f.log.append('merge.resumed', { detail: '@example-owner cleared the stop on the dashboard, acknowledging ...' }, 'example-owner', 'human');
    return read(sha);
  };
  unlinkSync(stopFile(w.f));
  await watchMerges(w);
  assert.ok(!existsSync(stopFile(w.f)), 'the acknowledged resume stands');
  assert.equal(w.c.autoMergeStopped(), null);
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
  // A restart, then an admin clears the stop. Precondition (#776): main is green on its tip, measured on the next pass.
  w.restart();
  w.f.backlog.setChecks(git(w.f.remote, 'rev-parse', 'main'), passing);
  unlinkSync(stopFile(w.f));
  await watchMerges(w);
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
  assert.equal(posts(/the required check `ci` has had no run on any commit judged since .* keep tripping the watch until it posts/).length, 1);
  assert.deepEqual(view(), ['ci'], 'on the dashboard');
  await w.watch(3);
  assert.equal(dead().length, 1, 'once');
  assert.equal(posts(/`ci` has had no run/).length, 1, 'posted once');
  await merge('feature/two', true);
  await w.watch(8);
  assert.deepEqual(dead(), [['ci', 'raised'], ['ci', 'cleared']]);
  assert.equal(posts(/`ci` has a run again/).length, 1);
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
  const posts = chat.posts.filter((p) => p.where === OPS_CHANNEL && /required check .ci. has had no run/.test(p.text)).map((p) => p.text);
  return { raised, posts };
}

/** What Discord receives for `text` posted to the ops channel: the adapter's own reply, with a fake fetch. */
async function discordGets(text: string) {
  const sent: { content: string; allowed_mentions: unknown }[] = [];
  const bot = new DiscordIntake({
    token: 'x',
    guild: '555555',
    channels: [],
    allowedSenders: [],
    prefixes: [],
    opsChannel: OPS_CHANNEL,
    fetch: (async (_url: string, init: { body: string }) => (sent.push(JSON.parse(init.body)), new Response('{}'))) as unknown as typeof fetch,
  });
  assert.equal(await bot.reply(OPS_CHANNEL, text), true);
  assert.equal(sent.length, 1);
  return sent[0]!;
}

test('regression: the dead-check ops post names the disabled workflow and its state; without one, it has no workflow sentence', async () => {
  const a = await deadWith([{ name: 'Tests', path: '.github/workflows/ci.yml', state: 'disabled_manually' }]);
  assert.equal(a.raised.length, 1);
  assert.deepEqual(a.posts, [
    `Main watch: the required check \`ci\` has had no run on any commit judged since ${a.raised[0]!.since}. Its workflow \`Tests\` (\`.github/workflows/ci.yml\`) is disabled on GitHub (\`disabled_manually\`), so it can't post the check until someone enables it again. Merges into main keep tripping the watch until it posts, or until it leaves required_checks in config.yaml.`,
  ]);
  const b = await deadWith([]);
  assert.equal(b.raised[0]!.workflow, undefined);
  assert.deepEqual(b.posts, [`Main watch: the required check \`ci\` has had no run on any commit judged since ${b.raised[0]!.since}. Merges into main keep tripping the watch until it posts, or until it leaves required_checks in config.yaml.`], 'no workflow sentence');
});

test('regression: a hostile workflow name in the dead-check ops post is inert: no mention, link or markdown outside a code span', async () => {
  const name = '@everyone [x](http://evil.example/a) `**b**` <@123>';
  const a = await deadWith([{ name, path: '.github/workflows/ci.yml', state: 'disabled_inactivity' }]);
  assert.equal(a.raised[0]!.workflow?.name, name, 'the event keeps the name; only the post neutralizes it');
  assert.equal(a.posts.length, 1);
  const post = a.posts[0]!;
  // The name is one code span (its own backticks replaced, so it can't close the span): Discord renders nothing in it.
  const spans = [...post.matchAll(/`([^`]*)`/g)].map((x) => x[1]);
  assert.deepEqual(spans, ['ci', "@everyone [x](http://evil.example/a) '**b**' <@123>", '.github/workflows/ci.yml', 'disabled_inactivity']);
  assert.doesNotMatch(post.replace(/`[^`]*`/g, ''), /@everyone|<@|\]\(|\*\*|evil\.example/, 'nothing of the name outside its code span');
});

test('regression: a 200-character workflow name and a 200-character hostile path keep their code spans whole after Discord cuts the post to 500 characters', async () => {
  const name = `@everyone **n** ${'n'.repeat(240)}`;
  const hostile = 'x **bold** ||spoiler|| <#123456789012345678> <t:1:R> <@&123456789012345678> [l](https://evil.example/a) ';
  const path = `.github/workflows/${hostile}${'p'.repeat(120)}/ci.yml`;
  const list: WorkflowAt[] = [{ name, path, state: 'disabled_manually' }];
  const recorded = disabledWorkflowFor('ci', list, () => null);
  assert.deepEqual([recorded?.name.length, recorded?.path.length], [200, 200], 'both clipped to 200 by disabledWorkflowFor');
  const a = await deadWith(list);
  assert.deepEqual(a.raised[0]!.workflow, recorded, 'the watch records what disabledWorkflowFor gives');
  assert.equal(a.posts.length, 1);
  assert.ok(a.posts[0]!.length > REPLY_CHARS, `the built post is longer than Discord's cut: ${a.posts[0]!.length}`);
  const got = await discordGets(a.posts[0]!);
  const ticks = (got.content.match(/`/g) ?? []).length;
  assert.ok(got.content.length <= REPLY_CHARS);
  assert.equal(ticks % 2, 0, `backticks: ${ticks}: ${got.content}`);
  const outside = got.content.replace(/`[^`]*`/g, '');
  assert.doesNotMatch(outside, /@everyone|<[@#t]|\]\(|\*\*|\|\||evil\.example/, `nothing hostile outside a span: ${outside}`);
  assert.ok(got.content.includes(`\`@everyone **n** ${'n'.repeat(20)}`), 'the name is still there, whole, as one span');
  assert.deepEqual(got.allowed_mentions, { parse: [] }, 'and it pings nobody');
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
  assert.equal(chat.posts.filter((p) => p.where === OPS_CHANNEL && /`ci` has had no run/.test(p.text)).length, 1);
  assert.equal(w.gh.calls.filter((c) => c === 'workflows').length, 1);
  assert.equal(of(w.f, 'merge.stopped').length, 1, 'the stop as before');
});
