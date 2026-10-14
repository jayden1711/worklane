// The machine watchdog (src/watchdog/): every trigger raises its incident once and resolves it once; posts are
// rate-limited, carry no secret and link to the incident on the Health page; one coordinator posts per machine;
// GET /api/health/incidents gives a viewer the allowlisted fields only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { StoredEvent } from '../src/events/types.js';
import type { UnitState } from '../src/os/stats.js';
import { parseUnitState, unitStates } from '../src/os/stats.js';
import { which } from '../src/os/index.js';
import { GITHUB_UNREACHABLE_PASSES, unitFindings } from '../src/watchdog/probes.js';
import { mintInstallationToken } from '../src/github-app.js';
import { isNetworkFailure } from '../src/github/errors.js';
import { githubOkAt } from '../src/github/seen.js';
import { GitHubBacklog } from '../src/backlog/github.js';
import type { UpdateEntry } from '../src/updates.js';
import { KINDS, raiseIncident, readIncidents, resolveIncident, REOPEN_MS, healthStatus } from '../src/watchdog/incidents.js';
import { incidentSink } from '../src/watchdog/wire.js';
import { USAGE_INCIDENT } from '../src/usage-limit.js';
import { postPending, RATE, scrub, takeOpsPost } from '../src/watchdog/post.js';
import { Watchdog, type WatchdogDeps } from '../src/watchdog/watchdog.js';
import { watchdogConfig } from '../src/watchdog/config.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { VIEWER_INCIDENT_FIELDS } from '../src/viewer-events.js';
import { IntakeConfig } from '../src/intake/report.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const DASH = 'https://dash.example.test';
// Planted fakes, in a Discord bot token's shape: assembled at run time so no token-shaped literal is committed.
const BOT_TOKEN = [`MTAx${'MjM0NTY3ODkw'.repeat(2)}`, 'GhIjKl', `${'abcdefghij'.repeat(3)}AB`].join('.');
const GH_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

let nextId = 1;
const ev = (type: string, payload: Record<string, unknown>, ts: string): StoredEvent => ({ id: nextId++, ts, type, actor: 'c', source: 'coordinator', payload } as unknown as StoredEvent);

/** A world the watchdog reads, every part of it changeable between passes, and every post it made. */
function world(o: { instance?: string; dir?: string; poster?: boolean } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'watchdog-'));
  const w = {
    dir,
    now: new Date('2026-10-13T12:00:00Z'),
    events: [] as StoredEvent[],
    stop: null as { reason: string; by: string | null } | null,
    emergency: false,
    auth: { loggedIn: true } as { loggedIn: boolean; expiresAt?: string | null } | null,
    tokenError: null as string | null,
    units: [] as UnitState[],
    updates: [] as UpdateEntry[],
    disks: [{ path: '/srv', usedPct: 40, freeGb: 120 }],
    posts: [] as string[],
    postOk: true,
  };
  const deps: WatchdogDeps = {
    instance: o.instance ?? 'alpha',
    dir,
    events: () => w.events,
    stop: () => w.stop,
    emergency: () => w.emergency,
    auth: () => w.auth,
    githubToken: async () => {
      if (w.tokenError) throw new Error(w.tokenError);
      return 'token';
    },
    instances: () => ['alpha', 'beta'],
    units: () => w.units,
    updates: () => w.updates,
    disks: () => w.disks,
    config: () => ({ stallHours: 6, diskPct: 85, opsChannel: null, dashboardUrl: null, minFreeGb: 10, minFreePct: 5 }),
    poster: () =>
      o.poster === false
        ? null
        : {
            poster: async (c: string) => {
              if (!w.postOk) return false;
              w.posts.push(c);
              return true;
            },
            dashboardUrl: DASH,
            secrets: [BOT_TOKEN],
          },
    now: () => w.now,
  };
  const dog = new Watchdog(deps);
  /** One pass, later than the last (past the auth re-check and the rate window, so only the trigger decides). */
  const pass = async (minutes = 31) => {
    w.now = new Date(w.now.getTime() + minutes * 60_000);
    await dog.pass();
  };
  return { w, dog, pass, deps };
}

const unit = (name: string, active: string, sub: string, restarts: number): UnitState => ({ unit: name, loadState: 'loaded', activeState: active, subState: sub, restarts });
const coord = `${BRAND.cli}-alpha.service`;
const hubUnit = `${BRAND.cli}-dashboard-hub.service`;

