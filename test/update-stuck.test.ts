// The engine updater's stuck alert (scripts/machine/<cli>-update.cjs): one watchdog incident when the machine has
// stayed on one engine commit for stuck_alert_minutes while main moved on, once per episode, resolved by an install
// or by main being the installed commit; never while updates are off.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { KINDS } from '../src/watchdog/index.js';
import { repoRoot } from './helpers.js';

type State = { installed: string; since: string; tip: string | null; notQuietSince: string | null; raised: boolean };
type Seen = { current: string | null; head: string | null; result: string; reason?: string };
type Step = { state: State | null; raise?: { detail: string; fix: string }; resolve?: true };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  run(deps: object): Promise<string>;
  stuckStep(state: State | null, seen: Seen | null, afterMs: number, now: number, what?: string): Step;
  stuckAlertMs(cfg: unknown): number;
  STUCK_INCIDENT: string;
};

const OLD = 'a'.repeat(40);
const NEW = 'b9634df'.padEnd(40, 'c');
const MIN = 60_000;
const T0 = Date.parse('2026-10-13T20:00:00Z');
const WHY = 'required check "Claude sign-in probe (real users)" hasn\'t run on this commit';
const waiting = (reason = WHY): Seen => ({ current: OLD, head: NEW, result: 'waiting', reason });

/** Runs every 10 minutes from T0 for `minutes`, each seeing `seen(minute)`; returns every step that did something. */
function episode(minutes: number, seen: (m: number) => Seen | null, afterMs = 120 * MIN, start: State | null = null) {
  let state = start;
  const raised: { at: number; detail: string; fix: string }[] = [];
  const resolved: number[] = [];
  for (let m = 0; m <= minutes; m += 10) {
    const s = u.stuckStep(state, seen(m), afterMs, T0 + m * MIN);
    state = s.state;
    if (s.raise) raised.push({ at: m, ...s.raise });
    if (s.resolve) resolved.push(m);
  }
  return { state, raised, resolved };
}

test('stuck for 2 hours while main moved on: one incident, with the installed commit, main\'s tip, how long and the reason', () => {
  const e = episode(300, () => waiting());
  assert.deepEqual(e.raised.map((r) => r.at), [120], 'once per episode, not every 10 minutes, and not before the threshold');
  assert.equal(e.raised[0]!.detail, `the engine has been on aaaaaaa for 2 h 0 min while main moved on to b9634df; the updater says: waiting: ${WHY}`);
  assert.match(e.raised[0]!.fix, /updates\.jsonl/);
  assert.deepEqual(e.resolved, []);
  assert.equal(e.state?.raised, true);
  assert.equal(e.state?.since, new Date(T0).toISOString(), 'the clock runs from the first run that saw it behind');
  // Any way of not updating counts, and the alert says which: refused, held, a failed build, an error.
  for (const result of ['refused', 'held', 'build_failed', 'rolled_back', 'error']) {
    const r = episode(130, () => ({ ...waiting('x'), result }));
    assert.equal(r.raised.length, 1, result);
    assert.match(r.raised[0]!.detail, new RegExp(`the updater says: ${result}: x$`));
  }
  // Main's tip moving again inside the episode is the same episode: the clock keeps running, the tip is the newest.
  const moved = episode(130, (m) => ({ ...waiting(), head: m < 60 ? NEW : 'd'.repeat(40) }));
  assert.deepEqual(moved.raised.map((r) => r.at), [120]);
  assert.match(moved.raised[0]!.detail, /moved on to ddddddd;/);
});

test('it resolves when an install succeeds or main is the installed commit, and a new episode starts its own clock', () => {
  for (const result of ['installed', 'current']) {
    const e = episode(200, (m) => (m < 150 ? waiting() : { current: result === 'installed' ? NEW : OLD, head: result === 'installed' ? NEW : OLD, result }));
    assert.deepEqual([e.raised.map((r) => r.at), e.resolved, e.state], [[120], [150], null], result);
  }
  // Updated before the threshold: nothing was raised, so nothing is resolved.
  const quick = episode(200, (m) => (m < 60 ? waiting() : { current: NEW, head: NEW, result: 'current' }));
  assert.deepEqual([quick.raised, quick.resolved, quick.state], [[], [], null]);
  // Behind again later: a new episode, counted from then.
  const again = episode(400, (m) => (m < 150 ? waiting() : m < 200 ? { current: NEW, head: NEW, result: 'current' } : { current: NEW, head: 'd'.repeat(40), result: 'waiting', reason: WHY }));
  assert.deepEqual(again.raised.map((r) => r.at), [120, 320]);
  assert.deepEqual(again.resolved, [150]);
  // The engine changed under an open alert without an install (a rollback to an older one): that episode ends.
  const other = u.stuckStep({ installed: OLD, since: new Date(T0).toISOString(), tip: NEW, notQuietSince: null, raised: true }, { current: 'e'.repeat(40), head: NEW, result: 'waiting', reason: WHY }, 120 * MIN, T0 + 130 * MIN);
  assert.equal(other.resolve, true);
  assert.deepEqual([other.state?.installed, other.state?.raised, other.raise], ['e'.repeat(40), false, undefined]);
});

