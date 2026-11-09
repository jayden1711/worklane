import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { StoredEvent } from '../src/events/types.js';
import { readEvents } from '../src/events/read-only.js';
import { ROLLOUT_FILE, RolloutFile, readInstance, readRollout, ringZeroProblem, rolloutStatus, type Rollout } from '../src/rollout.js';
import { rolloutCommand, type RolloutDeps } from '../src/rollout-cli.js';
import { EventLog } from '../src/events/log.js';
import { onRealMachine } from './isolate.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let id = 0;
const ev = (type: string, payload: Record<string, unknown>, ts: string): StoredEvent => ({ id: ++id, ts, type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
/** A config commit's flip (the engine's own off, with no commit, is ignored: R1174f 1). */
const SHA = 'c'.repeat(40);
const on = (h: number, flag = 'f') => ev('flag.flipped', { flag, from: false, to: true, sha: SHA }, hoursAgo(h));
const off = (h: number, flag = 'f') => ev('flag.flipped', { flag, from: true, to: false, sha: SHA }, hoursAgo(h));
let pr = 0;
/** `n` merges, each of its own PR. */
const merges = (n: number, h: number) => Array.from({ length: n }, () => ev('merge.done', { number: ++pr }, hoursAgo(h)));
/** A coordinator seen ticking a few minutes ago: alive. */
const tick = (h = 0.05) => ev('coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0 }, hoursAgo(h));
/** On `h` hours ago, `n` merges `m` hours ago, and ticking now. */
const healthy = (h: number, n = 3, m = h - 10) => [on(h), ...merges(n, m), tick()];

const R: Rollout = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }, { name: 'second', instances: ['p2', 'p3'] }] });
const status = (logs: Record<string, StoredEvent[]>, o: { flag?: string; rollout?: Rollout; outside?: Record<string, StoredEvent[]>; outsideNames?: string[]; ringZero?: string | null; listing?: string | null } = {}) =>
  rolloutStatus({ rollout: o.rollout ?? R, flag: o.flag ?? 'f', logs: new Map(Object.entries(logs)), now: NOW, ...(o.outside || o.outsideNames ? { outside: new Map(Object.entries(o.outside ?? {})), outsideNames: o.outsideNames ?? Object.keys(o.outside ?? {}) } : {}), ...(o.ringZero !== undefined ? { ringZero: o.ringZero } : {}), ...(o.listing !== undefined ? { listing: o.listing } : {}) });
const states = (s: ReturnType<typeof status>) => s.rings.map((r) => r.state);
const quiet = { e1: [], p1: [], p2: [], p3: [] };

test('rollout: ring 0 first; a ring is promoted only after soaking its hours with its merges, alive and with nothing going wrong; then the next ring turns on', () => {
  let s = status(quiet);
  assert.deepEqual(states(s), ['off', 'off', 'off']);
  assert.equal(s.next, 'turn it on for ring engine: set `flags.f: true` in the config.yaml of e1 (a PR in each repo)');
  s = status({ ...quiet, e1: [on(10), ...merges(1, 5), tick()] });
  assert.deepEqual(states(s), ['soaking', 'off', 'off']);
  assert.match(s.next, /^wait: ring engine is soaking \(10 of 48 h; e1: 1 of 3 merges\)/);
  s = status({ ...quiet, e1: [on(50), ...merges(2, 5), tick()] });
  assert.equal(s.rings[0]!.state, 'soaking', 'the hours alone are not enough');
  s = status({ ...quiet, e1: healthy(50) });
  assert.deepEqual(states(s), ['promoted', 'off', 'off']);
  assert.equal(s.next, 'turn it on for ring first: set `flags.f: true` in the config.yaml of p1 (a PR in each repo)');
  // Each ring turned on after the one before it was promoted (its hours and merges both done).
  // R1174f 3: min_merges in each instance, not across the ring: p3 with one merge holds the ring.
  s = status({ e1: healthy(300, 3, 250), p1: healthy(240, 4, 190), p2: healthy(100, 3, 50), p3: [on(99), ...merges(1, 50), tick()] });
  assert.equal(s.rings[2]!.state, 'soaking');
  assert.match(s.rings[2]!.why, /p3: 1 of 3 merges/);
  s = status({ e1: healthy(300, 3, 250), p1: healthy(240, 4, 190), p2: healthy(100, 3, 50), p3: [on(99), ...merges(3, 50), tick()] });
  assert.deepEqual(states(s), ['promoted', 'promoted', 'promoted'], 'each instance with its own merges');
  assert.match(s.next, /^every ring is promoted: f can become the default/);
});

