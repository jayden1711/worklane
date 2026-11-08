import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredEvent } from '../src/events/types.js';
import { RolloutFile, rolloutStatus, type Rollout } from '../src/rollout.js';
import { readEvents, rolloutCommand } from '../src/rollout-cli.js';
import { EventLog } from '../src/events/log.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let id = 0;
const ev = (type: string, payload: Record<string, unknown>, ts: string): StoredEvent => ({ id: ++id, ts, type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
const on = (h: number, flag = 'f') => ev('flag.flipped', { flag, from: false, to: true, sha: null }, hoursAgo(h));
const off = (h: number, flag = 'f') => ev('flag.flipped', { flag, from: true, to: false, sha: null }, hoursAgo(h));
const merges = (n: number, h: number) => Array.from({ length: n }, () => ev('merge.done', { number: 1 }, hoursAgo(h)));

const R: Rollout = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }, { name: 'second', instances: ['p2', 'p3'] }] });
const status = (logs: Record<string, StoredEvent[]>, flag = 'f') => rolloutStatus({ rollout: R, flag, logs: new Map(Object.entries(logs)), now: NOW });
const states = (s: ReturnType<typeof status>) => s.rings.map((r) => r.state);
const quiet = { e1: [], p1: [], p2: [], p3: [] };

test('rollout: ring 0 first; a ring is promoted only after soaking its hours with its merges and nothing going wrong; then the next ring turns on', () => {
  let s = status(quiet);
  assert.deepEqual(states(s), ['off', 'off', 'off']);
  assert.equal(s.next, 'turn it on for ring engine: set `flags.f: true` in the config.yaml of e1 (a PR in each repo)');
  s = status({ ...quiet, e1: [on(10), ...merges(1, 5)] });
  assert.deepEqual(states(s), ['soaking', 'off', 'off']);
  assert.match(s.next, /^wait: ring engine is soaking \(10 of 48 h, 1 of 3 merges\)/);
  s = status({ ...quiet, e1: [on(50), ...merges(2, 5)] });
  assert.equal(s.rings[0]!.state, 'soaking', 'the hours alone are not enough');
  s = status({ ...quiet, e1: [on(50), ...merges(3, 5)] });
  assert.deepEqual(states(s), ['promoted', 'off', 'off']);
  assert.equal(s.next, 'turn it on for ring first: set `flags.f: true` in the config.yaml of p1 (a PR in each repo)');
  s = status({ e1: [on(200), ...merges(3, 150)], p1: [on(60), ...merges(4, 10)], p2: [on(50), ...merges(3, 5)], p3: [on(49), ...merges(1, 5)] });
  assert.deepEqual(states(s), ['promoted', 'promoted', 'promoted'], "a ring's merges are counted across its instances");
  assert.match(s.next, /^every ring is promoted: f can become the default/);
});

test('rollout: anything going wrong in a ring after its flag went on rolls it back, and every later ring that is on too; before the flip it does not count', () => {
  const healthy0 = [on(100), ...merges(3, 50)];
  for (const [bad, why] of [
    [ev('merge.stopped', { by: 'red_main' }, hoursAgo(5)), 'auto-merge stopped'],
    [ev('merge.main_result', { outcome: 'red' }, hoursAgo(5)), 'went red'],
    [ev('merge.main_result', { outcome: 'timed_out' }, hoursAgo(5)), 'unknown (timed out)'],
    [ev('config.invalid', { sha: 'a', errors: [] }, hoursAgo(5)), 'config went invalid'],
    [ev('testrun.fault', { fault: 'gpu_lost' }, hoursAgo(5)), 'machine fault (gpu_lost)'],
  ] as const) {
    const s = status({ e1: healthy0, p1: [on(20), bad], p2: [], p3: [] });
    assert.deepEqual(states(s), ['promoted', 'roll back', 'off'], why);
    assert.match(s.next, new RegExp(`^roll back ring first \\(p1: .*${why.replace(/[()]/g, '\\$&')}.*\\): set \`flags.f: false\` in the config.yaml of p1`), s.next);
  }
  const s = status({ e1: [ev('merge.stopped', {}, hoursAgo(200)), ...healthy0], ...{ p1: [], p2: [], p3: [] } });
  assert.equal(s.rings[0]!.state, 'promoted', 'a stop before the flag went on is not the change\'s');
  assert.equal(status({ e1: healthy0, p1: [ev('merge.main_result', { outcome: 'green' }, hoursAgo(1)), on(60), ...merges(3, 5)], p2: [], p3: [] }).rings[1]!.state, 'promoted', 'a green main is fine');
  // Ring 1 bad while ring 2 is on too (out of order): both are named in the roll back.
  const both = status({ e1: healthy0, p1: [on(20), ev('merge.stopped', {}, hoursAgo(5))], p2: [on(10)], p3: [on(10)] });
  assert.match(both.next, /config\.yaml of p1 \(a PR in each repo\); then set `flags\.f: false` in the config\.yaml of p2, p3/);
});