test('never while updates are off; turning them off closes an open alert', () => {
  const off = episode(600, () => null);
  assert.deepEqual([off.raised, off.resolved, off.state], [[], [], null]);
  const turnedOff = episode(300, (m) => (m < 150 ? waiting() : null));
  assert.deepEqual([turnedOff.raised.map((r) => r.at), turnedOff.resolved, turnedOff.state], [[120], [150], null]);
});

test('a busy machine ("not quiet") alerts only once it has been busy for the threshold itself', () => {
  const busy = 'not quiet: an agent is running (agent-0.lock)';
  // Busy from the start: under the threshold nothing, at it the alert.
  const all = episode(110, () => waiting(busy));
  assert.deepEqual(all.raised, []);
  assert.deepEqual(episode(130, () => waiting(busy)).raised.map((r) => r.at), [120]);
  // Behind 3 hours in all, but waiting on checks for under 2 of them and busy for 1: no alert yet.
  const late = episode(180, (m) => waiting(m < 110 ? WHY : busy));
  assert.deepEqual(late.raised, [], 'the wait on checks ended before the threshold, and the busy spell is 70 minutes old');
  // ... until the busy spell itself reaches the threshold, or the reason is something else again.
  assert.deepEqual(episode(300, (m) => waiting(m < 110 ? WHY : busy)).raised.map((r) => r.at), [230]);
  assert.deepEqual(episode(300, (m) => waiting(m < 110 || m >= 150 ? WHY : busy)).raised.map((r) => r.at), [150]);
  // A busy spell that ends starts over the next time.
  const twice = episode(300, (m) => waiting(m === 100 ? WHY : busy));
  assert.deepEqual(twice.raised.map((r) => r.at), [230], 'busy 0-90, one wait on checks at 100, busy again from 110: 120 busy minutes in a row at 230');
});