test('rollout: anything going wrong in a ring after its flag went on, by the log\'s order, rolls it back, and every later ring that is or may be on (R1174d 2)', () => {
  const healthy0 = healthy(100);
  for (const [bad, why] of [
    [ev('merge.stopped', { by: 'red_main' }, hoursAgo(5)), 'auto-merge stopped'],
    [ev('merge.main_result', { outcome: 'red' }, hoursAgo(5)), 'went red'],
    [ev('merge.main_result', { outcome: 'timed_out' }, hoursAgo(5)), 'unknown (timed out)'],
    [ev('config.invalid', { sha: 'a', errors: [] }, hoursAgo(5)), 'config went invalid'],
    [ev('testrun.fault', { fault: 'gpu_lost' }, hoursAgo(5)), 'machine fault (gpu_lost)'],
    [ev('coordinator.stopped', { instance: 'i', clean: false, ms: 1, pending: [] }, hoursAgo(5)), 'stopped uncleanly'],
  ] as const) {
    const s = status({ e1: healthy0, p1: [on(20), bad, tick()], p2: [], p3: [] });
    assert.deepEqual(states(s), ['promoted', 'roll back', 'off'], why);
    assert.match(s.next, new RegExp(`^roll back ring first \\(p1: .*${why.replace(/[()]/g, '\\$&')}.*\\): set \`flags.f: false\` in the config.yaml of p1`), s.next);
  }
  assert.equal(status({ e1: [ev('merge.stopped', {}, hoursAgo(200)), ...healthy0], p1: [], p2: [], p3: [] }).rings[0]!.state, 'promoted', "a stop before the flag went on is not the change's");
  // R1174d A2: the clock stepped back after the flip. The stop comes after the flip in the log, so it counts.
  assert.equal(status({ e1: [on(60), ev('merge.stopped', { by: 'red_main' }, hoursAgo(62)), ...merges(3, 30), tick()], p1: [], p2: [], p3: [] }).rings[0]!.state, 'roll back');
  // Ring 1 bad while ring 2 is on too (out of order): both are named in the roll back; an unread later ring too.
  const both = status({ e1: healthy0, p1: [on(20), ev('merge.stopped', {}, hoursAgo(5))], p2: [on(10)], p3: [on(10)] });
  assert.match(both.next, /config\.yaml of p1 \(a PR in each repo\); then set `flags\.f: false` in the config\.yaml of p2, p3/);
  const unreadLater = status({ e1: healthy0, p1: [on(20), ev('merge.stopped', {}, hoursAgo(5))], p2: [] });
  assert.equal(unreadLater.rings[2]!.state, 'unknown');
  assert.match(unreadLater.next, /then set `flags\.f: false` in the config\.yaml of p2, p3 \(a PR in each repo\) if it is on there \(its log can't be read\)/);
});

test('rollout: out of order is judged from the flip history: a ring turned on with or before the ring before it stays out of order once that ring is promoted (R1174d 1)', () => {
  // A1: rings 0 and 1 on together, 60 h ago; ring 0 is promoted now, ring 1 is not laundered.
  let s = status({ e1: healthy(60, 3, 30), p1: healthy(60, 3, 30), p2: [], p3: [] });
  assert.deepEqual(states(s).slice(0, 2), ['promoted', 'out of order']);
  assert.match(s.rings[1]!.why, /^turned on at .*, before ring engine was promoted/);
  // A1b: every ring at once: never "every ring is promoted".
  s = status({ e1: healthy(60, 3, 30), p1: healthy(60, 3, 30), p2: healthy(60, 2, 30), p3: healthy(60, 1, 30) });
  assert.doesNotMatch(s.next, /every ring is promoted/);
  assert.match(s.next, /^roll back ring first/);
  // A1c: ring 1 on BEFORE ring 0.
  s = status({ e1: healthy(50, 3, 30), p1: healthy(100, 3, 30), p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'out of order');
  // Its promotion time is its hours and its merges both: the 3rd merge 20 h after the soak's end moves it.
  s = status({ e1: [on(100), ...merges(3, 30), tick()], p1: healthy(40, 0, 1), p2: [], p3: [] }, { rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }], promote: { min_merges: 0 } }) });
  assert.equal(s.rings[1]!.state, 'soaking', 'min_merges 0: promoted at its hours alone (52 h ago), and ring 1 turned on after');
  s = status({ e1: [on(100), ...merges(3, 30), tick()], p1: healthy(40, 0, 1), p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'out of order', 'ring 0 was promoted at its 3rd merge, 30 h ago, after ring 1 went on');
  // Turned off there and on again after: judged afresh.
  assert.equal(status({ e1: healthy(100, 3, 60), p1: [on(70), off(55), tick(50.01), ...healthy(50, 3, 20)], p2: [], p3: [] }).rings[1]!.state, 'promoted');
});

test('rollout: silence is not health: no recent tick holds a ring; an unclean restart or too many coordinator errors since the flip roll it back (R1174d 3)', () => {
  // A9: three merges, then crash restarts, then nothing.
  const started = (h: number, pid: number) => ev('coordinator.started', { instance: 'e1', pid, version: 'x' }, hoursAgo(h));
  let s = status({ e1: [started(61, 1), on(60), ...merges(3, 58), started(58, 2), started(58, 3)], p1: [], p2: [], p3: [] });
  assert.equal(s.rings[0]!.state, 'roll back');
  assert.match(s.rings[0]!.why, /the coordinator restarted without a clean stop/);
  // A clean stop before the restart is fine.
  const stopped = ev('coordinator.stopped', { instance: 'e1', clean: true, ms: 1, pending: [] }, hoursAgo(20));
  assert.equal(status({ e1: [started(61, 1), on(60), ...merges(3, 30), stopped, started(20, 2), tick()], p1: [], p2: [], p3: [] }).rings[0]!.state, 'promoted');
  // No tick in the last 30 min: held.
  s = status({ e1: [on(60), ...merges(3, 30), tick(2)], p1: [], p2: [], p3: [] });
  assert.equal(s.rings[0]!.state, 'soaking');
  assert.match(s.rings[0]!.why, /no coordinator tick in the last 30 min from e1/);
  assert.equal(status({ e1: [on(60), ...merges(3, 30)], p1: [], p2: [], p3: [] }).rings[0]!.state, 'soaking', 'never ticked: held');
  // A5: coordinator.error over max_errors (2) since the flip.
  const err = () => ev('coordinator.error', { instance: 'e1', where: 'tick', kind: 'TypeError', message: 'x' }, hoursAgo(40));
  assert.equal(status({ e1: [on(60), err(), err(), ...merges(3, 30), tick()], p1: [], p2: [], p3: [] }).rings[0]!.state, 'promoted', 'two errors: within the limit');
  s = status({ e1: [on(60), err(), err(), err(), ...merges(3, 30), tick()], p1: [], p2: [], p3: [] });
  assert.equal(s.rings[0]!.state, 'roll back');
  assert.match(s.rings[0]!.why, /3 coordinator errors since it went on \(limit 2\)/);
  // A3: a rollback before, then on again: promoted, and it says so.
  s = status({ e1: [on(200), ev('merge.stopped', { by: 'red_main' }, hoursAgo(150)), off(149), ...healthy(60, 3, 30)], p1: [], p2: [], p3: [] });
  assert.equal(s.rings[0]!.state, 'promoted');
  assert.match(s.rings[0]!.why, /rolled back before: auto-merge stopped \(in an earlier on-period/);
});

test('rollout: a ring with a log no one could read is unknown, never off: it holds every turn-on, and one bad sign it can read still rolls back (R1174c 1, R1174d 4)', () => {
  const two = (rings: { name: string; instances: string[] }[], logs: Record<string, StoredEvent[]>) => rolloutStatus({ rollout: RolloutFile.parse({ rings }), flag: 'f', logs: new Map(Object.entries(logs)), now: NOW });
  // S1: ring 0 promoted, ring 1's log unread.
  let s = two([{ name: 'engine', instances: ['a'] }, { name: 'p', instances: ['b'] }], { a: healthy(100) });
  assert.deepEqual(s.rings.map((r) => r.state), ['promoted', 'unknown']);
  assert.match(s.next, /^wait: can't read the event log of b: nothing is turned on/);
  // S1b: ring 0's own log unread.
  s = two([{ name: 'engine', instances: ['a'] }], {});
  assert.equal(s.rings[0]!.state, 'unknown');
  assert.match(s.next, /^wait: can't read the event log of a/);
  // A4: ring 1 readable and off, ring 2 unread: no turn-on for ring 1.
  s = status({ e1: healthy(100), p1: [] });
  assert.match(s.next, /^wait: can't read the event log of p2, p3/);
  // A bad sign in what can be read still rolls back.
  s = two([{ name: 'engine', instances: ['a', 'b'] }], { a: [on(5), ev('merge.stopped', { by: 'red_main' }, hoursAgo(2))] });
  assert.equal(s.rings[0]!.state, 'roll back');
  assert.match(s.rings[0]!.why, /^a: auto-merge stopped; and can't read the event log of b$/);
  assert.match(s.next, /^roll back ring engine .*config\.yaml of a, b/);
  // A ring on in some instances is partial; another flag's flips are not this one's; off again is off.
  assert.equal(status({ e1: healthy(300, 3, 250), p1: healthy(240, 3, 190), p2: [on(60), tick()], p3: [] }).rings[2]!.state, 'partial');
  assert.equal(status({ ...quiet, e1: [on(100, 'g'), ...merges(3, 50), tick()] }).rings[0]!.state, 'off');
  assert.equal(status({ ...quiet, e1: [on(100), off(50)] }).rings[0]!.state, 'off');
});

test('rollout: ring 0 must be the engine\'s own repo and no engine instance outside it; can\'t tell holds (R1174d 5)', () => {
  const repos = (o: Record<string, string[] | null>) => new Map(Object.entries(o));
  const engine = ['example/engine'];
  assert.equal(ringZeroProblem({ rollout: R, repos: repos({ e1: ['example/engine'], p1: ['o/p1'], p2: ['o/p2'], p3: ['o/p3'] }), engine }), null);
  assert.match(ringZeroProblem({ rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['p1'] }] }), repos: repos({ p1: ['o/p1'], e1: ['example/engine'] }), engine, outsideNames: ['e1'] })!, /ring 0 \(engine\) has p1, which is not an instance of the engine's own repo/);
  assert.match(ringZeroProblem({ rollout: R, repos: repos({ e1: ['example/engine'], p1: ['o/p1'], p2: ['o/p2'], p3: ['o/p3'], e2: ['Example/Engine'] }), engine, outsideNames: ['e2'] })!, /e2 is an instance of the engine's own repo but isn't in ring 0/);
  assert.match(ringZeroProblem({ rollout: R, repos: repos({ e1: null }), engine })!, /can't tell e1's repo/);
  assert.match(ringZeroProblem({ rollout: R, repos: repos({ e1: ['example/engine'] }), engine: null })!, /can't tell the engine's own repos/);
  // A6 through the status: no turn-on step while ring 0 is wrong; a rollback still shows.
  const s = status({ e1: [] }, { rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }] }), ringZero: 'ring 0 (engine) has e1, which is not ...' });
  assert.match(s.next, /^wait: ring 0 \(engine\) has e1, .*: fix rollout\.json first/);
  assert.match(status({ e1: [on(5), ev('merge.stopped', {}, hoursAgo(1))] }, { rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }] }), ringZero: 'x' }).next, /^roll back ring engine/);
});

