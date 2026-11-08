// #1231's acceptance bar for the canary rollout (#1174): every attack the reviews found, as a must-fail case, and the
// healthy twins a fix must still pass. Each case asserts the SAFE outcome exactly, so a failing case is an attack that
// works, or a fix that refuses too much. Sources (the attack files the reviews kept): R1174b and R1174c (their cases,
// from the review comments), R1174d (r1174d-attacks.test.ts), R1174e's A9b, R1174f (r1174f-attacks.test.ts), R1174g
// (r1174g-attacks.test.ts), R1174h (attacks-1174h/r1174h-attacks.test.ts). Revised per the spec reviews R1231a, R1231b. Frozen
// once its spec review passes: a change to it then needs its own acceptance review (#1231).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import type { StoredEvent } from '../../src/events/types.js';
import { EventLog } from '../../src/events/log.js';
import { ROLLOUT_FILE, RolloutFile, readRollout, ringZeroProblem, rolloutStatus, type Rollout } from '../../src/rollout.js';
import { rolloutCommand, type RolloutDeps } from '../../src/rollout-cli.js';
import { repoRoot } from '../helpers.js';
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
const started = (h: number, pid: number) => ev('coordinator.started', { instance: 'i', pid, version: 'v' }, hoursAgo(h));
const healthy = (h: number, m = h - 10) => [on(h), ...merges(3, m), tick()];

const R: Rollout = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }, { name: 'second', instances: ['p2', 'p3'] }] });
const R2: Rollout = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] });
const status = (logs: Record<string, StoredEvent[]>, rollout: Rollout = R) => rolloutStatus({ rollout, flag: 'f', logs: new Map(Object.entries(logs)), now: NOW, ringZero: null, listing: null });
const states = (s: ReturnType<typeof status>) => s.rings.map((r) => r.state);
/** The CLI's next line, as printed. */
const NOT_TURN_ON = /^next: (turn it on|every ring is promoted)/;

// --- R1174b ---

test('R1174b A1: a ring with a bad sign in what can be read rolls back, whatever another log does', () => {
  const s = rolloutStatus({ rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['a', 'b'] }] }), flag: 'f', logs: new Map([['a', [on(5), ev('merge.stopped', { by: 'red_main' }, hoursAgo(2))]]]), now: NOW, ringZero: null, listing: null });
  assert.equal(s.rings[0]!.state, 'roll back');
  assert.match(s.next, /^roll back ring engine/);
});