/** Each trigger: how to make it true, and how to make it false again. */
const TRIGGERS: { kind: string; key: string; instance: string | null; bad: (w: ReturnType<typeof world>['w']) => void; good: (w: ReturnType<typeof world>['w']) => void }[] = [
  { kind: 'unit_down', key: hubUnit, instance: null, bad: (w) => (w.units = [unit(hubUnit, 'failed', 'failed', 5)]), good: (w) => (w.units = [unit(hubUnit, 'active', 'running', 5)]) },
  {
    kind: 'crash_loop',
    key: coord,
    instance: 'alpha',
    bad: (w) => {
      const r = w.units[0]?.restarts ?? 0;
      w.units = [unit(coord, 'activating', 'auto-restart', r + 4)];
    },
    // Up again, and no restart since: the restarts age out of the window.
    good: (w) => (w.units = [unit(coord, 'active', 'running', w.units[0]?.restarts ?? 0)]),
  },
  {
    kind: 'update_rollback',
    key: 'b'.repeat(12),
    instance: null,
    bad: (w) => (w.updates = [{ at: w.now.toISOString(), event: 'rolled_back', from: 'b'.repeat(40), back: 'a'.repeat(40), held: true, reason: 'instance alpha failed to come up' }]),
    good: (w) => w.updates.push({ at: w.now.toISOString(), event: 'installed', from: 'a'.repeat(40), to: 'c'.repeat(40) }),
  },
  { kind: 'disk_full', key: '/srv', instance: null, bad: (w) => (w.disks = [{ path: '/srv', usedPct: 91, freeGb: 9 }]), good: (w) => (w.disks = [{ path: '/srv', usedPct: 60, freeGb: 80 }]) },
  { kind: 'claude_auth', key: 'alpha', instance: 'alpha', bad: (w) => (w.auth = { loggedIn: false }), good: (w) => (w.auth = { loggedIn: true }) },
  {
    kind: 'claude_auth',
    key: 'alpha',
    instance: 'alpha',
    bad: (w) => w.events.push(ev('run.finished', { issue: 1, role: 'worker', reason: 'auth_mismatch', detail: 'logged in as another account' }, w.now.toISOString())),
    good: (w) => w.events.push(ev('run.finished', { issue: 1, role: 'worker', reason: 'succeeded', detail: '' }, w.now.toISOString())),
  },
  {
    kind: 'claude_login_expiring',
    key: 'alpha',
    instance: 'alpha',
    bad: (w) => (w.auth = { loggedIn: true, expiresAt: new Date(w.now.getTime() + 2 * 86_400_000).toISOString() }),
    good: (w) => (w.auth = { loggedIn: true, expiresAt: new Date(w.now.getTime() + 300 * 86_400_000).toISOString() }),
  },
  { kind: 'github_auth', key: 'alpha', instance: 'alpha', bad: (w) => (w.tokenError = 'the App installation was suspended'), good: (w) => (w.tokenError = null) },
  {
    kind: 'github_auth',
    key: 'alpha:checks',
    instance: 'alpha',
    bad: (w) => w.events.push(ev('testrun.checks_permission', { level: 'read', detail: 'checks: read' }, w.now.toISOString())),
    good: (w) => w.events.push(ev('testrun.checks_permission', { level: 'write', detail: 'checks: write' }, w.now.toISOString())),
  },
  {
    kind: 'stalled',
    key: 'alpha',
    instance: 'alpha',
    bad: (w) => {
      w.events.push(ev('issue.seen', { issue: 7, title: 'Ready work', labels: ['ready'], author: 'x', owner: null, actionable: true, why: '' }, new Date(w.now.getTime() - 8 * 3600_000).toISOString()));
    },
    good: (w) => w.events.push(ev('issue.claimed', { issue: 7, instance: 'alpha', lease: 'a'.repeat(40), base: 'a'.repeat(40), owner: 'x' }, w.now.toISOString())),
  },
  {
    kind: 'auto_merge_stopped',
    key: 'alpha',
    instance: 'alpha',
    bad: (w) => {
      w.events.push(ev('main_watch.unaccounted', { sha: 'd'.repeat(40), url: 'https://example.test/c', reason: 'a direct push', number: null, revert: 'https://example.test/pull/9' }, w.now.toISOString()));
      w.stop = { reason: 'an unaccounted commit on main', by: 'main_watch' };
    },
    good: (w) => (w.stop = null),
  },
  {
    kind: 'test_sandbox',
    key: 'alpha',
    instance: 'alpha',
    bad: (w) => w.events.push(ev('testrun.sandbox', { ok: false, detail: 'the test user can read the coordinator home' }, w.now.toISOString())),
    good: (w) => w.events.push(ev('testrun.sandbox', { ok: true, detail: 'ok' }, w.now.toISOString())),
  },
  {
    kind: 'helper_outdated',
    key: 'alpha',
    instance: 'alpha',
    bad: (w) => w.events.push(ev('testrun.helper', { ok: false, have: null, need: 2, detail: 'the test sandbox helper is older than this engine' }, w.now.toISOString())),
    good: (w) => w.events.push(ev('testrun.helper', { ok: true, have: 2, need: 2, detail: '' }, w.now.toISOString())),
  },
];

