// #1231's acceptance bar for the canary rollout (#1174): every attack the reviews found, as a must-fail case. Each
// test asserts the SAFE outcome, so a failing test is an attack that works. Sources (the attack files the reviews
// kept): R1174d (r1174d-attacks.test.ts), R1174f (r1174f-attacks.test.ts), R1174g (r1174g-attacks.test.ts), R1174h
// (attacks-1174h/r1174h-attacks.test.ts). Frozen: a change to this file needs its own acceptance review (#1231).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import type { StoredEvent } from '../../src/events/types.js';
import { EventLog } from '../../src/events/log.js';
import { ROLLOUT_FILE, RolloutFile, readRollout, ringZeroProblem, rolloutStatus, type Rollout } from '../../src/rollout.js';
import { rolloutCommand, type RolloutDeps } from '../../src/rollout-cli.js';
import { onRealMachine } from '../isolate.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let id = 0;
const ev = (type: string, payload: Record<string, unknown>, ts: string): StoredEvent => ({ id: ++id, ts, type, actor: 'c', source: 'coordinator', payload }) as unknown as StoredEvent;
const SHA = 'c'.repeat(40);
/** A flip from a config commit. */
const on = (h: number) => ev('flag.flipped', { flag: 'f', from: false, to: true, sha: SHA }, hoursAgo(h));
const off = (h: number) => ev('flag.flipped', { flag: 'f', from: true, to: false, sha: SHA }, hoursAgo(h));
/** The engine's own off: it read no config from the default branch, and ran with the flag off. */
const nullOff = (h: number) => ev('flag.flipped', { flag: 'f', from: true, to: false, sha: null }, hoursAgo(h));
let pr = 0;
const merges = (n: number, h: number) => Array.from({ length: n }, () => ev('merge.done', { number: ++pr }, hoursAgo(h)));
const tick = (h = 0.05) => ev('coordinator.tick', { instance: 'i', dispatched: 0, reconciled: 0 }, hoursAgo(h));
const healthy = (h: number, m = h - 10) => [on(h), ...merges(3, m), tick()];

const R: Rollout = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }, { name: 'second', instances: ['p2', 'p3'] }] });
const status = (logs: Record<string, StoredEvent[]>, o: { rollout?: Rollout; outsideNames?: string[]; outside?: Record<string, StoredEvent[]> } = {}) =>
  rolloutStatus({ rollout: o.rollout ?? R, flag: 'f', logs: new Map(Object.entries(logs)), now: NOW, ringZero: null, listing: null, ...(o.outside || o.outsideNames ? { outside: new Map(Object.entries(o.outside ?? {})), outsideNames: o.outsideNames ?? Object.keys(o.outside ?? {}) } : {}) });
const notTurnOn = (next: string, why: string) => assert.doesNotMatch(next, /^turn it on|^every ring is promoted/, `${why}: ${next}`);

// --- R1174d ---

test('R1174d A1: a ring turned on together with ring 0 is not promoted once ring 0 is', () => {
  const s = status({ e1: healthy(60, 30), p1: healthy(60, 30), p2: [], p3: [] });
  assert.notEqual(s.rings[1]!.state, 'promoted', s.rings[1]!.why);
});

test('R1174d A1b: every ring on at once, 60 h ago, never reads "every ring is promoted"', () => {
  const s = status({ e1: healthy(60, 30), p1: healthy(60, 30), p2: healthy(60, 30), p3: healthy(60, 30) });
  assert.doesNotMatch(s.next, /every ring is promoted/);
});

test('R1174d A1c: a ring turned on before ring 0 is not promoted once ring 0 catches up', () => {
  const s = status({ e1: healthy(50, 30), p1: healthy(100, 30), p2: [], p3: [] });
  assert.notEqual(s.rings[1]!.state, 'promoted', s.rings[1]!.why);
});

test('R1174d A2: a clock stepped back after the flip never hides a later merge.stopped', () => {
  const s = status({ e1: [on(60), ev('merge.stopped', { by: 'red_main' }, hoursAgo(62)), ...merges(3, 30), tick()], p1: [], p2: [], p3: [] });
  assert.equal(s.rings[0]!.state, 'roll back', s.rings[0]!.why);
});

test('R1174d A3: off, then on again, keeps a trace of the earlier rollback', () => {
  const s = status({ e1: [on(200), ev('merge.stopped', { by: 'red_main' }, hoursAgo(150)), off(149), ...healthy(60, 30)], p1: [], p2: [], p3: [] });
  assert.match(s.rings[0]!.why, /rolled back before/);
});