test('rollout.json: rings in order, each instance in one ring only, names without paths; promotion defaults; root\'s file is read only when it is root\'s alone (R1174d 6)', () => {
  assert.deepEqual(RolloutFile.parse({ rings: [{ name: 'a', instances: ['x'] }] }).promote, { soak_hours: 48, min_merges: 3, live_minutes: 30, max_errors: 2 });
  for (const bad of [
    { rings: [] },
    { rings: [{ name: 'a', instances: [] }] },
    { rings: [{ name: 'a', instances: ['x'] }, { name: 'b', instances: ['x'] }] },
    { rings: [{ name: 'a', instances: ['../etc'] }] },
    { rings: [{ name: 'A B', instances: ['x'] }] },
    { rings: [{ name: 'a', instances: ['x'] }], promote: { soak_hours: 0 } },
    { rings: [{ name: 'a', instances: ['x'] }], promote: { live_minutes: 1 } },
    { rings: [{ name: 'a', instances: ['x'] }], extra: true },
  ]) assert.equal(RolloutFile.safeParse(bad).success, false, JSON.stringify(bad));
  if (process.platform === 'win32') return;
  const file = ROLLOUT_FILE();
  // The test machine's root, never the real /etc (#815): onRealMachine throws for a path outside it.
  assert.equal(onRealMachine(file), `/etc/${BRAND.cli}/rollout.json`);
  mkdirSync(dirname(file), { recursive: true });
  const body = JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }] });
  const me = process.getuid!();
  try {
    writeFileSync(file, body, { mode: 0o644 });
    assert.equal(readRollout(undefined, me).checked, true, "root's alone (here: this test's uid as root): read");
    assert.throws(() => readRollout(), /not root's|owned by|uid/, "this test's file is not root's: refused");
    chmodSync(file, 0o666);
    assert.throws(() => readRollout(undefined, me), /writ/, 'world-writable: refused');
    rmSync(file);
    const elsewhere = join(dirname(file), 'elsewhere.json');
    writeFileSync(elsewhere, body, { mode: 0o644 });
    symlinkSync(elsewhere, file);
    assert.throws(() => readRollout(undefined, me), /is a link/, 'a link: refused');
    // --file (a copy to try out): read as it is, and said so.
    assert.equal(readRollout(elsewhere).checked, false);
  } finally {
    rmSync(file, { force: true });
    rmSync(join(dirname(file), 'elsewhere.json'), { force: true });
  }
});