test('R1174b A2: a later ring on for 8 days while ring 0 soaks an hour, with an unread log, is out of order and rolled back', () => {
  const s = rolloutStatus({ rollout: RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e'] }, { name: 'p', instances: ['c', 'd'] }] }), flag: 'f', logs: new Map([['e', [on(1), tick()]], ['c', [on(8 * 24), tick()]]]), now: NOW, ringZero: null, listing: null });
  assert.equal(s.rings[1]!.state, 'out of order');
  assert.match(s.next, /^roll back ring p/);
});

// --- R1174c ---

test('R1174c S1: ring 0 promoted and ring 1 unread: ring 1 is unknown, and the step is to wait', () => {
  const s = status({ e1: healthy(100, 50) }, R2);
  assert.deepEqual(states(s), ['promoted', 'unknown']);
  assert.match(s.next, /^wait: can't read the event log of p1/);
});

test('R1174c S1b: ring 0 unread: unknown, and the step is to wait', () => {
  const s = status({ p1: [] }, R2);
  assert.equal(s.rings[0]!.state, 'unknown');
  assert.match(s.next, /^wait: can't read the event log of e1/);
});

// --- R1174d ---

test('R1174d A1: a ring turned on together with ring 0 is out of order once ring 0 is promoted', () => {
  const s = status({ e1: healthy(60, 30), p1: healthy(60, 30), p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'out of order');
  assert.match(s.next, /^roll back ring first/);
});

test('R1174d A1b: every ring on at once, 60 h ago: ring 1 is out of order', () => {
  const s = status({ e1: healthy(60, 30), p1: healthy(60, 30), p2: healthy(60, 30), p3: healthy(60, 30) });
  assert.equal(s.rings[1]!.state, 'out of order');
  assert.doesNotMatch(s.next, /every ring is promoted/);
});

test('R1174d A1c: a ring turned on before ring 0 is out of order once ring 0 catches up', () => {
  const s = status({ e1: healthy(50, 30), p1: healthy(100, 30), p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'out of order');
  assert.match(s.next, /^roll back ring first/);
});

test('R1174d A2: a clock stepped back after the flip never hides a later merge.stopped', () => {
  assert.equal(status({ e1: [on(60), ev('merge.stopped', { by: 'red_main' }, hoursAgo(62)), ...merges(3, 30), tick()], p1: [], p2: [], p3: [] }).rings[0]!.state, 'roll back');
});

test('R1174d A3: off, then on again, keeps a trace of the earlier rollback', () => {
  const s = status({ e1: [on(200), ev('merge.stopped', { by: 'red_main' }, hoursAgo(150)), off(149), ...healthy(60, 30)], p1: [], p2: [], p3: [] });
  // R1231b: promoted (the accepted design), so a fix that freezes after any real rollback can't pass by the note.
  assert.equal(s.rings[0]!.state, 'promoted');
  assert.match(s.rings[0]!.why, /rolled back before/);
});

test('R1174d A4: an unread later ring holds turning an earlier ring on', () => {
  assert.match(status({ e1: healthy(100, 50), p1: [] }).next, /^wait: can't read the event log of p2, p3/);
});

test('R1174d A5: coordinator errors after the flip roll the ring back', () => {
  const errors = Array.from({ length: 20 }, () => ev('coordinator.error', { instance: 'e1', where: 'tick', kind: 'TypeError', message: 'x' }, hoursAgo(40)));
  assert.equal(status({ e1: [on(60), ...errors, ...merges(3, 30), tick()], p1: [], p2: [], p3: [] }).rings[0]!.state, 'roll back');
});

test('R1174d A9: a coordinator that died (crash restarts, no tick since) is not promoted', () => {
  assert.notEqual(status({ e1: [on(60), started(60, 1), ...merges(3, 58), started(58, 2), started(58, 3)], p1: [], p2: [], p3: [] }).rings[0]!.state, 'promoted');
});

test('R1174e A9b: a crash loop after the flip (restarts with no clean stop) rolls back, though ticks go on', () => {
  const e1 = [started(61, 1), on(60), ...merges(3, 40), started(30, 2), tick(29), started(20, 3), tick(19), tick()];
  const s = status({ e1, p1: [], p2: [], p3: [] });
  assert.equal(s.rings[0]!.state, 'roll back');
  assert.match(s.rings[0]!.why, /restarted without a clean stop/);
});

test("R1174d A6: ring 0 must be the engine's own repo: a project as ring 0 is a problem, and status then turns nothing on", () => {
  const r = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['p1'] }] });
  const problem = ringZeroProblem({ rollout: r, repos: new Map([['p1', ['o/p1']], ['e1', ['example/engine']]]), engine: ['example/engine'], outsideNames: ['e1'] });
  assert.ok(problem);
  assert.match(rolloutStatus({ rollout: r, flag: 'f', logs: new Map([['p1', []]]), now: NOW, ringZero: problem, listing: null }).next, /^wait: .*fix rollout\.json first/);
});

test("R1174d A7: root's rollout.json through a link, or writable by others, is refused", { skip: process.platform === 'win32' }, () => {
  const file = ROLLOUT_FILE();
  assert.equal(onRealMachine(file), `/etc/${BRAND.cli}/rollout.json`);
  mkdirSync(dirname(file), { recursive: true });
  const me = process.getuid!();
  const elsewhere = join(dirname(file), 'acceptance-elsewhere.json');
  try {
    writeFileSync(elsewhere, JSON.stringify({ rings: [{ name: 'engine', instances: ['p1'] }], promote: { soak_hours: 1, min_merges: 0 } }));
    chmodSync(elsewhere, 0o644);
    symlinkSync(elsewhere, file);
    assert.throws(() => readRollout(undefined, me), /is a link/);
    rmSync(file);
    writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['p1'] }] }));
    chmodSync(file, 0o666);
    assert.throws(() => readRollout(undefined, me), /may be written by others/);
  } finally {
    rmSync(file, { force: true });
    rmSync(elsewhere, { force: true });
  }
});

