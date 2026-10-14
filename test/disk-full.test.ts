// A full disk never kills the coordinator (src/events/log.ts buffer, src/disk-guard.ts). The "full disk" here is
// SQLite's own: PRAGMA max_page_count at the database's size makes every write that grows it fail with the same error
// the machine saw (ERR_SQLITE_ERROR, errcode 13, "database or disk is full").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, storageFailure } from '../src/events/log.js';
import { DiskGuard, floorBytes, RETRY_MIN_MS, siteDiskGuard } from '../src/disk-guard.js';
import { readIncidents } from '../src/watchdog/incidents.js';
import { EVENTS_KEPT_NOTE, PrTestRuns, type OpenPr } from '../src/coordinator/test-runs.js';
import { checkOutput } from '../src/testrun/checks.js';
import type { RunHost } from '../src/testrun/host.js';
import type { TestRunResult } from '../src/testrun/run.js';
import { coordinator, easyIssue, fixture, skip } from './repro-state-graph/harness.js';
import { FakeRunner } from '../src/runner.js';
import { addStartGate, clearStartGates, passGate } from '../src/testrun/gate.js';

test.afterEach(() => clearStartGates());

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const bufferedLog = (o: { max?: number } = {}) => new EventLog(join(tmp('full-'), 'events.db'), { buffer: o });
const seen = (issue: number) => ({ issue, title: `issue ${issue} ${'x'.repeat(1500)}`, labels: [], author: 'a', owner: 'a', actionable: true, why: '' });

/** The disk is full: the database can't grow, and its pages are filled to the last byte, so the next write fails as SQLITE_FULL. */
function fill(log: EventLog) {
  const pages = Object.values(log.db.prepare('PRAGMA page_count').get() as Record<string, number>)[0]!;
  log.db.exec(`PRAGMA max_page_count = ${pages}`);
  const put = log.db.prepare("INSERT INTO events (ts, type, actor, source, payload) VALUES ('2026-01-01T00:00:00Z', 'coordinator.tick', 'filler', 'coordinator', ?)");
  for (const size of [1000, 100, 1]) {
    try {
      for (;;) put.run(JSON.stringify({ instance: 'filler', dispatched: 0, reconciled: 0, pad: 'x'.repeat(size) }));
    } catch (e) {
      assert.ok(storageFailure(e), String(e));
    }
  }
}
/** There is room again. */
const room = (log: EventLog) => log.db.exec('PRAGMA max_page_count = 1073741823');

const issues = (log: EventLog) => log.read(0, ['issue.seen']).map((e) => (e.payload as { issue: number }).issue);

test('a write the full disk refuses (SQLITE_FULL) is kept in memory, never thrown; once there is room it is written, in order', () => {
  const log = bufferedLog();
  log.append('issue.seen', seen(1), 'c');
  fill(log);
  for (let i = 2; i <= 40; i++) assert.doesNotThrow(() => log.append('issue.seen', seen(i), 'c'));
  const b = log.buffered();
  assert.ok(b.count > 0, 'some writes were refused and kept');
  assert.match(b.failure!.reason, /^SQLite 13: database or disk is full/);
  assert.deepEqual(issues(log), Array.from({ length: 40 }, (_, i) => i + 1), 'a read from the start counts the kept events, in order');
  const last = log.lastId();
  const kept = log.read(last);
  assert.equal(kept.length, b.count, 'a read after the last written event sees the kept ones');
  assert.deepEqual(kept.map((e) => e.id), Array.from({ length: b.count }, (_, i) => last + 1 + i), 'provisional ids go on from the last written');
  assert.equal(log.flush().written, 0, 'still full: nothing written');
  assert.equal(log.buffered().count, b.count, 'and nothing lost');
  room(log);
  assert.deepEqual(log.flush(), { written: b.count, error: null });
  assert.equal(log.buffered().count, 0);
  const stored = log.read(0, ['issue.seen']);
  assert.deepEqual(stored.map((e) => (e.payload as { issue: number }).issue), Array.from({ length: 40 }, (_, i) => i + 1), 'written in the order they happened');
  assert.ok(stored.every((e, i) => e.id > 0 && (i === 0 || e.id > stored[i - 1]!.id)));
  assert.deepEqual(log.read(last).map((e) => e.id), kept.map((e) => e.id), 'written under the ids they were kept with');
});