test('the threshold is updates.json stuck_alert_minutes, 120 by default', () => {
  assert.equal(u.stuckAlertMs({}), 120 * MIN);
  assert.equal(u.stuckAlertMs(null), 120 * MIN);
  assert.equal(u.stuckAlertMs({ stuck_alert_minutes: 30 }), 30 * MIN);
  for (const junk of [0, -5, '45', null, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(u.stuckAlertMs({ stuck_alert_minutes: junk }), 120 * MIN, String(junk));
  assert.deepEqual(episode(100, () => waiting(), 30 * MIN).raised.map((r) => r.at), [30]);
});

test('no secret in the alert, one line, capped; a run that failed before asking keeps the clock it had', () => {
  const leak = `clone of https://github.com/x/y failed\n  token=abc123abc123 ghp_${'b'.repeat(36)} Bearer abcdefghijklmnop ${'z'.repeat(2000)}`;
  const s = u.stuckStep({ installed: OLD, since: new Date(T0).toISOString(), tip: NEW, notQuietSince: null, raised: false }, { current: OLD, head: null, result: 'error', reason: leak }, 120 * MIN, T0 + 125 * MIN);
  const detail = s.raise!.detail;
  for (const x of ['abc123', 'ghp_', 'abcdefghijklmnop', '\n']) assert.ok(!detail.includes(x), `${x}: ${detail.slice(0, 200)}`);
  assert.ok(detail.length <= 600);
  assert.match(detail, /^the engine has been on aaaaaaa for 2 h 5 min while main moved on to b9634df; the updater says: error: clone of/, 'the tip it last saw');
  // With no earlier state, a run that never learned main's tip can't say main moved: nothing starts.
  assert.deepEqual(u.stuckStep(null, { current: OLD, head: null, result: 'error', reason: 'x' }, 120 * MIN, T0), { state: null });
  // Nothing installed yet: no "same commit" to be stuck on.
  assert.deepEqual(u.stuckStep(null, { current: null, head: NEW, result: 'waiting', reason: 'x' }, 120 * MIN, T0), { state: null });
});

test('the incident kind is one the watchdog knows, with a fixed title', () => {
  assert.equal(u.STUCK_INCIDENT, 'update_stuck');
  assert.deepEqual(KINDS.update_stuck, { title: 'The engine is not updating', severity: 'amber' });
});

/** A fake machine for run(): main's tip is NEW, whose one required check is `check`; the engine is OLD until installed. */
function machine(o: { enabled?: boolean; cfg?: Record<string, unknown> } = {}) {
  let current = OLD;
  let clock = T0;
  let check: 'pending' | 'green' = 'pending';
  let enabled = o.enabled ?? true;
  let stuck: State | null = null;
  let busy = false;
  const incidents: string[] = [];
  const deps = {
    config: () => ({ enabled, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'], ...o.cfg }),
    installed: () => current,
    exec: (file: string, args: string[]) => {
      if (file === 'git') return `${NEW}\trefs/heads/main\n`;
      if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-x.service loaded active running x\n';
      if (file === 'systemctl' && args[0] === 'show') return 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
      return '';
    },
    fetchJson: async (url: string) =>
      url.includes('/compare/')
        ? { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [{ sha: NEW, parents: [{ sha: OLD }], commit: { committer: { date: new Date(T0).toISOString() } } }] }
        : { check_runs: [{ name: 'test', status: check === 'green' ? 'completed' : 'in_progress', conclusion: check === 'green' ? 'success' : null, started_at: '1', id: 1 }] },
    slots: () => (busy ? [{ name: 'agent-0.lock', pid: 9 }] : []),
    alive: () => busy,
    installTree: () => {},
    syncHelpers: () => [],
    switchTo: (s: string) => void (current = s),
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
    log: () => {},
    held: () => null,
    hold: () => {},
    configChangedAt: () => 0,
    note: (event: string) => event,
    stuckState: () => stuck,
    saveStuck: (s: State | null) => void (stuck = s ? (JSON.parse(JSON.stringify(s)) as State) : null),
    raiseIncident: (kind: string, key: string, detail: string) => void incidents.push(`raise ${kind} ${key}: ${detail}`),
    resolveIncident: (kind: string, key: string) => void incidents.push(`resolve ${kind} ${key}`),
  };
  /** One timer run now, then the clock moves to 10 minutes after this run began. */
  const tick = async () => {
    const began = clock;
    const r = await u.run(deps);
    clock = began + 10 * MIN;
    return r;
  };
  return { deps, incidents, tick, stuck: () => stuck, current: () => current, setCheck: (c: 'pending' | 'green') => void (check = c), setEnabled: (e: boolean) => void (enabled = e), setBusy: (b: boolean) => void (busy = b) };
}

test('run: waiting on main\'s tip every 10 minutes raises one incident at 2 hours, and the install resolves it', async () => {
  const m = machine();
  for (let i = 0; i < 12; i++) assert.equal(await m.tick(), 'waiting');
  assert.deepEqual(m.incidents, [], '110 minutes: nothing yet');
  assert.equal(await m.tick(), 'waiting');
  assert.equal(m.incidents.length, 1);
  assert.match(m.incidents[0]!, /^raise update_stuck engine: the engine has been on aaaaaaa for 2 h 0 min while main moved on to b9634df; the updater says: waiting: required check "test" is in_progress/);
  for (let i = 0; i < 6; i++) await m.tick();
  assert.equal(m.incidents.length, 1, 'another hour of runs: still the one');
  m.setCheck('green');
  assert.equal(await m.tick(), 'installed');
  assert.equal(m.current(), NEW);
  assert.deepEqual(m.incidents.slice(1), ['resolve update_stuck engine']);
  assert.equal(m.stuck(), null);
  // Main is the installed commit now: nothing more.
  assert.equal(await m.tick(), 'current');
  assert.equal(m.incidents.length, 2);
});

test('run: off raises nothing however long; a machine that is only busy waits out its own threshold; a shorter one from updates.json', async () => {
  const off = machine({ enabled: false });
  for (let i = 0; i < 30; i++) assert.equal(await off.tick(), 'disabled');
  assert.deepEqual(off.incidents, []);
  // Turned off under an open alert: resolved.
  const m = machine({ cfg: { stuck_alert_minutes: 30 } });
  for (let i = 0; i < 4; i++) await m.tick();
  assert.equal(m.incidents.length, 1, 'stuck_alert_minutes: 30');
  m.setEnabled(false);
  assert.equal(await m.tick(), 'disabled');
  assert.deepEqual(m.incidents.slice(1), ['resolve update_stuck engine']);
  // Green but busy (an agent running): 110 minutes of "not quiet" is no alert; at 120 it is one.
  const b = machine();
  b.setCheck('green');
  b.setBusy(true);
  for (let i = 0; i < 12; i++) assert.equal(await b.tick(), 'waiting');
  assert.deepEqual(b.incidents, []);
  await b.tick();
  assert.equal(b.incidents.length, 1);
  assert.match(b.incidents[0]!, /the updater says: waiting: not quiet: an agent is running/);
});