test("R1174d A8: a rename into a name a ring still lists is refused: the registry plans the ring's record, and instance-rename.sh refuses before it changes anything", () => {
  const reg = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'setup', 'instance-records.cjs')) as { plan: (name: string, prefix?: string) => Record<string, unknown> };
  const root = mkdtempSync(join(tmpdir(), 'acc-rename-'));
  try {
    mkdirSync(join(root, 'etc', BRAND.cli), { recursive: true });
    writeFileSync(join(root, 'etc', BRAND.cli, 'rollout.json'), JSON.stringify({ rings: [{ name: 'engine', instances: ['ghost'] }] }));
    assert.ok(reg.plan('ghost', root).rollout, 'the ring name has a record');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'instance-rename.sh'), 'utf8');
  const fn = sh.slice(sh.indexOf('new_in_use() {'), sh.indexOf('\n}\n', sh.indexOf('new_in_use() {')));
  assert.match(fn, /records plan "\$new"/, 'the in-use check lists the records');
  const refusal = sh.indexOf('[ -z "$inuse" ] || {');
  assert.ok(refusal > 0, 'the in-use refusal');
  const firstChange = sh.search(/^install -d -o root -g root -m 0700 "\$RENAMES"/m);
  assert.ok(firstChange > refusal, 'refused before the first change');
});

// --- R1174f ---

test('R1174f A1: a replayed on never restarts the on-period: an earlier red main rolls back, an early start stays out of order', () => {
  assert.equal(status({ e1: healthy(300, 250), p1: [on(100), ev('merge.main_result', { outcome: 'red' }, hoursAgo(90)), on(70), ...merges(3, 60), tick()], p2: [], p3: [] }).rings[1]!.state, 'roll back');
  assert.equal(status({ e1: healthy(300, 250), p1: [on(280), on(100), ...merges(3, 60), tick()], p2: [], p3: [] }).rings[1]!.state, 'out of order');
});

test("R1174f A2: the engine's own off never launders history: never advise \"set true\" where the config says so, and an early start stays out of order", () => {
  const p1 = [on(280), ev('config.invalid', { sha: 'b', errors: [] }, hoursAgo(200)), nullOff(199)];
  assert.doesNotMatch(status({ e1: healthy(300, 250), p1, p2: [], p3: [] }).next, /set `flags\.f: true` in the config\.yaml of p1/);
  const s = status({ e1: healthy(300, 250), p1: [...p1, on(150), ...merges(3, 60), tick()], p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'out of order');
  assert.doesNotMatch(s.next, /^turn it on for ring second/);
});

test("R1174f A3: an instance doing no work isn't promoted on the others' merges", () => {
  const idle = [ev('merge.stopped', { by: 'red_main' }, hoursAgo(120)), on(100), ...Array.from({ length: 20 }, (_, i) => tick((19 - i) * 0.4 + 0.05))];
  const s = status({ e1: healthy(400, 350), p1: healthy(300, 250), p2: healthy(100, 60), p3: idle });
  assert.equal(s.rings[2]!.state, 'soaking');
  assert.doesNotMatch(s.next, /every ring is promoted/);
});

test('R1174f A4: one PR recorded three times is one merge', () => {
  assert.equal(status({ e1: healthy(300, 250), p1: [on(60), ...[7, 7, 7].map((n) => ev('merge.done', { number: n }, hoursAgo(30))), tick()], p2: [], p3: [] }).rings[1]!.state, 'soaking');
});

test('R1174f A5: a last tick stamped in the future is no sign of life', () => {
  const e1 = [on(60), ...merges(3, 30), ev('coordinator.tick', { instance: 'e1', dispatched: 0, reconciled: 0 }, new Date(NOW.getTime() + 7 * 86_400_000).toISOString())];
  assert.equal(status({ e1, p1: [], p2: [], p3: [] }).rings[0]!.state, 'soaking');
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
const stopFlip = ['merge.stopped', { reason: 'red main', number: null, sha: null, revert: null, by: 'red_main' }] as [string, Record<string, unknown>];
const twoRings = (dir: string) => {
  const file = join(dir, 'rollout.json');
  writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }] }));
  return file;
};