test('rollout: one unreadable log never hides a rollback: a bad sign, or a ring on out of order, still says roll back (#1174 review A1, A2)', () => {
  const two = (rings: { name: string; instances: string[] }[], logs: Record<string, StoredEvent[]>) => rolloutStatus({ rollout: RolloutFile.parse({ rings }), flag: 'f', logs: new Map(Object.entries(logs)), now: NOW });
  // A1: a is on with an auto-merge stop since the flip; b's log can't be read.
  const a1 = two([{ name: 'engine', instances: ['a', 'b'] }], { a: [on(5), ev('merge.stopped', { by: 'red_main' }, hoursAgo(2))] });
  assert.equal(a1.rings[0]!.state, 'roll back');
  assert.match(a1.rings[0]!.why, /^a: auto-merge stopped; and can't read the event log of b$/);
  assert.match(a1.next, /^roll back ring engine .*set `flags\.f: false` in the config\.yaml of a, b/);
  // A2: ring engine on for an hour (not promoted); in ring p, c has had it on for 8 days, d's log can't be read.
  const a2 = two([{ name: 'engine', instances: ['e'] }, { name: 'p', instances: ['c', 'd'] }], { e: [on(1)], c: [on(8 * 24)] });
  assert.deepEqual(a2.rings.map((r) => r.state), ['soaking', 'out of order']);
  assert.match(a2.rings[1]!.why, /; and can't read the event log of d$/);
  assert.match(a2.next, /^roll back ring p .*config\.yaml of c, d/);
  // With nothing calling for a rollback, an unread log still holds the ring: nothing is promoted on it.
  const held = two([{ name: 'engine', instances: ['a', 'b'] }], { a: [on(100), ...merges(3, 50)] });
  assert.equal(held.rings[0]!.state, 'soaking');
  assert.match(held.next, /^wait: ring engine is soaking \(can't read the event log of b: nothing is promoted on an unread log\)/);
});

test('rollout: a ring on before the one before it was promoted is out of order; a ring on in some instances is partial; an unread log promotes nothing', () => {
  let s = status({ e1: [on(10)], p1: [on(5)], p2: [], p3: [] });
  assert.deepEqual(states(s), ['soaking', 'out of order', 'off']);
  assert.match(s.next, /^roll back ring first \(on before the ring before it was promoted/);
  s = status({ e1: [on(100), ...merges(3, 50)], p1: [on(100), ...merges(3, 50)], p2: [on(60), ...merges(3, 10)], p3: [] });
  assert.equal(s.rings[2]!.state, 'partial');
  assert.match(s.next, /^wait: ring second is partial \(on in 1 of 2 instances/);
  s = status({ e1: [on(100), ...merges(3, 50)], p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'off');
  assert.match(s.rings[1]!.why, /can't read the event log of p1: nothing is promoted on an unread log/);
  assert.match(status({ p1: [], p2: [], p3: [] }).rings[0]!.why, /can't read the event log of e1/);
  // Turned off again: off, and the next step is to turn it on again only when the operator chooses (it says so).
  s = status({ ...quiet, e1: [on(100), off(50)] });
  assert.equal(s.rings[0]!.state, 'off');
  // Another flag's flips are not this one's.
  assert.equal(status({ ...quiet, e1: [on(100, 'g'), ...merges(3, 50)] }).rings[0]!.state, 'off');
});

test('rollout.json: rings in order, each instance in one ring only, names without paths; promotion defaults 48 h and 3 merges', () => {
  assert.deepEqual(RolloutFile.parse({ rings: [{ name: 'a', instances: ['x'] }] }).promote, { soak_hours: 48, min_merges: 3 });
  for (const bad of [
    { rings: [] },
    { rings: [{ name: 'a', instances: [] }] },
    { rings: [{ name: 'a', instances: ['x'] }, { name: 'b', instances: ['x'] }] },
    { rings: [{ name: 'a', instances: ['../etc'] }] },
    { rings: [{ name: 'A B', instances: ['x'] }] },
    { rings: [{ name: 'a', instances: ['x'] }], promote: { soak_hours: 0 } },
    { rings: [{ name: 'a', instances: ['x'] }], extra: true },
  ]) assert.equal(RolloutFile.safeParse(bad).success, false, JSON.stringify(bad));
});

test("rollout status reads an instance's real event log read-only: the flips and merges as stored", () => {
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

test('rollout status: prints each ring and the next step; exit 1 when the file or a log cannot be used; 2 a usage error; it never writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-'));
  const file = join(dir, 'rollout.json');
  writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }));
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[], eventsOf: (n: string) => StoredEvent[]) => rolloutCommand(args[0], args.slice(1), { out: (s) => out.push(s), err: (s) => err.push(s), eventsOf, now: NOW });
  try {
    assert.equal(run(['status', '--flag', 'f', '--file', file], () => []), 0);
    assert.deepEqual(out.slice(-3), ['ring 0 engine (e1): off: the flag is off in every instance of this ring', 'ring 1 first (p1): off: the flag is off in every instance of this ring', 'next: turn it on for ring engine: set `flags.f: true` in the config.yaml of e1 (a PR in each repo)']);
    assert.match(out.join('\n'), /note: f is not a flag this engine knows/);
    assert.equal(run(['status', '--flag', 'f', '--file', file], (n) => (n === 'p1' ? (() => { throw new Error('EACCES'); })() : [])), 1);
    assert.match(err.at(-1)!, /can't read p1's event log: EACCES/);
    assert.equal(run(['status', '--flag', 'f', '--file', join(dir, 'none.json')], () => []), 1);
    assert.equal(run(['status'], () => []), 2);
    assert.equal(run(['flip', '--flag', 'f'], () => []), 2, 'there is no command that flips a flag');
    assert.equal(run(['status', '--flag', 'f', '--force', 'x'], () => []), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