test('R1174d A4: an unread later ring holds turning an earlier ring on', () => {
  notTurnOn(status({ e1: healthy(100, 50), p1: [] }).next, 'ring second unread');
});

test('R1174d A5: coordinator errors after the flip are a bad sign', () => {
  const errors = Array.from({ length: 20 }, () => ev('coordinator.error', { instance: 'e1', where: 'tick', kind: 'TypeError', message: 'x' }, hoursAgo(40)));
  assert.notEqual(status({ e1: [on(60), ...errors, ...merges(3, 30), tick()], p1: [], p2: [], p3: [] }).rings[0]!.state, 'promoted');
});

test('R1174d A9: a coordinator that died (crash restarts, no tick since) is not promoted', () => {
  const started = (h: number, pid: number) => ev('coordinator.started', { instance: 'e1', pid, version: 'x' }, hoursAgo(h));
  const s = status({ e1: [on(60), started(60, 1), ...merges(3, 58), started(58, 2), started(58, 3)], p1: [], p2: [], p3: [] });
  assert.notEqual(s.rings[0]!.state, 'promoted', s.rings[0]!.why);
});

test("R1174d A6: ring 0 must be the engine's own repo: a project as ring 0 is a problem, and status then turns nothing on", () => {
  const r = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['p1'] }] });
  const problem = ringZeroProblem({ rollout: r, repos: new Map([['p1', ['o/p1']], ['e1', ['example/engine']]]), engine: ['example/engine'], outsideNames: ['e1'] });
  assert.ok(problem);
  notTurnOn(rolloutStatus({ rollout: r, flag: 'f', logs: new Map([['p1', []]]), now: NOW, ringZero: problem, listing: null }).next, 'ring 0 not the engine');
});

test("R1174d A7: root's rollout.json through a link, or writable by others, is refused", { skip: process.platform === 'win32' }, () => {
  const file = ROLLOUT_FILE();
  assert.equal(onRealMachine(file), `/etc/${BRAND.cli}/rollout.json`);
  mkdirSync(dirname(file), { recursive: true });
  const me = process.getuid!();
  const elsewhere = join(dirname(file), 'acceptance-elsewhere.json');
  try {
    writeFileSync(elsewhere, JSON.stringify({ rings: [{ name: 'engine', instances: ['p1'] }], promote: { soak_hours: 1, min_merges: 0 } }), { mode: 0o666 });
    chmodSync(elsewhere, 0o666);
    symlinkSync(elsewhere, file);
    assert.throws(() => readRollout(undefined, me), /link/);
    rmSync(file);
    writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['p1'] }] }), { mode: 0o666 });
    chmodSync(file, 0o666);
    assert.throws(() => readRollout(undefined, me));
  } finally {
    rmSync(file, { force: true });
    rmSync(elsewhere, { force: true });
  }
});

// --- R1174f ---

test('R1174f A1: a replayed on never restarts the on-period: an earlier red main, or an out-of-order start, stays', () => {
  let s = status({ e1: healthy(300, 250), p1: [on(100), ev('merge.main_result', { outcome: 'red' }, hoursAgo(90)), on(70), ...merges(3, 60), tick()], p2: [], p3: [] });
  assert.notEqual(s.rings[1]!.state, 'promoted', s.rings[1]!.why);
  s = status({ e1: healthy(300, 250), p1: [on(280), on(100), ...merges(3, 60), tick()], p2: [], p3: [] });
  assert.notEqual(s.rings[1]!.state, 'promoted', s.rings[1]!.why);
});

test("R1174f A2: after the engine's own off, status never advises setting the flag true in a repo whose config already says so", () => {
  const p1 = [on(280), ev('config.invalid', { sha: 'b', errors: [] }, hoursAgo(200)), nullOff(199)];
  assert.doesNotMatch(status({ e1: healthy(300, 250), p1, p2: [], p3: [] }).next, /set `flags\.f: true` in the config\.yaml of p1/);
  // And on again later: the earlier bad sign isn't wiped from what status says.
  const s = status({ e1: healthy(300, 250), p1: [...p1, on(150), ...merges(3, 60), tick()], p2: [], p3: [] });
  assert.ok(s.rings[1]!.state !== 'promoted' || /rolled back before/.test(s.rings[1]!.why), s.rings[1]!.why);
});

test("R1174f A3: an instance doing no work isn't promoted on the others' merges", () => {
  const idle = [ev('merge.stopped', { by: 'red_main' }, hoursAgo(120)), on(100), ...Array.from({ length: 20 }, (_, i) => tick((19 - i) * 0.4 + 0.05))];
  const s = status({ e1: healthy(400, 350), p1: healthy(300, 250), p2: healthy(100, 60), p3: idle });
  assert.notEqual(s.rings[2]!.state, 'promoted', s.rings[2]!.why);
  assert.doesNotMatch(s.next, /every ring is promoted/);
});