for (const t of TRIGGERS) {
  test(`trigger ${t.kind} (${t.key}): raised once, posted once, resolved once, posted resolved once`, async () => {
    const { w, pass } = world();
    await pass();
    assert.equal(readIncidents(w.dir).incidents.length, 0, 'nothing before the trigger');
    t.bad(w);
    // Several passes while it stays true: still one incident, one post.
    for (let i = 0; i < 3; i++) {
      if (t.kind === 'crash_loop') t.bad(w);
      await pass(i === 0 ? 31 : 1);
    }
    let all = readIncidents(w.dir).incidents.filter((x) => x.kind === t.kind && x.key === t.key);
    assert.equal(all.length, 1, 'one incident');
    assert.equal(all[0]!.resolvedAt, null, 'open');
    assert.equal(all[0]!.instance, t.instance, 'about the right instance (null: the machine)');
    assert.equal(w.posts.length, 1, 'one post for it');
    assert.match(w.posts[0]!, new RegExp(all[0]!.title));
    t.good(w);
    for (let i = 0; i < 3; i++) await pass(i === 0 ? 20 : 31);
    all = readIncidents(w.dir).incidents.filter((x) => x.kind === t.kind && x.key === t.key);
    assert.equal(all.length, 1, 'still one incident');
    assert.ok(all[0]!.resolvedAt, 'resolved');
    assert.equal(w.posts.length, 2, 'and one resolved post');
    assert.match(w.posts[1]!, /^\*\*Resolved\*\*/);
    assert.equal(readIncidents(w.dir).incidents.length, 1, 'no other incident raised on the way');
  });
}

test('regression: a probe that says signed out raises no claude_auth incident once a run on the login has succeeded since it started saying so', async () => {
  const { w, pass } = world();
  await pass();
  const open = () => readIncidents(w.dir).incidents.filter((x) => x.kind === 'claude_auth' && !x.resolvedAt);
  // The probe says signed out (on the machine: it looked in the coordinator's home), but agents' runs go on working.
  w.auth = { loggedIn: false };
  await pass();
  w.events.push(ev('run.finished', { issue: 1, role: 'worker', reason: 'succeeded', detail: '' }, new Date(w.now.getTime() + 5 * 60_000).toISOString()));
  await pass(10);
  assert.equal(open().length, 0, 'a run that worked since the probe says the login works');
  // Probe after probe still says so: no incident while the run that worked came after the first of them.
  for (let i = 0; i < 3; i++) await pass();
  assert.equal(open().length, 0, 'still none');
  // Signed in again, then signed out with no run working since: that one raises.
  w.auth = { loggedIn: true };
  await pass();
  w.auth = { loggedIn: false };
  await pass();
  assert.equal(open().length, 1, 'a probe with no run working since it still raises');
});

test('raiseIncident dedupes an open incident, resolveIncident closes it once, and a quick relapse reopens the same one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  const now = new Date('2026-10-13T00:00:00Z');
  const a = raiseIncident('canary_failed', 'abc', 'the canary did not merge', 'look at the canary PR', { dir, now });
  const b = raiseIncident('canary_failed', 'abc', 'still failing', 'look at the canary PR', { dir, now: new Date(now.getTime() + 60_000) });
  assert.ok(a.opened && !b.opened);
  assert.equal(a.incident.id, b.incident.id);
  assert.equal(readIncidents(dir).incidents[0]!.detail, 'still failing');
  assert.ok(resolveIncident('canary_failed', 'abc', { dir, now }));
  assert.equal(resolveIncident('canary_failed', 'abc', { dir, now }), null, 'resolved once');
  const c = raiseIncident('canary_failed', 'abc', 'again', 'fix', { dir, now: new Date(now.getTime() + REOPEN_MS / 2) });
  assert.equal(c.incident.id, a.incident.id, 'reopened, not a new incident');
  resolveIncident('canary_failed', 'abc', { dir, now: new Date(now.getTime() + REOPEN_MS) });
  const d = raiseIncident('canary_failed', 'abc', 'much later', 'fix', { dir, now: new Date(now.getTime() + 3 * REOPEN_MS) });
  assert.notEqual(d.incident.id, a.incident.id, 'a new incident once the old one has stayed resolved');
  assert.equal(healthStatus(readIncidents(dir).incidents, 'alpha'), 'amber', 'an unknown kind is amber');
});