test("rollout status reads an instance's real event log read-only: the flips and merges as stored (src/events/read-only.ts)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-db-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  log.append('flag.flipped', { flag: 'f', from: false, to: true, sha: null }, 'i');
  log.close();
  try {
    const events = readEvents(db);
    assert.equal(events[0]!.type, 'flag.flipped');
    assert.deepEqual(events[0]!.payload, { flag: 'f', from: false, to: true, sha: null });
    assert.throws(() => readEvents(join(dir, 'missing.db')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollout: an instance in no ring with the flag on is always rolled back; one whose log is unread holds every turn-on (#1174 review, defect 3)', () => {
  let s = status(quiet, { outside: { x: [on(5)], y: [] } });
  assert.deepEqual(s.outsideOn, ['x']);
  assert.equal(s.next, 'roll back outside the rollout (x: in no ring of rollout.json): set `flags.f: false` in the config.yaml of x (a PR in each repo)');
  s = status({ ...quiet, e1: [on(20), ev('merge.stopped', {}, hoursAgo(2))] }, { outside: { x: [on(5)] } });
  assert.match(s.next, /^roll back outside the rollout \(x: .*; and roll back ring engine \(e1: auto-merge stopped\)/);
  s = status(quiet, { outsideNames: ['z'] });
  assert.deepEqual(s.outsideUnread, ['z']);
  assert.match(s.next, /^wait: can't read the event log of z: nothing is turned on/);
  assert.equal(status(quiet, { outside: { y: [on(9), off(8)] } }).next, status(quiet).next);
  assert.match(status(quiet, { listing: "this machine's instance list doesn't name p1" }).next, /^wait: this machine's instance list doesn't name p1/);
});

/** An instances folder with an instance.yaml for each name (its repo), as the CLI finds them. */
function instancesAt(dir: string, repos: Record<string, string>) {
  for (const [n, repo] of Object.entries(repos)) {
    mkdirSync(join(dir, n, 'state'), { recursive: true });
    writeFileSync(join(dir, n, 'instance.yaml'), `version: 1\nname: ${n}\nrepos:\n  - path: "/x"\n    repo: ${repo}\n`);
  }
}

test('rollout status: prints each ring and the next step; exit 1 when the file, a log, the instance list or ring 0 cannot be used; 2 a usage error; it never writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-'));
  const file = join(dir, 'rollout.json');
  writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }));
  const own = join(dir, 'instances');
  instancesAt(own, { e1: 'example/engine', p1: 'o/p1', x: 'o/x', y: 'o/y' });
  const deps: Partial<RolloutDeps> = { ownDir: () => own, srvRoot: () => join(dir, 'no-srv'), homeOf: () => null, engine: () => ({ repos: ['example/engine'], problem: null }) };
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[], eventsOf: (n: string) => StoredEvent[], instances: string[] = ['e1', 'p1'], d = deps) => rolloutCommand(args[0], args.slice(1), { out: (s) => out.push(s), err: (s) => err.push(s), eventsOf, instances: () => instances, now: NOW, deps: d });
  try {
    assert.equal(run(['status', '--flag', 'f', '--file', file], () => []), 0);
    assert.deepEqual(out.slice(-3), ['ring 0 engine (e1): off: the flag is off in every instance of this ring', 'ring 1 first (p1): off: the flag is off in every instance of this ring', 'next: turn it on for ring engine: set `flags.f: true` in the config.yaml of e1 (a PR in each repo)']);
    assert.match(out.join('\n'), /note: ".*rollout\.json" is read as it is, not as root's rollout\.json/);
    assert.match(out.join('\n'), /note: f is not a flag this engine knows/);
    assert.equal(run(['status', '--flag', 'f', '--file', file], (n) => (n === 'p1' ? (() => { throw new Error('EACCES'); })() : [])), 1);
    assert.match(err.at(-1)!, /can't read p1's event log: EACCES/);
    assert.match(out.at(-1)!, /^next: wait: can't read the event log of p1/);
    assert.equal(run(['status', '--flag', 'f', '--file', join(dir, 'none.json')], () => []), 1);
    assert.equal(run(['status'], () => []), 2);
    assert.equal(run(['flip', '--flag', 'f'], () => []), 2, 'there is no command that flips a flag');
    assert.equal(run(['status', '--flag', 'f', '--force', 'x'], () => []), 2);
    for (const a of [['--flag', 'f', 'x', '--bogus', 'v'], ['--flag', 'f', '--flag', 'g'], ['--flag'], ['--flag', 'f', '--file']]) assert.equal(run(['status', ...a, ...(a.includes('--file') ? [] : ['--file', file])], () => []), 2, a.join(' '));
    out.length = 0;
    assert.equal(run(['status', '--flag', 'f', '--file', file], (n) => (n === 'x' ? [on(3)] : []), ['e1', 'p1', 'x', 'y']), 0);
    assert.ok(out.includes('outside the rollout: x has f on, in no ring'), out.join('\n'));
    assert.match(out.at(-1)!, /^next: roll back outside the rollout \(x: in no ring of rollout\.json\)/);
    err.length = 0;
    assert.equal(run(['status', '--flag', 'f', '--file', file], (n) => (n === 'y' ? (() => { throw new Error('EACCES'); })() : []), ['e1', 'p1', 'y']), 1);
    assert.match(err.join('\n'), /can't read y's event log \(in no ring\): EACCES/);
    // The instance list doesn't name a ring instance: exit 1, held.
    assert.equal(run(['status', '--flag', 'f', '--file', file], () => [], ['e1']), 1);
    assert.match(out.at(-1)!, /^next: wait: this machine's instance list doesn't name p1/);
    // Ring 0 not the engine's own repo: exit 1, held.
    assert.equal(run(['status', '--flag', 'f', '--file', file], () => [], ['e1', 'p1'], { ...deps, engine: () => ({ repos: ['example/other'], problem: null }) }), 1);
    assert.match(out.at(-1)!, /^next: wait: ring 0 \(engine\) has e1, which is not an instance of the engine's own repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollout status on a separate-users machine: each instance's log and repo from its own coordinator home, and the list from /srv (R1174c 2)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-homes-'));
  const homes = join(dir, 'home');
  const srv = join(dir, 'srv');
  const file = join(dir, 'rollout.json');
  writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }));
  for (const [n, repo] of Object.entries({ e1: 'example/engine', p1: 'o/p1', x: 'o/x' })) {
    const inst = join(homes, `wl-${n}`, '.local', 'state', BRAND.cli, 'instances');
    instancesAt(inst, { [n]: repo });
    const log = new EventLog(join(inst, n, 'state', 'events.db'));
    if (n === 'x') log.append('flag.flipped', { flag: 'f', from: false, to: true, sha: null }, n);
    log.close();
    mkdirSync(join(srv, n), { recursive: true });
  }
  const out: string[] = [];
  const err: string[] = [];
  try {
    // Run as root would: its own instances dir has nothing; every instance is in its own home.
    const code = rolloutCommand('status', ['--flag', 'f', '--file', file], { out: (s) => out.push(s), err: (s) => err.push(s), now: NOW, deps: { ownDir: () => join(dir, 'root-own'), srvRoot: () => srv, homeOf: (u) => join(homes, u), engine: () => ({ repos: ['example/engine'], problem: null }) } });
    assert.deepEqual(err, []);
    assert.equal(code, 0, out.join('\n'));
    assert.ok(out.includes('outside the rollout: x has f on, in no ring'), out.join('\n'));
    // And with no homes to read (another user), nothing is read: unread, held, exit 1.
    out.length = 0;
    assert.equal(rolloutCommand('status', ['--flag', 'f', '--file', file], { out: (s) => out.push(s), err: () => {}, now: NOW, deps: { ownDir: () => join(dir, 'root-own'), srvRoot: () => srv, homeOf: () => null, engine: () => ({ repos: ['example/engine'], problem: null }) } }), 1);
    assert.match(out.at(-1)!, /^next: wait: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollout: an engine-recorded off (no commit) and a replayed on change nothing; one PR counts once; a future tick is no sign of life; min_merges in each instance (R1174f 1, 3, A1-A5)', () => {
  // A1: a replayed on (no off between) never starts a new on-period: the earlier red main and out-of-order start stay.
  let s = status({ e1: healthy(300, 3, 250), p1: [on(100), ev('merge.main_result', { outcome: 'red' }, hoursAgo(90)), on(70), ...merges(3, 60), tick()], p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'roll back', s.rings[1]!.why);
  s = status({ e1: healthy(300, 3, 250), p1: [on(280), on(100), ...merges(3, 60), tick()], p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'out of order', 'the first on counts');
  // A2: the engine's own off (sha null) is a real off for the soak (R1174g D1, R1174h H1); while it is off by itself,
  // nothing says "set true".
  const nullOff = (h: number) => ev('flag.flipped', { flag: 'f', from: true, to: false, sha: null }, hoursAgo(h));
  const p1 = [on(280), ev('config.invalid', { sha: 'b', errors: [] }, hoursAgo(200)), nullOff(199), on(150), ...merges(3, 60), tick()];
  s = status({ e1: healthy(300, 3, 250), p1, p2: [], p3: [] });
  // R1231a, R1174f A2: and the engine's own off forgives nothing: the stretch began at 280 h, before ring 0 was promoted.
  assert.equal(s.rings[1]!.state, 'out of order');
  const mid = status({ e1: healthy(300, 3, 250), p1: p1.slice(0, 3), p2: [], p3: [] });
  assert.notEqual(mid.rings[1]!.state, 'off', "the engine's own off is not the repo turning it off");
  assert.doesNotMatch(mid.next, /set `flags\.f: true`/);
  // A3: an instance doing no work isn't promoted on the others' merges.
  const idle = [ev('merge.stopped', { by: 'red_main' }, hoursAgo(120)), on(100), tick()];
  s = status({ e1: healthy(400, 3, 350), p1: healthy(300, 3, 250), p2: healthy(100, 3, 60), p3: idle });
  assert.equal(s.rings[2]!.state, 'soaking');
  assert.match(s.rings[2]!.why, /p3: 0 of 3 merges/);
  // A4: one PR recorded three times is one merge.
  const dup = [on(60), ...[7, 7, 7].map((n) => ev('merge.done', { number: n }, hoursAgo(30))), tick()];
  assert.match(status({ e1: healthy(300, 3, 250), p1: dup, p2: [], p3: [] }).rings[1]!.why, /p1: 1 of 3 merges/);
  // A5: a last tick stamped a week ahead, then nothing: not alive.
  s = status({ e1: [on(60), ...merges(3, 30), ev('coordinator.tick', { instance: 'e1', dispatched: 0, reconciled: 0 }, new Date(NOW.getTime() + 7 * 86_400_000).toISOString())], p1: [], p2: [], p3: [] });
  assert.equal(s.rings[0]!.state, 'soaking');
  assert.match(s.rings[0]!.why, /no coordinator tick in the last 30 min from e1/);
});

test('rollout status: a linked instance folder is on the list; a name both in the running user\'s dir and in its coordinator home is ambiguous and held (R1174f 2, A6, A7)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-r1174f-'));
  try {
    const file = join(dir, 'rollout.json');
    writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }));
    const own = join(dir, 'own');
    const elsewhere = join(dir, 'disk2');
    instancesAt(own, { e1: 'example/engine', p1: 'o/p1' });
    instancesAt(elsewhere, { x: 'o/x' });
    for (const [d, n] of [[own, 'e1'], [own, 'p1']] as const) new EventLog(join(d, n, 'state', 'events.db')).close();
    const lx = new EventLog(join(elsewhere, 'x', 'state', 'events.db'));
    lx.append('flag.flipped', { flag: 'f', from: false, to: true, sha: SHA }, 'x');
    lx.close();
    symlinkSync(join(elsewhere, 'x'), join(own, 'x'));
    const out: string[] = [];
    const engine = () => ({ repos: ['example/engine'], problem: null });
    rolloutCommand('status', ['--flag', 'f', '--file', file], { out: (l) => out.push(l), err: () => {}, now: NOW, deps: { ownDir: () => own, srvRoot: () => join(dir, 'no-srv'), homeOf: () => null, engine } });
    assert.ok(out.includes('outside the rollout: x has f on, in no ring'), out.join('\n'));
    // A7: e1 live in its coordinator home, and a stale e1 folder in the running user's dir: ambiguous, held.
    const homes = join(dir, 'home');
    const inst = join(homes, 'wl-e1', '.local', 'state', BRAND.cli, 'instances');
    instancesAt(inst, { e1: 'example/engine' });
    new EventLog(join(inst, 'e1', 'state', 'events.db')).close();
    const err: string[] = [];
    out.length = 0;
    const code = rolloutCommand('status', ['--flag', 'f', '--file', file], { out: (l) => out.push(l), err: (l) => err.push(l), now: NOW, deps: { ownDir: () => own, srvRoot: () => join(dir, 'no-srv'), homeOf: (u) => join(homes, u), engine } });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /two folders for e1: .*wl-e1's home.*remove the stale one/);
    assert.doesNotMatch(out.at(-1)!, /^next: turn it on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the wait step names what holds: a ring unknown because an instance runs with the flag off by itself names that instance, not an empty list (#1231 R1231h)", () => {
  const nullOff = (h: number) => ev('flag.flipped', { flag: 'f', from: true, to: false, sha: null }, hoursAgo(h));
  const s = status({ e1: healthy(300), p1: healthy(200), p2: [tick()], p3: [on(120), ...merges(3, 110), nullOff(105), tick()] });
  assert.equal(s.rings[2]!.state, 'unknown');
  assert.match(s.next, /^wait: ring second is unknown \(p3 runs with the flag off by itself/);
  assert.doesNotMatch(s.next, /event log of :/);
  // With an unread log too, both are named.
  const both = status({ e1: healthy(300), p1: healthy(200), p3: [on(120), ...merges(3, 110), nullOff(105), tick()] });
  assert.match(both.next, /^wait: can't read the event log of p2/);
});

// --- R1174i (thresholds pinned at their boundaries) and R1174j (clock, stops, lost events, size, stamps, names) ---
const R2: Rollout = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] });
const ring0 = (e1: StoredEvent[]) => status({ e1, p1: [] }, { rollout: R2 }).rings[0]!.state;
const started = (h: number) => ev('coordinator.started', { instance: 'i', pid: 1, version: 'v' }, hoursAgo(h));
const stopped = (h: number, clean = true) => ev('coordinator.stopped', { instance: 'i', clean, ms: 1, pending: [] }, hoursAgo(h));
const nullOff = (h: number) => ev('flag.flipped', { flag: 'f', from: true, to: false, sha: null }, hoursAgo(h));