test('R1174f A6: an instance folder that is a link is on the machine list: its flag being on is seen and rolled back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  try {
    const file = twoRings(dir);
    const own = join(dir, 'own');
    instancesAt(own, { e1: { repo: 'example/engine' }, p1: { repo: 'o/p1' } });
    instancesAt(join(dir, 'disk2'), { x: { repo: 'o/x', events: [onFlip] } });
    symlinkSync(join(dir, 'disk2', 'x'), join(own, 'x'));
    const r = run(file, { ownDir: () => own, srvRoot: () => join(dir, 'no-srv'), homeOf: () => null, engine });
    assert.ok(r.out.some((l) => l.includes('outside the rollout: x has f on')), r.out.join('\n'));
    assert.match(r.next, /^next: roll back outside the rollout \(x/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** R1174f A7's layout: e1 live in its coordinator home (on, then auto-merge stopped), p1 in its home, /srv listing both. */
function separateUsers(dir: string) {
  const homes = join(dir, 'home');
  const homeInst = (n: string) => join(homes, `wl-${n}`, '.local', 'state', BRAND.cli, 'instances');
  instancesAt(homeInst('e1'), { e1: { repo: 'example/engine', events: [onFlip, stopFlip] } });
  instancesAt(homeInst('p1'), { p1: { repo: 'o/p1' } });
  const srv = join(dir, 'srv');
  for (const n of ['e1', 'p1']) mkdirSync(join(srv, n), { recursive: true });
  return { homes, srv };
}

test("R1174f A7: a stale same-named folder in the running user's dir never wins over the live coordinator home: held, exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  try {
    const file = twoRings(dir);
    const { homes, srv } = separateUsers(dir);
    const own = join(dir, 'own');
    instancesAt(own, { e1: { repo: 'example/engine' } });
    const r = run(file, { ownDir: () => own, srvRoot: () => srv, homeOf: (u) => join(homes, u), engine });
    assert.equal(r.code, 1);
    assert.match(r.next, /^next: wait: /);
    assert.doesNotMatch(r.next, NOT_TURN_ON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R1174g ---

test("R1174g D1: the engine's own off then merges: not promoted on merges made with the flag off; the next ring isn't told to turn it on", () => {
  const R3 = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }, { name: 'second', instances: ['p2'] }] });
  const s = status({ e1: healthy(300), p1: [on(100), nullOff(90), ...merges(3, 40), tick()], p2: [] }, R3);
  assert.notEqual(s.rings[1]!.state, 'promoted', s.rings[1]!.why);
  assert.doesNotMatch(s.next, /^turn it on for ring second/);
});

test('R1174g D2 / R1174h H5: an unreadable coordinator home (a non-root run) is never "not there": exit non-zero, and the advice is to wait or roll back, never to turn on', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  const homes = join(dir, 'home');
  try {
    const file = join(dir, 'rollout.json');
    writeFileSync(file, JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }], promote: { min_merges: 0, soak_hours: 1 } }));
    instancesAt(join(homes, 'wl-e1', '.local', 'state', BRAND.cli, 'instances'), { e1: { repo: 'example/engine', events: [onFlip, ['config.invalid', { sha: 'b'.repeat(40), errors: ['x'] }]] } });
    const own = join(dir, 'own');
    instancesAt(own, { e1: { repo: 'example/engine' } });
    chmodSync(join(homes, 'wl-e1'), 0o000);
    const r = run(file, { ownDir: () => own, srvRoot: () => join(dir, 'no-srv'), homeOf: (u) => join(homes, u), engine });
    assert.notEqual(r.code, 0);
    assert.match(r.next, /^next: (wait|roll back)/);
  } finally {
    chmodSync(join(homes, 'wl-e1'), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R1174h ---

test('R1174h H1: the engine had the flag off for 45 of the 48 soak hours: not promoted', () => {
  const e1 = [on(50), ev('coordinator.stopped', { instance: 'e1', clean: true, ms: 1, pending: [] }, hoursAgo(47.1)), started(47, 2), nullOff(47), on(2), ...merges(3, 1), tick()];
  assert.notEqual(status({ e1, p1: [] }, R2).rings[0]!.state, 'promoted');
});

test('R1174h H2: a merge made before the flip, recorded after it, never counts toward min_merges', () => {
  const old = (n: number) => ev('merge.done', { number: n, reconciled: true, merged_at: hoursAgo(60) }, hoursAgo(49));
  assert.notEqual(status({ e1: [started(50.1, 2), on(50), old(1), old(2), old(3), tick()], p1: [] }, R2).rings[0]!.state, 'promoted');
});

test('R1174h H3a: a flip stamped by a clock behind never satisfies the soak at once', () => {
  assert.notEqual(status({ e1: [tick(1.1), on(49), ...merges(3, 0.5), tick()], p1: [] }, R2).rings[0]!.state, 'promoted');
});

test('R1174h H3b: a later ring turned on while ring 0 soaked is out of order, its flip stamped by a clock ahead', () => {
  const s = status({ e1: [on(60), ...merges(3, 55), tick()], p1: [tick(30.1), on(5), ...merges(3, 1), tick()] }, R2);
  assert.equal(s.rings[1]!.state, 'out of order');
  assert.match(s.next, /^roll back ring first/);
});

test('R1174h H4: a coordinator that stopped cleanly is not alive, however recent its last tick', () => {
  const e1 = [on(50), ...merges(3, 40), tick(0.4), ev('coordinator.stopped', { instance: 'e1', clean: true, ms: 1, pending: [] }, hoursAgo(0.33))];
  assert.equal(status({ e1, p1: [] }, R2).rings[0]!.state, 'soaking');
});

// --- R1231b: the cases its review found missing ---

test('R1231b C1 / R1174f A1: a replayed on never hides a crash loop before it (P1, ring 0; P1b, ring 1)', () => {
  const p1Shape = [started(101, 1), on(100), started(90, 2), started(85, 3), on(70), ...merges(3, 60), tick()];
  let s = status({ e1: p1Shape, p1: [] }, R2);
  assert.equal(s.rings[0]!.state, 'roll back');
  assert.match(s.rings[0]!.why, /restarted without a clean stop/);
  s = status({ e1: healthy(300, 250), p1: [started(101, 1), on(100), started(90, 2), started(85, 3), on(70), ...merges(3, 60), tick()], p2: [], p3: [] });
  assert.equal(s.rings[1]!.state, 'roll back');
});

test("R1231b C2 / R1174f defect 1: the engine's own off and on again never launders a bad sign (P2, in order)", () => {
  const s = status({ e1: [on(100), ev('config.invalid', { sha: 'b', errors: [] }, hoursAgo(90)), nullOff(89), on(80), ...merges(3, 60), tick()], p1: [] }, R2);
  assert.equal(s.rings[0]!.state, 'roll back');
  const errors = Array.from({ length: 3 }, () => ev('coordinator.error', { instance: 'e1', where: 'tick', kind: 'TypeError', message: 'x' }, hoursAgo(90)));
  assert.equal(status({ e1: [on(100), ...errors, nullOff(89), on(80), ...merges(3, 60), tick()], p1: [] }, R2).rings[0]!.state, 'roll back', 'coordinator errors too');
});

test("R1231b C3: a crash restart, then the engine's own off, then on again, rolls back (P3)", () => {
  const s = status({ e1: [started(101, 1), on(100), started(90, 2), nullOff(90), on(60), ...merges(3, 50), tick()], p1: [] }, R2);
  assert.equal(s.rings[0]!.state, 'roll back');
  assert.match(s.rings[0]!.why, /restarted without a clean stop/);
});

test("R1231b C4 / R1174d defect 1: ring 0's promotion waits for its min_merges-th merge, so a ring on before it is out of order (P4')", () => {
  const R3 = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }, { name: 'second', instances: ['p2'] }] });
  const s = status({ e1: [on(150), ...merges(2, 140), ...merges(1, 60), tick()], p1: healthy(100, 40), p2: [] }, R3);
  assert.equal(s.rings[1]!.state, 'out of order');
  assert.match(s.next, /^roll back ring first/);
});