test(`posts are rate-limited to ${RATE.max} per ${RATE.windowMs / 60_000} min machine-wide, the rest wait in order; a failed post is tried again`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  let now = new Date('2026-10-13T00:00:00Z');
  for (let i = 0; i < RATE.max + 3; i++) raiseIncident('disk_full', `/d${i}`, `disk ${i}`, 'free space', { dir, now: new Date(now.getTime() + i) });
  const posts: string[] = [];
  let ok = true;
  const poster = async (c: string) => (ok ? (posts.push(c), true) : false);
  const r1 = await postPending({ poster, dir, now: () => now });
  assert.equal(r1.posted, RATE.max);
  assert.equal(r1.waiting, 3);
  assert.deepEqual(posts.map((p) => /disk (\d+)/.exec(p)![1]), ['0', '1', '2', '3', '4'], 'oldest first');
  now = new Date(now.getTime() + 60_000);
  assert.equal((await postPending({ poster, dir, now: () => now })).posted, 0, 'still inside the window');
  now = new Date(now.getTime() + RATE.windowMs);
  ok = false;
  assert.equal((await postPending({ poster, dir, now: () => now })).posted, 0, 'Discord refused');
  ok = true;
  assert.equal((await postPending({ poster, dir, now: () => now })).posted, 3, 'the rest, once the window passed');
  assert.equal(posts.length, RATE.max + 3, 'each incident posted once');
  assert.equal((await postPending({ poster, dir, now: () => new Date(now.getTime() + 3 * RATE.windowMs) })).posted, 0, 'nothing posted twice');
});

test('one ops-post limit for every caller (takeOpsPost): the direct-push alert (a Date or none), merge and fix-forward posts (epoch ms) and the incident posts share one window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  const t0 = Date.parse('2026-10-13T00:00:00Z');
  // Two incident posts first: they count toward the same window.
  for (let i = 0; i < 2; i++) raiseIncident('disk_full', `/s${i}`, `disk ${i}`, 'free space', { dir, now: new Date(t0 + i) });
  assert.equal((await postPending({ poster: async () => true, dir, now: () => new Date(t0) })).posted, 2);
  // The direct-push alert's call (a Date), and the merge posts' and fix-forward's (epoch ms), take what is left.
  assert.equal(takeOpsPost({ dir, now: new Date(t0 + 1000) }), true);
  assert.equal(takeOpsPost({ dir, now: t0 + 2000 }), true);
  assert.equal(takeOpsPost({ dir, now: t0 + 3000 }), true);
  assert.equal(RATE.max, 5);
  assert.equal(takeOpsPost({ dir, now: new Date(t0 + 4000) }), false, 'the window is full, for a Date caller');
  assert.equal(takeOpsPost({ dir, now: t0 + 4000 }), false, 'and for an epoch caller');
  raiseIncident('disk_full', '/s9', 'disk 9', 'free space', { dir, now: new Date(t0 + 5000) });
  assert.equal((await postPending({ poster: async () => true, dir, now: () => new Date(t0 + 5000) })).posted, 0, 'the incident posts wait too');
  // A window later, every caller may post again.
  assert.equal(takeOpsPost({ dir, now: t0 + RATE.windowMs + 1 }), true);
  assert.equal(takeOpsPost({ dir, now: new Date(t0 + RATE.windowMs + 2) }), true);
  // No `now`: the current time (the direct-push alert's call).
  const fresh = mkdtempSync(join(tmpdir(), 'incidents-'));
  assert.equal(takeOpsPost({ dir: fresh }), true);
  assert.equal(readIncidents(fresh).posts.length, 1);
});

test('an incident resolved before it was ever posted is not posted at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  const now = new Date('2026-10-13T00:00:00Z');
  raiseIncident('disk_full', '/x', 'full', 'free space', { dir, now });
  resolveIncident('disk_full', '/x', { dir, now });
  const posts: string[] = [];
  await postPending({ poster: async (c) => (posts.push(c), true), dir, now: () => now });
  assert.deepEqual(posts, []);
});

test('no secret reaches a post or the store: a planted GitHub token and the bot token are taken out', async () => {
  const { w, pass } = world();
  w.tokenError = `minting failed for Bearer ${GH_TOKEN} with bot ${BOT_TOKEN}`;
  w.updates = [{ at: w.now.toISOString(), event: 'rolled_back', from: 'b'.repeat(40), held: true, reason: `env had DISCORD_TOKEN=${BOT_TOKEN} and GH=${GH_TOKEN}` }];
  await pass();
  assert.equal(w.posts.length, 2);
  for (const p of w.posts) {
    assert.ok(!p.includes(GH_TOKEN), 'no GitHub token in the post');
    assert.ok(!p.includes(BOT_TOKEN), 'no bot token in the post');
    assert.match(p, /REDACTED/);
  }
  const stored = readFileSync(join(w.dir, 'incidents.json'), 'utf8');
  assert.ok(!stored.includes(GH_TOKEN) && !stored.includes(BOT_TOKEN), 'nor in the store');
  assert.equal(scrub(`a ${'x'.repeat(9)} b`, ['x'.repeat(9)]), 'a [REDACTED] b', 'a given secret is taken out wherever it is');
});

