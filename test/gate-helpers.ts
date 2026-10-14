// The start gate (src/testrun/gate.ts) as the coordinator sets it: a real disk guard (src/disk-guard.ts) over a log that
// keeps refused writes, its disk's free space set by the test. close('floor'): free space below the floor;
// close('held'): the event log's disk full, so an event waits in memory. open(): room again (and the events written).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskGuard } from '../src/disk-guard.js';
import { EventLog, storageFailure } from '../src/events/log.js';
import { addStartGate, clearStartGates } from '../src/testrun/gate.js';

export type GateMode = 'floor' | 'held';
export const GATE_MODES: GateMode[] = ['floor', 'held'];

/** The disk is full: the database can't grow and its pages are filled, so the next write fails as SQLITE_FULL. */
export function fillLog(log: EventLog) {
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

export function roomInLog(log: EventLog) {
  log.db.exec('PRAGMA max_page_count = 1073741823');
}

/** A disk guard set as the start gate. Call done() at the end (or in finally): the gate is process-wide. */
export function guardGate() {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'gate-')), 'events.db'), { buffer: {} });
  const disk = { freeGb: 400 };
  let now = 1_000_000;
  const guard = new DiskGuard({
    log,
    instance: 'shop',
    paths: ['/state', '/test-runs'],
    floor: () => ({ gb: 10, pct: 5 }),
    free: () => ({ freeBytes: disk.freeGb * 2 ** 30, totalBytes: 500 * 2 ** 30 }),
    say: () => undefined,
    now: () => now,
  });
  clearStartGates();
  addStartGate('disk', () => guard.held());
  return {
    guard,
    log,
    close(mode: GateMode) {
      if (mode === 'floor') disk.freeGb = 12;
      else {
        fillLog(log);
        log.append('issue.seen', { issue: 1, title: 'x'.repeat(1500), labels: [], author: 'a', owner: 'a', actionable: true, why: '' }, 'c');
        assert.ok(log.buffered().count > 0, 'an event waits in memory');
      }
      assert.ok(guard.held(), 'the gate refuses');
    },
    open() {
      disk.freeGb = 400;
      roomInLog(log);
      now += 600_000;
      guard.step();
      assert.equal(guard.held(), null, 'the gate lets runs start');
    },
    done() {
      clearStartGates();
      guard.stop();
    },
  };
}