test('R1231b C5 / R1174c defect 1: a rollback names a later ring whose log is unread (P5)', () => {
  const s = status({ e1: [on(10), ev('merge.stopped', { by: 'red_main' }, hoursAgo(5)), tick()] }, R2);
  assert.match(s.next, /^roll back ring engine/);
  assert.match(s.next, /config\.yaml of p1 .*if it is on there/);
});

test("R1231b C6 / R1174b defect 3: an outside instance whose log can't be read holds every turn-on (P6)", () => {
  const s = rolloutStatus({ rollout: R2, flag: 'f', logs: new Map([['e1', healthy(100, 50)], ['p1', []]]), now: NOW, ringZero: null, listing: null, outside: new Map(), outsideNames: ['x9'] });
  assert.match(s.next, /^wait: can't read the event log of x9/);
});

test('R1231b C7 / R1174b defect 2: removing a ring instance is refused (ring 0, and one of two in a later ring), rollout.json kept, and instance-remove.sh refuses before any change', () => {
  const reg = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'setup', 'instance-records.cjs')) as { remove: (name: string, archive: string, prefix?: string) => unknown };
  const root = mkdtempSync(join(tmpdir(), 'acc-remove-'));
  try {
    const file = join(root, 'etc', BRAND.cli, 'rollout.json');
    mkdirSync(dirname(file), { recursive: true });
    const body = JSON.stringify({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'p', instances: ['c', 'd'] }] });
    writeFileSync(file, body);
    for (const n of ['e1', 'c']) assert.throws(() => reg.remove(n, join(root, `${n}.archive.json`), root), /is in the canary rollout/, n);
    assert.equal(readFileSync(file, 'utf8'), body, 'rollout.json unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'instance-remove.sh'), 'utf8');
  const refusal = sh.indexOf('[ -z "$rollout_refusal" ] || refuse "$rollout_refusal"');
  assert.ok(refusal > 0, 'the rollout refusal');
  for (const change of ['records remove "$name"', 'systemctl disable --now']) assert.ok(sh.indexOf(change) > refusal, `refused before ${change}`);
});

