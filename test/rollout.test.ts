import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import type { StoredEvent } from '../src/events/types.js';
import { readEvents } from '../src/events/read-only.js';
import { ROLLOUT_FILE, RolloutFile, readRollout, ringZeroProblem, rolloutStatus, type Rollout } from '../src/rollout.js';
import { rolloutCommand, type RolloutDeps } from '../src/rollout-cli.js';
import { EventLog } from '../src/events/log.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let id = 0;
const ev = (type: string, payload: Record<string, unknown>, ts: string): StoredEvent => ({ id: ++id, ts, type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
const on = (h: number, flag = 'f') => ev('flag.flipped', { flag, from: false, to: true, sha: null }, hoursAgo(h));
const off = (h: number, flag = 'f') => ev('flag.flipped', { flag, from: true, to: false, sha: null }, hoursAgo(h));
const merges = (n: number, h: number) => Array.from({ length: n }, () => ev('merge.done', { number: 1 }, hoursAgo(h)));
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
  assert.match(s.next, /^wait: ring engine is soaking \(10 of 48 h, 1 of 3 merges\)/);
  s = status({ ...quiet, e1: [on(50), ...merges(2, 5), tick()] });
  assert.equal(s.rings[0]!.state, 'soaking', 'the hours alone are not enough');
  s = status({ ...quiet, e1: healthy(50) });
  assert.deepEqual(states(s), ['promoted', 'off', 'off']);
  assert.equal(s.next, 'turn it on for ring first: set `flags.f: true` in the config.yaml of p1 (a PR in each repo)');
  // Each ring turned on after the one before it was promoted (its hours and merges both done).
  s = status({ e1: healthy(300, 3, 250), p1: healthy(240, 4, 190), p2: healthy(100, 3, 50), p3: [on(99), ...merges(1, 50), tick()] });
  assert.deepEqual(states(s), ['promoted', 'promoted', 'promoted'], "a ring's merges are counted across its instances");
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
  assert.equal(status({ e1: healthy(100, 3, 60), p1: [on(70), off(55), ...healthy(50, 3, 20)], p2: [], p3: [] }).rings[1]!.state, 'promoted');
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
    assert.match(out.join('\n'), /note: .*rollout\.json is read as it is, not as root's rollout\.json/);
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