test('R1174f A4: one PR recorded three times is one merge', () => {
  const p1 = [on(60), ...[7, 7, 7].map((n) => ev('merge.done', { number: n }, hoursAgo(30))), tick()];
  assert.notEqual(status({ e1: healthy(300, 250), p1, p2: [], p3: [] }).rings[1]!.state, 'promoted');
});

test('R1174f A5: a last tick stamped in the future is no sign of life', () => {
  const e1 = [on(60), ...merges(3, 30), ev('coordinator.tick', { instance: 'e1', dispatched: 0, reconciled: 0 }, new Date(NOW.getTime() + 7 * 86_400_000).toISOString())];
  assert.notEqual(status({ e1, p1: [], p2: [], p3: [] }).rings[0]!.state, 'promoted');
});

/** Instance folders with an instance.yaml (repo) and an event log (events). */
function instancesAt(dir: string, defs: Record<string, { repo: string; events?: [string, Record<string, unknown>][] }>) {
  for (const [n, d] of Object.entries(defs)) {
    mkdirSync(join(dir, n, 'state'), { recursive: true });
    writeFileSync(join(dir, n, 'instance.yaml'), `version: 1\nname: ${n}\nrepos:\n  - path: /x\n    repo: ${d.repo}\n`);
    const log = new EventLog(join(dir, n, 'state', 'events.db'));
    for (const [t, p] of d.events ?? []) log.append(t as 'flag.flipped', p as never, n);
    log.close();
  }
}
const engine = () => ({ repos: ['example/engine'], problem: null });
const run = (file: string, deps: Partial<RolloutDeps>) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = rolloutCommand('status', ['--flag', 'f', '--file', file], { out: (l) => out.push(l), err: (l) => err.push(l), now: NOW, deps });
  return { code, out, err, next: out.at(-1) ?? '' };
};
const onFlip = ['flag.flipped', { flag: 'f', from: false, to: true, sha: SHA }] as [string, Record<string, unknown>];

test('R1174f A6: an instance folder that is a link is on the machine list, so its flag being on is seen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  try {
    const file = join(dir, 'rollout.json');
    writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }));
    const own = join(dir, 'own');
    instancesAt(own, { e1: { repo: 'example/engine' }, p1: { repo: 'o/p1' } });
    instancesAt(join(dir, 'disk2'), { x: { repo: 'o/x', events: [onFlip] } });
    symlinkSync(join(dir, 'disk2', 'x'), join(own, 'x'));
    const r = run(file, { ownDir: () => own, srvRoot: () => join(dir, 'no-srv'), homeOf: () => null, engine });
    assert.ok(r.out.some((l) => l.includes('outside the rollout')), r.out.join('\n'));
    notTurnOn(r.next, 'a linked instance with the flag on');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R1174f A7: a stale same-named folder in the running user's dir never wins over the live coordinator home", () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  try {
    const file = join(dir, 'rollout.json');
    writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }));
    const homes = join(dir, 'home');
    const homeInst = (n: string) => join(homes, `wl-${n}`, '.local', 'state', BRAND.cli, 'instances');
    instancesAt(homeInst('e1'), { e1: { repo: 'example/engine', events: [onFlip, ['merge.stopped', { reason: 'red main', number: null, sha: null, revert: null, by: 'red_main' }]] } });
    instancesAt(homeInst('p1'), { p1: { repo: 'o/p1' } });
    const srv = join(dir, 'srv');
    for (const n of ['e1', 'p1']) mkdirSync(join(srv, n), { recursive: true });
    const own = join(dir, 'own');
    instancesAt(own, { e1: { repo: 'example/engine' } });
    notTurnOn(run(file, { ownDir: () => own, srvRoot: () => srv, homeOf: (u) => join(homes, u), engine }).next, 'a stale own folder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R1174g ---

test("R1174g D1: the engine's own off (it ran with the flag off) then merges: the ring isn't promoted on merges made with the flag off, and the next ring isn't told to turn it on", () => {
  const R3 = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }, { name: 'second', instances: ['p2'] }] });
  const s = status({ e1: healthy(300), p1: [on(100), nullOff(90), ...merges(3, 40), tick()], p2: [] }, { rollout: R3 });
  assert.notEqual(s.rings[1]!.state, 'promoted', s.rings[1]!.why);
  assert.doesNotMatch(s.next, /^turn it on for ring second/);
});