test("healthy (R1231b TWIN): a later ring with ticks before its flip and one engine-off blip, then a full soak: promoted, and ring 2 is next", () => {
  const R3 = RolloutFile.parse({ rings: [{ name: 'engine', instances: ['e1'] }, { name: 'first', instances: ['p1'] }, { name: 'second', instances: ['p2'] }] });
  const p1 = [tick(400), tick(201), tick(200.5), on(200), nullOff(190), tick(189), on(180), ...merges(3, 100), tick()];
  const s = status({ e1: healthy(300, 250), p1, p2: [] }, R3);
  assert.deepEqual(states(s), ['promoted', 'promoted', 'off']);
  assert.match(s.next, /^turn it on for ring second/);
});

// --- Healthy twins: a fix that refuses everything, or freezes a ring, fails these ---

test('healthy: ring by ring, each on after the one before was promoted, alive and working, is promoted to the end', () => {
  const s = status({ e1: healthy(300, 250), p1: healthy(200, 150), p2: healthy(100, 50), p3: healthy(99, 50) });
  assert.deepEqual(states(s), ['promoted', 'promoted', 'promoted']);
  assert.match(s.next, /^every ring is promoted/);
});

test('healthy: nothing on yet: turn ring 0 on', () => {
  assert.match(status({ e1: [], p1: [], p2: [], p3: [] }).next, /^turn it on for ring engine/);
});

test("healthy: on, the engine's own off, then on again and a full soak after it: promoted (one network blip never freezes a ring)", () => {
  const e1 = [on(120), nullOff(110), on(100), ...merges(3, 40), tick()];
  assert.equal(status({ e1, p1: [] }, R2).rings[0]!.state, 'promoted');
});

test('healthy (CLI, one user): every instance in the running user\'s folder, ring 0 promoted: exit 0, turn ring 1 on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  try {
    const file = twoRings(dir);
    const own = join(dir, 'own');
    instancesAt(own, { e1: { repo: 'example/engine' }, p1: { repo: 'o/p1' } });
    // The folders, the list and the repos are the real ones; e1's events are given with this file's clock.
    const out: string[] = [];
    const code = rolloutCommand('status', ['--flag', 'f', '--file', file], { out: (l) => out.push(l), err: () => {}, now: NOW, eventsOf: (n) => (n === 'e1' ? healthy(100, 50) : []), deps: { ownDir: () => own, srvRoot: () => join(dir, 'no-srv'), homeOf: () => null, engine } });
    assert.equal(code, 0, out.join('\n'));
    assert.match(out.at(-1)!, /^next: turn it on for ring first/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('healthy (CLI, separate users): each home readable, no stale folder: exit 0, and the live log is read (roll back ring 0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  try {
    const file = twoRings(dir);
    const { homes, srv } = separateUsers(dir);
    const r = run(file, { ownDir: () => join(dir, 'own-empty'), srvRoot: () => srv, homeOf: (u) => join(homes, u), engine });
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.next, /^next: roll back ring engine/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1174c S2: a run that can read no home and lists no instance (root on a separate-users machine, done wrong) holds: exit 1, wait', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acc-rollout-'));
  try {
    const r = run(twoRings(dir), { ownDir: () => join(dir, 'nothing'), srvRoot: () => join(dir, 'no-srv'), homeOf: () => null, engine });
    assert.equal(r.code, 1);
    assert.match(r.next, /^next: wait: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