test('R1174i: each threshold at its boundary: 48 h, a 30-min tick, a tick ahead, a flip stamped behind, a merge before the flip', () => {
  assert.equal(ring0([on(48.1), ...merges(3, 40), tick()]), 'promoted', 'the twin: 48.1 h');
  assert.equal(ring0([on(47.5), ...merges(3, 40), tick()]), 'soaking', 'B1 soak: 47.5 of 48 h');
  assert.equal(ring0([on(48.1), ...merges(3, 40), tick(31 / 60)]), 'soaking', 'B2 a last tick 31 min ago');
  assert.equal(ring0([on(48.1), ...merges(3, 40), tick(-5 / 60)]), 'soaking', 'B3 a tick stamped 5 min ahead');
  assert.equal(ring0([tick(49.0), on(49.1), ...merges(3, 40), tick()]), 'soaking', 'B4 a flip stamped 6 min before an event logged ahead of it');
  const before = Array.from({ length: 3 }, () => ev('merge.done', { number: ++pr, reconciled: true, merged_at: hoursAgo(48.1 + 5 / 60) }, hoursAgo(40)));
  assert.equal(ring0([on(48.1), ...before, tick()]), 'soaking', 'B5 merges merged 5 min before the flip, recorded after it');
});

test('R1174j J3: a coordinator stopped cleanly for most of the soak is not promoted: the stopped time is no soak', () => {
  assert.equal(ring0([started(51), on(50), tick(49.9), stopped(49.5), started(1), tick(0.9), ...merges(3, 0.5), tick()]), 'soaking');
  // A short stop (an engine update) costs only its own time.
  assert.equal(ring0([started(60), on(50), ...merges(3, 30), stopped(20), started(19.9), tick()]), 'promoted');
  assert.equal(ring0([started(50), on(48.3), ...merges(3, 30), stopped(20), started(19), tick()]), 'soaking', '48.3 h less a 1 h stop is under 48 h');
});