test('each post links straight to its incident on the Health page; the resolved post links to the same place', async () => {
  const { w, pass } = world();
  w.disks = [{ path: '/srv', usedPct: 95, freeGb: 2 }];
  await pass();
  const x = readIncidents(w.dir).incidents[0]!;
  assert.ok(w.posts[0]!.includes(`${DASH}/health#incident-${x.id}`), w.posts[0]);
  assert.match(w.posts[0]!, /Fix: /);
  w.disks = [{ path: '/srv', usedPct: 50, freeGb: 200 }];
  await pass();
  assert.ok(w.posts[1]!.includes(`${DASH}/health#incident-${x.id}`), w.posts[1]);
});

test('one poster per machine: of two coordinators, one runs the machine checks and one posts; another takes over when it stops', async () => {
  const a = world({ instance: 'alpha' });
  const b = world({ instance: 'beta', dir: a.w.dir });
  b.w.now = a.w.now;
  a.w.disks = b.w.disks = [{ path: '/srv', usedPct: 99, freeGb: 1 }];
  await a.pass();
  await b.pass();
  assert.deepEqual(a.dog.elected, { machine: true, post: true });
  assert.deepEqual(b.dog.elected, { machine: false, post: false });
  assert.equal(a.w.posts.length + b.w.posts.length, 1, 'posted once, by one of them');
  a.dog.stop();
  b.w.disks = [{ path: '/srv', usedPct: 10, freeGb: 300 }];
  await b.pass();
  assert.deepEqual(b.dog.elected, { machine: true, post: true });
  assert.equal(b.w.posts.length, 1, 'the other took over and posted the resolution');
});

test('a stopping coordinator takes no part in the election: not from a pass under way, nor a later one; a running one takes over', async () => {
  const a = world({ instance: 'alpha' });
  const b = world({ instance: 'beta', dir: a.w.dir });
  b.w.now = a.w.now;
  // b's pass is under way (its GitHub token check is slow) when a stops and frees the machine role.
  await a.pass();
  assert.deepEqual(a.dog.elected, { machine: true, post: true });
  let release!: () => void;
  b.deps.githubToken = () => new Promise<string>((r) => (release = () => r('token')));
  const taken: string[] = [];
  b.deps.log = (l) => taken.push(l);
  const passing = b.pass();
  b.dog.stop();
  a.dog.stop();
  release();
  await passing;
  assert.deepEqual(b.dog.elected, { machine: false, post: false }, 'stopped mid-pass: it never takes the role');
  await b.pass();
  assert.deepEqual(b.dog.elected, { machine: false, post: false }, 'nor on a later pass');
  assert.deepEqual(taken, [], 'and never logs that it runs the machine checks');
  const c = world({ instance: 'gamma', dir: a.w.dir });
  await c.pass();
  assert.deepEqual(c.dog.elected, { machine: true, post: true }, 'a running coordinator takes over');
});

test('a coordinator that can\'t post never holds the post lock', async () => {
  const a = world({ poster: false });
  await a.pass();
  assert.deepEqual(a.dog.elected, { machine: true, post: false });
});

test('unit states parse from systemctl show; an unknown restart count is null, not zero', () => {
  assert.deepEqual(parseUnitState('u.service', 'LoadState=loaded\nActiveState=failed\nSubState=failed\nNRestarts=4\n'), { unit: 'u.service', loadState: 'loaded', activeState: 'failed', subState: 'failed', restarts: 4 });
  assert.equal(parseUnitState('u.service', 'ActiveState=active\nNRestarts=\n').restarts, null);
});

test('unit states from the real systemctl (Linux CI): a running unit is active, one not installed is not-found, so it is never reported down', { skip: process.platform !== 'linux' || !which('systemctl') ? 'needs systemd' : false }, () => {
  const states = unitStates(['systemd-journald.service', `${BRAND.cli}-no-such-instance.service`]);
  if (!states || !states.length || states[0]!.activeState === null) return; // no systemd running here (a container)
  const journald = states.find((s) => s.unit === 'systemd-journald.service')!;
  assert.equal(journald.loadState, 'loaded');
  assert.equal(journald.activeState, 'active');
  assert.equal(typeof journald.restarts, 'number');
  const missing = states.find((s) => s.unit.endsWith('-no-such-instance.service'))!;
  assert.equal(missing.loadState, 'not-found');
  const units = [{ unit: missing.unit, instance: 'x', what: 'x' }];
  assert.deepEqual(unitFindings(states, units, new Map(), Date.now()).findings, [], 'a unit not installed here is not down');
});