/** A live e1 in its 0700 coordinator home (on, then main red: roll back), and a stale e1 in the user's own dir (off). */
function liveAndStale(dir: string) {
  const file = join(dir, 'rollout.json');
  writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }], promote: { min_merges: 0, soak_hours: 1 } }));
  const homes = join(dir, 'home');
  instancesAt(join(homes, 'wl-e1', '.local', 'state', BRAND.cli, 'instances'), { e1: { repo: 'example/engine', events: [onFlip, ['config.invalid', { sha: 'b'.repeat(40), errors: ['x'] }]] } });
  const own = join(dir, 'own');
  instancesAt(own, { e1: { repo: 'example/engine' } });
  return { file, homes, own };
}

test('R1174g D2 / R1174h H5: an unreadable coordinator home (a non-root run) is never "not there": status exits non-zero and never reads the stale folder', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  const { file, homes, own } = liveAndStale(dir);
  try {
    chmodSync(join(homes, 'wl-e1'), 0o000);
    const r = run(file, { ownDir: () => own, srvRoot: () => join(dir, 'no-srv'), homeOf: (u) => join(homes, u), engine });
    assert.notEqual(r.code, 0, `${r.out.join(' | ')} ${r.err.join(' | ')}`);
    notTurnOn(r.next, 'the stale folder read');
  } finally {
    chmodSync(join(homes, 'wl-e1'), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R1174h ---

test("R1174h H1: the engine had the flag off for 45 of the 48 soak hours: not promoted", () => {
  const e1 = [on(50), ev('coordinator.stopped', { instance: 'e1', clean: true, ms: 1, pending: [] }, hoursAgo(47.1)), ev('coordinator.started', { instance: 'e1', pid: 2, version: 'v' }, hoursAgo(47)), nullOff(47), on(2), ...merges(3, 1), tick()];
  const s = status({ e1, p1: [] }, { rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }) });
  assert.notEqual(s.rings[0]!.state, 'promoted', s.rings[0]!.why);
});

test('R1174h H2: a merge made before the flip, recorded after it, never counts toward min_merges', () => {
  const old = (n: number) => ev('merge.done', { number: n, reconciled: true, merged_at: hoursAgo(60) }, hoursAgo(49));
  const e1 = [ev('coordinator.started', { instance: 'e1', pid: 2, version: 'v' }, hoursAgo(50.1)), on(50), old(1), old(2), old(3), tick()];
  const s = status({ e1, p1: [] }, { rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }) });
  assert.notEqual(s.rings[0]!.state, 'promoted', s.rings[0]!.why);
});

test('R1174h H3a: a flip stamped by a clock behind (events before it are later) never satisfies the soak at once', () => {
  const e1 = [tick(1.1), on(49), ...merges(3, 0.5), tick()];
  const s = status({ e1, p1: [] }, { rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }) });
  assert.notEqual(s.rings[0]!.state, 'promoted', s.rings[0]!.why);
});

test('R1174h H3b: a later ring turned on while ring 0 soaked is out of order, whatever its flip says the time was', () => {
  const p1 = [tick(30.1), on(5), ...merges(3, 1), tick()];
  const s = status({ e1: [on(60), ...merges(3, 55), tick()], p1 }, { rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }) });
  assert.notEqual(s.rings[1]!.state, 'promoted', s.rings[1]!.why);
  notTurnOn(s.next, 'p1 on before ring 0 was promoted');
});

test('R1174h H4: a coordinator that stopped cleanly is not alive, however recent its last tick', () => {
  const e1 = [on(50), ...merges(3, 40), tick(0.4), ev('coordinator.stopped', { instance: 'e1', clean: true, ms: 1, pending: [] }, hoursAgo(0.33))];
  const s = status({ e1, p1: [] }, { rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }) });
  assert.notEqual(s.rings[0]!.state, 'promoted', s.rings[0]!.why);
});

// --- Healthy twins: the fixes must not stop a rollout that is fine ---

test('healthy: ring by ring, each turned on after the one before was promoted, alive and working, is promoted to the end', () => {
  const s = status({ e1: healthy(300, 250), p1: healthy(200, 150), p2: healthy(100, 50), p3: healthy(99, 50) });
  assert.deepEqual(s.rings.map((r) => r.state), ['promoted', 'promoted', 'promoted']);
  assert.match(s.next, /^every ring is promoted/);
});

test('healthy: nothing on yet: turn ring 0 on', () => {
  assert.match(status({ e1: [], p1: [], p2: [], p3: [] }).next, /^turn it on for ring engine/);
});