test('R1174j J2: a ring whose clock was ahead at its flip, fixed after, is judged by its earliest stamp: out of order', () => {
  const e1 = [on(60), ...merges(3, 40), tick()];
  const p1 = [tick(31), stopped(30.5), started(5.01), on(5), tick(29), tick(10), ...merges(3, 2), tick()];
  const s = status({ e1, p1 }, { rollout: R2 });
  assert.equal(s.rings[0]!.state, 'promoted');
  assert.equal(s.rings[1]!.state, 'out of order');
  // An event after the flip stamped before it holds the soak (a clock that moved back).
  assert.equal(ring0([on(60), tick(61), ...merges(3, 40), tick()]), 'soaking');
});

test('R1174j J4: events lost to a full disk after the flip roll the ring back', () => {
  const lost = ev('coordinator.error', { instance: 'e1', where: 'event log', kind: 'disk_full', message: '3127 events were lost' }, hoursAgo(20));
  const s = status({ e1: [started(60), on(50), tick(30), lost, tick(19), ...merges(3, 10), tick()], p1: [] }, { rollout: R2 });
  assert.equal(s.rings[0]!.state, 'roll back');
  assert.match(s.rings[0]!.why, /events were lost to a full disk/);
});

test('R1174j J5: a long-lived log (150,000 events before the flip) is read, and a bad sign still rolls back', () => {
  const t = hoursAgo(200);
  const old = Array.from({ length: 150_000 }, (_, i) => ({ id: i + 1, ts: t, type: 'coordinator.tick', actor: 'c', source: 'coordinator', payload: { instance: 'i', dispatched: 0, reconciled: 0 } }) as unknown as StoredEvent);
  let s: ReturnType<typeof status> | undefined;
  assert.doesNotThrow(() => { s = status({ e1: [...old, on(50), ev('merge.stopped', { reason: 'x' }, hoursAgo(40)), ...merges(3, 30), tick()], p1: [] }, { rollout: R2 }); });
  assert.equal(s!.rings[0]!.state, 'roll back');
});