test('watchdog.json: valid fields over the defaults, out-of-range ones ignored; intake.yaml ops_channel needs dashboard_url', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-config-'));
  const f = join(dir, 'watchdog.json');
  assert.deepEqual(watchdogConfig(f), { stallHours: 6, diskPct: 85, opsChannel: null, dashboardUrl: null, minFreeGb: 10, minFreePct: 5 });
  writeFileSync(f, JSON.stringify({ stall_hours: 2, disk_pct: 5, ops_channel: '123456789012345678', dashboard_url: 'http://insecure.example', min_free_gb: 0, min_free_pct: 60 }));
  assert.deepEqual(watchdogConfig(f), { stallHours: 2, diskPct: 85, opsChannel: '123456789012345678', dashboardUrl: null, minFreeGb: 10, minFreePct: 5 });
  writeFileSync(f, JSON.stringify({ min_free_gb: 40, min_free_pct: 0 }));
  assert.deepEqual([watchdogConfig(f).minFreeGb, watchdogConfig(f).minFreePct], [40, 0]);
  const base = { version: 1, discord: { enabled: true, guild: '100000000000000001', ops_channel: '100000000000000005' } };
  assert.equal(IntakeConfig.safeParse(base).success, false, 'no dashboard_url: refused');
  assert.equal(IntakeConfig.safeParse({ ...base, discord: { ...base.discord, dashboard_url: DASH } }).success, true);
});

test('GET /api/health/incidents: this instance\'s and the machine\'s incidents with its status; a viewer gets the allowlisted fields only', async () => {
  const slots = mkdtempSync(join(tmpdir(), 'incidents-slots-'));
  raiseIncident('github_auth', 'demo', `refused ${GH_TOKEN}`, 'check the App', { dir: slots, instance: 'demo', tried: ['retried'] });
  raiseIncident('disk_full', '/srv', 'the disk is 93% full', 'free space', { dir: slots, severity: 'red' });
  raiseIncident('stalled', 'other', 'another instance', 'look', { dir: slots, instance: 'other' });
  raiseIncident('claude_login_expiring', 'demo', 'expires soon', 'renew', { dir: slots, instance: 'demo' });
  resolveIncident('claude_login_expiring', 'demo', { dir: slots });
  const { dir: root } = exampleProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'incidents-state-'));
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: slots, instance: 'demo' });
  try {
    const get = async (who: string) => (await fetch(`${d.url.split('/?')[0]}/api/health/incidents`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } })).json() as Promise<{ status: string; open: Record<string, unknown>[]; resolved: Record<string, unknown>[]; detail: boolean }>;
    const owner = await get('example-owner');
    assert.equal(owner.status, 'red');
    assert.deepEqual(owner.open.map((x) => x.kind).sort(), ['disk_full', 'github_auth'], "this instance's and the machine's, never another instance's");
    assert.deepEqual(owner.resolved.map((x) => x.kind), ['claude_login_expiring']);
    assert.equal(owner.detail, true);
    assert.ok(owner.open.every((x) => typeof x.fix === 'string' && typeof x.detail === 'string'));
    assert.ok(!JSON.stringify(owner).includes(GH_TOKEN), 'stored redacted');
    assert.ok(owner.open.every((x) => !('posted' in x)), 'never the post marks');
    const viewer = await get('someone-else');
    assert.equal(viewer.status, 'red');
    assert.equal(viewer.detail, false);
    for (const x of [...viewer.open, ...viewer.resolved]) assert.deepEqual(Object.keys(x).sort(), [...VIEWER_INCIDENT_FIELDS].filter((k) => k in x).sort(), 'allowlisted fields only');
    for (const x of viewer.open) for (const k of ['detail', 'fix', 'tried', 'key']) assert.ok(!(k in x), `no ${k} for a viewer`);
  } finally {
    await d.close();
  }
});

test("the usage-limit pause raises a real incident through the coordinator's sink: its own title, amber, this instance's; resolved when it resumes", () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-usage-'));
  assert.deepEqual(KINDS[USAGE_INCIDENT], { title: 'Claude usage limit reached: runs are paused', severity: 'amber' });
  const sink = incidentSink('demo', dir);
  sink.raiseIncident(USAGE_INCIDENT, 'agent@host', 'Claude usage limit reached; no new runs until 2026-10-13 14:00 UTC (in 2 h 0 min)', 'Nothing to do: it resumes on its own at the reset.');
  const [open] = readIncidents(dir).incidents;
  assert.equal(open?.title, 'Claude usage limit reached: runs are paused');
  assert.equal(open?.severity, 'amber');
  assert.equal(open?.instance, 'demo');
  assert.equal(open?.resolvedAt, null);
  sink.resolveIncident(USAGE_INCIDENT, 'agent@host');
  assert.ok(readIncidents(dir).incidents[0]?.resolvedAt, 'resolved when the pause ends');
  // A store it can't write never throws into the coordinator.
  const bad = join(dir, 'not-a-dir');
  writeFileSync(bad, 'x');
  assert.doesNotThrow(() => incidentSink('demo', bad).raiseIncident(USAGE_INCIDENT, 'k', 'd', 'f'));
});