test('an unrelated error still throws: a bad payload, a SQL error, a refused write inside a transaction, and any log without the buffer', () => {
  const log = bufferedLog();
  assert.throws(() => log.append('issue.seen', { issue: -1 } as never, 'c'), 'a schema error throws');
  log.db.exec("CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.actor = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => log.append('issue.seen', seen(1), 'boom'), /boom/, 'a constraint error throws');
  assert.equal(log.buffered().count, 0);
  fill(log);
  log.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => log.append('issue.seen', seen(2), 'c'), /full/, 'inside a transaction the caller rolls back');
  log.db.exec('ROLLBACK');
  log.append('issue.seen', seen(3), 'c');
  assert.equal(log.buffered().count, 1);
  log.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => log.append('issue.seen', seen(4), 'c'), /can't be written/, 'a claim inside a transaction never lands outside it');
  log.db.exec('ROLLBACK');
  const plain = new EventLog(join(tmp('plain-'), 'events.db'));
  fill(plain);
  assert.throws(() => {
    for (let i = 1; i <= 40; i++) plain.append('issue.seen', seen(i), 'c');
  }, /database or disk is full/, 'only the coordinator\'s log keeps refused writes');
  // INVARIANT: what counts as the disk: SQLITE_FULL and SQLITE_IOERR (any extended code), ENOSPC/EDQUOT, a child saying so.
  assert.ok(storageFailure({ code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full' }));
  assert.ok(storageFailure({ code: 'ERR_SQLITE_ERROR', errcode: 778, errstr: 'disk I/O error' }));
  assert.ok(storageFailure(Object.assign(new Error('write'), { code: 'ENOSPC' })));
  assert.ok(storageFailure(new Error('git: fatal: No space left on device')));
  assert.equal(storageFailure({ code: 'ERR_SQLITE_ERROR', errcode: 1, errstr: 'no such table: events' }), null);
  assert.equal(storageFailure({ code: 'ERR_SQLITE_ERROR', errcode: 19, errstr: 'constraint failed' }), null);
  assert.equal(storageFailure(new TypeError('x is undefined')), null);
});

test('the kept events are bounded: past the limit the newest are counted as lost, the kept ones stay in order', () => {
  const log = bufferedLog({ max: 3 });
  fill(log);
  for (let i = 1; i <= 30; i++) log.append('issue.seen', seen(i), 'c');
  const b = log.buffered();
  assert.equal(b.count, 3);
  assert.ok(b.dropped > 0);
  room(log);
  log.flush();
  const got = issues(log);
  assert.equal(got.length, 30 - b.dropped);
  assert.deepEqual(got, [...got].sort((a, z) => a - z));
});

/** A guard over a log, an incident store of its own, and a disk whose free space the test sets. */
function guardRig(o: { log?: EventLog; freeGb?: number; incidentsDir?: string } = {}) {
  const log = o.log ?? bufferedLog();
  const dir = o.incidentsDir ?? tmp('incidents-');
  const disk = { freeGb: o.freeGb ?? 400, totalGb: 500 };
  let now = 1_000_000;
  const said: string[] = [];
  const guard = new DiskGuard({
    log,
    instance: 'shop',
    paths: ['/state', '/test-runs'],
    floor: () => ({ gb: 10, pct: 5 }),
    free: () => ({ freeBytes: disk.freeGb * 2 ** 30, totalBytes: disk.totalGb * 2 ** 30 }),
    incidents: { dir },
    inFlight: () => 2,
    say: (l) => void said.push(l),
    now: () => now,
  });
  const open = () => readIncidents(dir).incidents.filter((x) => x.kind === 'disk_full' && !x.resolvedAt);
  return { log, dir, disk, guard, said, open, tick: (ms = RETRY_MIN_MS * 20) => (now += ms) };
}

test('a refused write raises a red disk_full incident (free space, the path, what was paused), holds new work, and is resolved once the events are written', () => {
  const r = guardRig();
  r.log.append('issue.seen', seen(1), 'c');
  assert.equal(r.guard.held(), null);
  fill(r.log);
  for (let i = 2; i <= 30; i++) r.log.append('issue.seen', seen(i), 'c');
  const [x] = r.open();
  assert.ok(x, 'raised on the first refused write');
  assert.equal(x.severity, 'red');
  assert.equal(x.instance, 'shop');
  assert.match(x.detail, /can't be written: SQLite 13: database or disk is full/);
  assert.match(x.detail, /Paused: new test runs, agent runs and batches; 2 in flight go on/);
  assert.match(x.detail, /\/state: 400\.0 GiB free of 500\.0 GiB/);
  assert.match(x.fix, /10 GiB and 5% free/);
  assert.match(r.guard.held() ?? '', /the disk is full/);
  assert.equal(r.said.filter((l) => /can't be written/.test(l)).length, 1, 'one journal line, not one per event');
  r.tick();
  r.guard.step();
  assert.ok(r.log.buffered().count > 0, 'still full: kept');
  assert.equal(r.open().length, 1);
  room(r.log);
  r.tick();
  r.guard.step();
  assert.equal(r.log.buffered().count, 0);
  assert.deepEqual(issues(r.log), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(r.open().length, 0, 'resolved');
  assert.equal(r.guard.held(), null, 'new work starts again');
});

test('the retries back off while the disk stays full', () => {
  const r = guardRig();
  fill(r.log);
  for (let i = 1; i <= 30; i++) r.log.append('issue.seen', seen(i), 'c');
  let flushes = 0;
  const flush = r.log.flush.bind(r.log);
  r.log.flush = () => (flushes++, flush());
  const at: number[] = [];
  for (let s = 0; s < 400; s++) {
    r.tick(1000);
    const before = flushes;
    r.guard.step();
    if (flushes > before) at.push(s);
  }
  const gaps = at.slice(1).map((v, i) => v - at[i]!);
  assert.ok(gaps.length >= 3);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]!), `gaps grow: ${gaps.join(',')}`);
  assert.ok(Math.max(...gaps) <= 60, 'at most a minute apart');
});

test('an incident store the full disk refuses is said in the journal and kept, and written once there is room', () => {
  const blocked = join(tmp('store-'), 'slots');
  writeFileSync(blocked, 'a file where the store directory should be');
  const r = guardRig({ incidentsDir: blocked });
  fill(r.log);
  r.log.append('issue.seen', seen(1), 'c');
  assert.ok(r.said.some((l) => /disk_full incident \(red\) couldn't be written to the incident store/.test(l)), r.said.join('\n'));
  rmSync(blocked);
  r.tick();
  r.guard.step();
  assert.equal(r.open().length, 1, 'written on a later step');
});

test('below the free-disk floor no test run starts (amber incident); above it they start and it is resolved', async () => {
  const r = guardRig({ freeGb: 12 });
  // WHY: the floor is the larger of 10 GiB and 5% of 500 GiB (25 GiB).
  assert.equal(floorBytes({ gb: 10, pct: 5 }, 500 * 2 ** 30), 25 * 2 ** 30);
  const pr = rig(r.log, () => r.guard.held());
  pr.prs = [{ number: 1, headSha: 'a'.repeat(40), base: 'main', author: 'x', bot: false }];
  assert.deepEqual(await pr.pass(), [], 'nothing starts below the floor');
  const [x] = r.open();
  assert.equal(x?.severity, 'amber');
  assert.match(x!.detail, /below the floor \(\/state: 12\.0 GiB free, floor 25\.0 GiB/);
  r.disk.freeGb = 100;
  assert.deepEqual(await pr.pass(), [1], 'started once there is room');
  r.tick();
  r.guard.step();
  assert.equal(r.open().length, 0);
});

/** PrTestRuns with stand-ins: each run writes an event (as a real one does) and finishes at once. */
function rig(log: EventLog, hold?: () => string | null) {
  clearStartGates();
  if (hold) addStartGate('disk', hold);
  let now = 0;
  const posted: { sha: string; result: TestRunResult }[] = [];
  const s = { prs: [] as OpenPr[] };
  const runs = new PrTestRuns({
    log,
    actor: 'test',
    repo: '/r',
    remote: 'origin',
    host: { wipe: async () => ({ ok: true, left: [] }) } as unknown as RunHost,
    listPrs: async () => s.prs,
    fetchPr: (p) => p.headSha,
    changed: () => ['a.ts'],
    now: () => now,
    pollMs: 1000,
    start: async (req) => {
      // WHY: as runTestRun does, the only function that starts a run: the start gate first (src/testrun/gate.ts).
      passGate();
      // WHY: as a real run does: its events, and on a failure the coordinator's error (the line the machine crashed on).
      log.append('issue.seen', seen(req.prs[0]!), 'test');
      return { id: `r${req.prs[0]}`, sha: req.sha, kind: 'fast', ok: true, outcome: 'done', tiers: [{ tier: 'unit', ok: true, durationMs: 5, summary: 'ok' }] } as unknown as TestRunResult;
    },
    post: async (sha, result) => void posted.push({ sha, result }),
  });
  return {
    runs,
    posted,
    set prs(v: OpenPr[]) {
      s.prs = v;
    },
    pass: async () => {
      now += 5000;
      const r = await runs.tick();
      await runs.idle();
      return r.started;
    },
  };
}

test('runs in flight when the disk fills finish without crashing, and their checks are still posted, saying the record waits in memory', async () => {
  const log = bufferedLog();
  const pr = rig(log);
  fill(log);
  for (let i = 0; i < 20; i++) log.append('issue.seen', seen(100 + i), 'c');
  assert.ok(log.buffered().count > 0);
  // WHY: before the fix, runOne's append threw here, out of a promise no one awaited: the process died.
  pr.prs = [1, 2].map((n) => ({ number: n, headSha: `${n}`.repeat(40), base: 'main', author: 'x', bot: false }));
  assert.deepEqual(await pr.pass(), [1, 2]);
  assert.equal(pr.posted.length, 2, 'both checks posted');
  assert.ok(pr.posted.every((p) => p.result.note === EVENTS_KEPT_NOTE));
  assert.match(checkOutput(pr.posted[0]!.result, pr.posted[0]!.result.tiers, 'success').summary, /this run's record waits in memory/);
  room(log);
  log.flush();
  assert.deepEqual(issues(log).slice(-2), [1, 2], "the runs' own events are written after the ones kept before them");
});

test('new test runs are paused while the disk is full and resume once the events are written', async () => {
  const r = guardRig();
  const pr = rig(r.log, () => r.guard.held());
  fill(r.log);
  for (let i = 0; i < 20; i++) r.log.append('issue.seen', seen(100 + i), 'c');
  pr.prs = [{ number: 7, headSha: '7'.repeat(40), base: 'main', author: 'x', bot: false }];
  assert.deepEqual(await pr.pass(), [], 'paused');
  assert.deepEqual(await pr.pass(), [], 'still paused');
  room(r.log);
  r.tick();
  r.guard.step();
  assert.deepEqual(await pr.pass(), [7], 'resumed');
});

test('a coordinator tick keeps running on a full disk, starts no agent run while full, and starts them once there is room', { skip }, async () => {
  const f = fixture();
  f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const log = new EventLog(f.log.path, { buffer: {} });
  const r = guardRig({ log });
  const runner = new FakeRunner(() => ({ structured: { summary: 's' } }));
  const c = coordinator(f, runner, { log, disk: r.guard });
  // WHY: a full disk, as the machine had it: no space left, and the database can't grow.
  r.disk.freeGb = 0;
  fill(log);
  // WHY: before the fix, the first event the tick wrote threw, its step's error event threw again, and the tick (the
  // service's loop) rejected: the process exited.
  await c.tick();
  await c.tick();
  assert.equal(runner.calls.length, 0, 'no agent run while the disk is full');
  assert.ok(log.buffered().count > 0, 'the ticks ran, their events kept');
  assert.equal(r.open()[0]?.severity, 'red');
  assert.match((log.read(0, ['governor.hold']).at(-1)?.payload as { reason: string }).reason, /paused: (the disk is full|free disk is below the floor)/);
  r.disk.freeGb = 400;
  room(log);
  r.tick();
  r.guard.step();
  assert.equal(log.buffered().count, 0);
  assert.equal(r.open().length, 0, 'the incident is resolved');
  await c.tick();
  await c.idle();
  assert.ok(runner.calls.length > 0, 'runs start again');
  assert.ok(log.read(0, ['coordinator.tick']).filter((e) => e.actor !== 'filler').length >= 3, 'every tick is in the log');
});

test("an instance's coordinator raises disk_full under the instance's name (what the Health page filters on), never its user@host id", () => {
  const log = bufferedLog();
  const dir = tmp('incidents-');
  const g = siteDiskGuard({ log, stateDir: tmp('state-'), testRuns: true, instance: 'shop', actor: 'wl-shop@machine', floor: () => ({ gb: 1, pct: 0 }), incidentsDir: dir, say: () => undefined });
  fill(log);
  log.append('issue.seen', seen(1), 'c');
  const open = readIncidents(dir).incidents.filter((x) => x.kind === 'disk_full' && !x.resolvedAt);
  assert.deepEqual(open.map((x) => [x.instance, x.key, x.severity]), [['shop', 'shop', 'red']]);
  assert.ok(open[0]!.detail.includes('Paused: new test runs'));
  g.stop();
  const local = bufferedLog();
  const dir2 = tmp('incidents-');
  siteDiskGuard({ log: local, stateDir: tmp('state-'), testRuns: false, instance: null, actor: 'me@laptop', floor: () => ({ gb: 1, pct: 0 }), incidentsDir: dir2, say: () => undefined });
  fill(local);
  local.append('issue.seen', seen(1), 'c');
  assert.equal(readIncidents(dir2).incidents.length, 0, 'a local site raises none');
});