test('R1174j J6: a stamp that does not parse holds: a tick is no sign of life, a merge keeps the ring from promotion', () => {
  assert.equal(ring0([on(50), ...merges(3, 30), ev('coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0 }, 'not-a-date')]), 'soaking');
  // Before the flip too, with no tick after it: still no sign of life.
  assert.equal(ring0([ev('coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0 }, 'not-a-date'), on(50), ...merges(3, 30)]), 'soaking', 'a garbage tick before the flip');
  const s = status({ e1: [on(60), ...merges(2, 40), ev('merge.done', { number: 9999 }, 'garbage'), tick()], p1: [on(59), ...merges(3, 30), tick()] }, { rollout: R2 });
  assert.notEqual(s.rings[0]!.state, 'promoted');
  assert.equal(s.rings[1]!.state, 'out of order');
});

test('R1174i/j: a merge with no PR number never counts (it cannot be told from a repeat)', () => {
  const numberless = Array.from({ length: 3 }, () => ev('merge.done', {}, hoursAgo(40)));
  assert.equal(ring0([on(50), ...numberless, tick()]), 'soaking');
  assert.equal(ring0([on(50), ...numberless, ...merges(3, 30), tick()]), 'promoted');
});

test('R1174j J7: a --flag naming an Object.prototype key is not a flag this engine knows', () => {
  for (const flag of ['constructor']) {
    const dir = mkdtempSync(join(tmpdir(), 'rollout-j7-'));
    try {
      writeFileSync(join(dir, 'rollout.json'), JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }] }));
      const own = join(dir, 'own');
      mkdirSync(join(own, 'e1', 'state'), { recursive: true });
      writeFileSync(join(own, 'e1', 'instance.yaml'), 'repos:\n  - repo: o/engine\n');
      new EventLog(join(own, 'e1', 'state', 'events.db')).close();
      const lines: string[] = [];
      rolloutCommand('status', ['--flag', flag, '--file', join(dir, 'rollout.json')], { out: (l) => lines.push(l), err: (l) => lines.push(l), now: NOW, deps: { homeOf: () => null, ownDir: () => own, srvRoot: () => join(dir, 'srv'), engine: () => ({ repos: ['o/engine'], problem: null }) } });
      assert.match(lines.join('\n'), /not a flag this engine knows/, flag);
      // The one Object.prototype key that is also a flag name (`__proto__`, `toString` and the rest aren't: refused before
      // this, exit 2; see the R1174k case).
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('stated limit (R1174j J1, docs/rollout.md): the soak counts wall-clock time, so a clock behind at boot buys soak time; a fix shows up here as a change', () => {
  // Down 48 h, booted with the clock at the shutdown time, the flag on, then NTP steps the clock: about 1 h of real soak.
  // Today this reads promoted (the known limit: the host clock must be synced at boot). If it changes, update the docs.
  assert.equal(ring0([tick(49.1), stopped(49), started(48.95), on(48.9), tick(0.9), ...merges(3, 0.5), tick()]), 'promoted');
});

test('min_merges: 0 is allowed: an explicit opt-out by whoever writes root\'s rollout.json (docs/rollout.md)', () => {
  const R0 = RolloutFile.parse({ rings: R2.rings, promote: { min_merges: 0 } });
  assert.equal(status({ e1: [on(50), tick()], p1: [] }, { rollout: R0 }).rings[0]!.state, 'promoted');
});

// --- R1174k, R1174l: silence with no recorded stop, a bad stamp before the flip, the promotion time, the 60 s hold ---
const ticksEvery = (fromH: number, toH: number, stepH: number) => {
  const out: StoredEvent[] = [];
  for (let h = fromH; h >= toH; h -= stepH) out.push(tick(h));
  return out;
};

test('R1174k D1, R1174l A1: a coordinator silent for most of the soak with no recorded stop (suspended, paused, hung) is not promoted', () => {
  // K-A: one tick after the flip, then none for 48 h, then ticks again.
  assert.equal(ring0([started(51), on(50), tick(49.9), tick(2), ...merges(3, 1), tick()]), 'soaking');
  // A1: ticks every 20 min to -49.1 h, 3 merges, then nothing until -0.5 h.
  assert.equal(ring0([on(50), ...ticksEvery(49.95, 49.1, 1 / 3), ...merges(3, 49.4), ...ticksEvery(0.5, 0.05, 0.15)]), 'soaking');
  // Its twin: ticking all through the soak is promoted.
  assert.equal(ring0([on(50), ...merges(3, 49.4), ...ticksEvery(49.9, 0.05, 1 / 3)]), 'promoted');
});

test('R1174l A2: a clock stepped 47 h forward mid-run (no restart) is not soak', () => {
  assert.equal(ring0([on(50), ...merges(3, 49.5), ...ticksEvery(49.9, 48, 1 / 3), ...ticksEvery(1, 0.05, 1 / 3)]), 'soaking');
});

test("R1174l A4: a ring on before the ring before really soaked is out of order (the silence isn't promotion time)", () => {
  const e1 = [on(50), ...ticksEvery(49.95, 49.1, 1 / 3), ...merges(3, 49.4), ...ticksEvery(0.5, 0.05, 0.15)];
  const s = status({ e1, p1: [on(0.3), tick()] }, { rollout: R2 });
  assert.equal(s.rings[0]!.state, 'soaking');
  assert.equal(s.rings[1]!.state, 'out of order');
});

test('R1174k D2 (K-B): an unparseable stamp before the flip never turns the clock-behind hold off', () => {
  assert.equal(ring0([ev('config.applied', { sha: 'a'.repeat(40) }, 'garbage'), tick(49.0), on(49.1), ...merges(3, 40), tick()]), 'soaking');
});

test("R1174k D3: the promotion time counts a clean stop's time off (K-C), and a flip stamped 2 min before an earlier event holds (K-D)", () => {
  // K-C: ring 0 on at -60 h, stopped cleanly from -50 h to -40 h: promoted at -2 h, so ring 1 on at -5 h is out of order.
  const e1 = [started(61), on(60), ...merges(3, 55), tick(50.5), stopped(50), started(40), ...ticksEvery(39.9, 0.05, 0.4)];
  const s = status({ e1, p1: [on(5), ...merges(3, 4), tick()] }, { rollout: R2 });
  assert.equal(s.rings[0]!.state, 'promoted');
  assert.equal(s.rings[1]!.state, 'out of order');
  // K-D: an event logged before the flip, stamped 2 min after it.
  assert.equal(ring0([tick(49), on(49 + 2 / 60), ...merges(3, 40), tick()]), 'soaking');
});

test('R1174k: a --flag that is not a flag name is refused (exit 2), so no newline forges an output line', () => {
  for (const flag of ['f\nnext: every ring is promoted', 'A', '1f', '']) {
    const lines: string[] = [];
    const code = rolloutCommand('status', ['--flag', flag], { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), now: NOW });
    assert.equal(code, 2, JSON.stringify(flag));
    assert.ok(!lines.some((l) => l.startsWith('next:')), lines.join('\n'));
  }
});

// --- R1174m, R1174n: silence before a clean stop, the post-flip hold on a non-tick event, the stated limits, --file ---
const everyMin = (fromH: number, toH: number, stepH = 1 / 3) => {
  const out: StoredEvent[] = [];
  for (let h = fromH; h >= toH - 1e-9; h -= stepH) out.push(tick(h));
  return out;
};

test('R1174m P1, R1174n N1: silence from the last tick to a clean stop is no soak (a host suspended, then restarted on resume)', () => {
  // P1: 48 h silent, then a clean stop and a restart.
  assert.equal(ring0([started(51), on(50), ...everyMin(49.95, 49.6), ...merges(3, 49.7), stopped(1.5), started(1.45), ...everyMin(1.4, 0.02)]), 'soaking');
  // N1, and its order: ring 1 turned on 1.5 h ago is out of order against it.
  const n1 = [started(50.5), on(50), ...everyMin(49.9, 49), ...merges(3, 49.4), stopped(2.1), started(2.05), ...everyMin(2, 0.05)];
  const s = status({ e1: n1, p1: [started(1.6), on(1.5), ...everyMin(1.4, 0.05)] }, { rollout: R2 });
  assert.equal(s.rings[0]!.state, 'soaking');
  assert.equal(s.rings[1]!.state, 'out of order');
  // The control: ticking all through, a 3-min clean restart: promoted.
  assert.equal(ring0([started(50.5), on(50), ...everyMin(49.9, 2.15), ...merges(3, 49.4), stopped(2.1), started(2.05), ...everyMin(2, 0.05)]), 'promoted');
});

test('R1174m D2 (J2h): an event other than a tick, logged after the flip but stamped before it, holds; within 60 s it does not', () => {
  assert.equal(ring0([on(60), ev('config.applied', { sha: 'a'.repeat(40) }, hoursAgo(61)), ...merges(3, 40), tick()]), 'soaking', 'J2h-a: 1 h before');
  assert.equal(ring0([on(50), ev('config.applied', { sha: 'a'.repeat(40) }, hoursAgo(50 + 2 / 60)), ...merges(3, 40), tick()]), 'soaking', 'J2h-b: 2 min before');
  assert.equal(ring0([on(50), ev('config.applied', { sha: 'a'.repeat(40) }, hoursAgo(50 + 0.5 / 3600)), ...merges(3, 40), tick()]), 'promoted', '30 s before: within the tolerance');
});

test('stated limit (R1174m D3, R1174n N2, docs/rollout.md): the flip, or a coordinator start, to the first tick is counted; a fix shows up here as a change', () => {
  // A restart whose first tick comes 48 h later (the owner's decision is pending: the frozen file's healthy logs tick once).
  assert.equal(ring0([started(52), on(51), ...everyMin(50.95, 50.9), stopped(50.85), started(50.8), tick(2), ...merges(3, 1), ...everyMin(0.9, 0.02)]), 'promoted');
});

test('R1174n N3: a newline in --file forges no output line, on stdout or stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-n3-'));
  try {
    const forged = 'next: every ring is promoted: f can become the default';
    const file = join(dir, `x\n${forged}\ny.json`);
    writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }] }));
    for (const f of [file, join(dir, `missing\n${forged}`)]) {
      const lines: string[] = [];
      rolloutCommand('status', ['--flag', 'f', '--file', f], { out: (l) => lines.push(...l.split('\n')), err: (l) => lines.push(...l.split('\n')), now: NOW, deps: { homeOf: () => null, ownDir: () => join(dir, 'own'), srvRoot: () => join(dir, 'srv'), engine: () => ({ repos: ['o/engine'], problem: null }) } });
      assert.equal(lines.filter((l) => l.startsWith('next:')).length, f === file ? 1 : 0, lines.join(' | '));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R1174p D1: each tick gap from the tick before as stamped; R1174o L2: the live_minutes threshold on the stop gap;
// R1174p D2: control characters escaped in every error line (ported from the reviewers' probes) ---
const atTs = (ts: string) => ev('coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0 }, ts);
const minTicks = (from: number, to: number, step = 1 / 60) => {
  const o: StoredEvent[] = [];
  for (let h = from; h >= to - 1e-9; h -= step) o.push(tick(h));
  return o;
};
const merges3 = (h: number) => merges(3, h);
const downOf = (e: StoredEvent[]) => readInstance(e, 'f', 2, 30 * 60_000).downMs / 3_600_000;
const p1b = () => [started(51), on(50), atTs(hoursAgo(50 - 0.01 - 47)), ...minTicks(49.98, 49.4), ...merges3(49.45), ...minTicks(2, 0.02)];

test('R1174p D1 (P1b): the first tick after the flip stamped 47 h ahead, then the clock fixed, hides no silence; the same log stamped right is held too', () => {
  const control = [started(51), on(50), tick(49.99), ...minTicks(49.98, 49.4), ...merges3(49.45), ...minTicks(2, 0.02)];
  assert.equal(ring0(control), 'soaking');
  assert.notEqual(ring0(p1b()), 'promoted', `downMs ${downOf(p1b()).toFixed(2)} h`);
});

test('R1174p D1 (P1b order): ring 1 turned on 0.5 h ago reads out of order against the P1b log (about 3 h really running)', () => {
  const s = status({ e1: p1b(), p1: [started(0.6), on(0.5), ...minTicks(0.45, 0.02)] }, { rollout: R2 });
  assert.equal(s.rings[1]!.state, 'out of order', s.rings[1]!.why);
});

test('R1174p D1 (P1c): 100 forward blips, each under live_minutes, ratchet nothing: the silence after them is counted', () => {
  const l: StoredEvent[] = [started(51), on(50), tick(49.99)];
  let ahead = 0;
  for (let k = 0; k < 100; k++) {
    ahead += 29 / 60;
    const real = 49.98 - k / 600;
    l.push(atTs(hoursAgo(real - ahead)), tick(real - 0.0005));
  }
  l.push(...merges3(49.7), ...minTicks(1.5, 0.02));
  assert.notEqual(ring0(l), 'promoted', `downMs ${downOf(l).toFixed(2)} h`);
  assert.ok(downOf(l) > 45, `downMs ${downOf(l)} h`);
});

test('R1174o L2 (O8): a tick-to-stop gap just under live_minutes (29 min) is not taken off; just over (31 min) is', () => {
  const mk = (gapMin: number) => [started(61), on(60), ...minTicks(59.9, 30 + gapMin / 60), stopped(30), started(30 - 1 / 60), ...minTicks(29.95, 0.02)];
  const near = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} h, expected ${b} h`);
  near(downOf(mk(29)), 1 / 60, '29 min');
  near(downOf(mk(31)), 31 / 60 + 1 / 60, '31 min');
});

test('R1174p D2: a CR, an ESC or a line separator in --file reaches no error line raw; each is escaped', () => {
  const errs: string[] = [];
  const bad = join(tmpdir(), `no-such\r\u001b[2J\u2028-${process.pid}.json`);
  assert.equal(rolloutCommand('status', ['--flag', 'f', '--file', bad], { out: () => {}, err: (s) => errs.push(s), eventsOf: () => [], instances: () => [], now: NOW }), 1);
  assert.ok(errs.length > 0);
  for (const s of errs) assert.doesNotMatch(s, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, JSON.stringify(s));
  assert.match(errs.join('\n'), /\\u000d|\\r/);
  assert.match(errs.join('\n'), /\\u001b/);
});