// ------------------------------------------------------------------ GitHub access: refused vs not reached

// The installation token the stand-in mints: assembled at run time, and asserted absent from everything stored or posted.
const MINTED = `ghs_${'Zy9Xw8Vu7T'.repeat(4)}`;

/** A stand-in GitHub on loopback that answers the App's token mint with `status` (or never answers: 'hang'). */
async function standInGitHub() {
  const state = { status: 201 as number | 'hang', jwts: [] as string[] };
  const server = createServer((req, res) => {
    state.jwts.push(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    req.resume();
    if (state.status === 'hang') return; // never answers
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(state.status === 201 ? JSON.stringify({ token: MINTED, expires_at: new Date(Date.now() + 3_600_000).toISOString() }) : JSON.stringify({ message: 'A JSON web token could not be decoded' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    state,
    api: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A loopback port nothing listens on: a connection there is refused (ECONNREFUSED). */
async function deadPort(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

const appKey = () => {
  const f = join(mkdtempSync(join(tmpdir(), 'app-key-')), 'key.pem');
  writeFileSync(f, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), { mode: 0o400 });
  return f;
};

/** A watchdog whose GitHub token is minted for real (src/github-app.ts) from `api` each pass, with a short timeout. */
function mintingWorld(api: () => string) {
  const wd = world();
  const creds = { appId: 7, installationId: 42, keyPath: appKey() };
  wd.deps.githubToken = async () => (await mintInstallationToken(creds, ['example-org/example-shop'], fetch, api(), Date.now(), 300)).token;
  const gh = () => readIncidents(wd.w.dir).incidents.filter((x) => x.kind === 'github_auth');
  return { ...wd, gh };
}

test(`regression: GitHub not reached while minting the token is no red github_auth; ${GITHUB_UNREACHABLE_PASSES} passes in a row raise one amber "GitHub not reachable", resolved once it answers`, async () => {
  const dead = await deadPort();
  const up = await standInGitHub();
  let api = dead;
  const { w, pass, gh } = mintingWorld(() => api);
  try {
    for (let i = 1; i < GITHUB_UNREACHABLE_PASSES; i++) {
      await pass(1);
      assert.deepEqual(gh(), [], `pass ${i}: a refused connection is not an auth failure, and too early to report`);
    }
    // The other way GitHub isn't reached: it never answers (the mint's timeout): the same, not a refusal.
    api = up.api;
    up.state.status = 'hang';
    await pass(1);
    const open = gh().filter((x) => !x.resolvedAt);
    assert.equal(open.length, 1, 'one incident');
    assert.equal(open[0]!.key, 'alpha:network', 'under its own key, never the red one');
    assert.equal(open[0]!.severity, 'amber');
    assert.match(open[0]!.detail, new RegExp(`^GitHub not reachable: .*in ${GITHUB_UNREACHABLE_PASSES} passes in a row.*timeout`, 'i'));
    up.state.status = 201;
    await pass(1);
    assert.deepEqual(gh().filter((x) => !x.resolvedAt), [], 'GitHub answered with a token: resolved');
    assert.equal(w.posts.length, 2, 'posted once, and once resolved');
    const all = JSON.stringify(readIncidents(w.dir)) + w.posts.join('\n');
    assert.ok(up.state.jwts.filter(Boolean).length > 0, 'the stand-in saw the App JWT');
    for (const secret of [MINTED, ...up.state.jwts.filter(Boolean)]) assert.ok(!all.includes(secret), 'no token or App JWT in an incident or a post');
  } finally {
    await up.close();
  }
});

test('a real refusal of the App token (401 on the mint) is red on the first pass, and stays red while GitHub then cannot be reached', async () => {
  const up = await standInGitHub();
  const dead = await deadPort();
  let api = up.api;
  const { w, pass, gh } = mintingWorld(() => api);
  try {
    up.state.status = 401;
    await pass(1);
    let open = gh().filter((x) => !x.resolvedAt);
    assert.equal(open.length, 1, 'red at once');
    assert.equal(open[0]!.key, 'alpha');
    assert.equal(open[0]!.severity, 'red');
    assert.match(open[0]!.detail, /GitHub 401 minting/);
    // GitHub then can't be reached: no answer says the refusal is fixed, so it stays red (never quieter).
    api = dead;
    for (let i = 0; i < 3; i++) await pass(1);
    open = gh().filter((x) => !x.resolvedAt);
    assert.deepEqual(
      open.map((x) => [x.key, x.severity]),
      [['alpha', 'red']],
    );
    api = up.api;
    up.state.status = 201;
    await pass(1);
    assert.deepEqual(gh().filter((x) => !x.resolvedAt), [], 'a token minted: resolved');
    const all = JSON.stringify(readIncidents(w.dir)) + w.posts.join('\n');
    for (const secret of [MINTED, ...up.state.jwts.filter(Boolean)]) assert.ok(!all.includes(secret), 'no token or App JWT in an incident or a post');
  } finally {
    await up.close();
  }
});

test('regression: a refused token (401) a coordinator call hit resolves once a GitHub call with the token succeeds after it, not an hour later', async () => {
  const { w, pass, deps } = world();
  let okAt: number | null = null;
  deps.githubOkAt = () => okAt;
  const open = () => readIncidents(w.dir).incidents.filter((x) => x.kind === 'github_auth' && !x.resolvedAt);
  await pass();
  okAt = w.now.getTime() - 60_000; // a success before the failure proves nothing
  w.events.push(ev('coordinator.error', { instance: 'alpha', where: 'reconcile', kind: 'unauthenticated', message: 'GitHub 401 unauthenticated: Bad credentials' }, w.now.toISOString()));
  await pass(1);
  assert.equal(open().length, 1, 'red while no call has succeeded since');
  assert.equal(open()[0]!.severity, 'red');
  await pass(5);
  assert.equal(open().length, 1, 'still red: nothing has succeeded since');
  okAt = w.now.getTime();
  await pass(1);
  assert.deepEqual(open(), [], 'a call with the token succeeded after the 401: resolved within the hour');
  // A newer refusal after that success raises it again at once.
  w.events.push(ev('coordinator.error', { instance: 'alpha', where: 'prs', kind: 'unauthenticated', message: 'GitHub 401 unauthenticated: Bad credentials' }, new Date(w.now.getTime() + 30_000).toISOString()));
  await pass(1);
  assert.equal(open().length, 1);
});

test('a refused permission (403 on one call) is not cleared by another call succeeding, and an older one still stands after a cleared 401', async () => {
  const { w, pass, deps } = world();
  let okAt: number | null = null;
  deps.githubOkAt = () => okAt;
  const open = () => readIncidents(w.dir).incidents.filter((x) => x.kind === 'github_auth' && !x.resolvedAt);
  await pass();
  w.events.push(ev('coordinator.error', { instance: 'alpha', where: 'land', kind: 'insufficient_role', message: 'GitHub 403 insufficient_role: Resource not accessible by integration' }, w.now.toISOString()));
  w.events.push(ev('coordinator.error', { instance: 'alpha', where: 'reconcile', kind: 'unauthenticated', message: 'GitHub 401 unauthenticated: Bad credentials' }, new Date(w.now.getTime() + 1000).toISOString()));
  okAt = w.now.getTime() + 2000;
  await pass(1);
  assert.equal(open().length, 1, 'the 403 still stands');
  assert.match(open()[0]!.detail, /insufficient_role/);
  assert.equal(open()[0]!.severity, 'red');
});

test('isNetworkFailure: no answer from GitHub (fetch failed, a timeout, a network code) is one; an answer (401, 403) or a bad key is not', async () => {
  const dead = await deadPort();
  const refused = await fetch(dead).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(isNetworkFailure(refused), 'a real refused connection (undici: TypeError fetch failed, ECONNREFUSED in its cause)');
  const timedOut = await fetch(dead, { signal: AbortSignal.timeout(0) }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(isNetworkFailure(timedOut), 'AbortSignal.timeout');
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) assert.ok(isNetworkFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) })), code);
  assert.ok(isNetworkFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
  assert.ok(!isNetworkFailure(new Error('GitHub 401 minting an installation token for App 7')), 'GitHub answered: an auth failure');
  assert.ok(!isNetworkFailure(new Error('GitHub 403 minting an installation token for App 7')));
  assert.ok(!isNetworkFailure(Object.assign(new Error("ENOENT: no such file or directory, open '/keys/app.pem'"), { code: 'ENOENT' })), 'a missing key is not the network');
  assert.ok(!isNetworkFailure(new Error('fetch failed: ECONNRESET')), 'never read from message text alone');
  assert.ok(!isNetworkFailure(new TypeError('Invalid URL')));
});

test("the coordinator's GitHub client notes a success against its token source, and only a success", async () => {
  let status = 200;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? JSON.stringify({ number: 1, title: 't', body: '', labels: [], state: 'open', user: { login: 'x' } }) : JSON.stringify({ message: 'Bad credentials' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const refused = async () => 'refused-token';
  const accepted = async () => 'accepted-token';
  try {
    status = 401;
    await assert.rejects(new GitHubBacklog('example-org/example-shop', refused, fetch, api).get(1), /401/);
    assert.equal(githubOkAt(refused), null, 'a refusal is no success');
    status = 200;
    const before = Date.now();
    await new GitHubBacklog('example-org/example-shop', accepted, fetch, api).get(1);
    assert.ok((githubOkAt(accepted) ?? 0) >= before, 'a success is noted against that token source');
    assert.equal(githubOkAt(refused), null, 'and only that one');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
