// Signed receipts, #918 round 14: the log's shape is checked and its rows are read in one read transaction, so the
// table checked is the table read. Round 13 checked the shape, then read the rows in a later statement: a coordinator
// flipping `events` between a table and a view got the view read in about 1 in 80 runs, and a slow view hung `sign`
// while it held the signer's lock (the round-13 second review, rows 3 and 3b, measured). Here, deterministically: the
// log is opened (shape checked), another connection replaces `events` with a view and appends a row, and the rows read
// are still the checked table's. Fixture logs made here, in temp dirs; no network, no real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import * as store from '../src/signed-receipts-store.js';

test('a schema change committed after the shape check is never seen by the row read', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'r14s-')), 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.close();
  const db = new DatabaseSync(path);
  db.exec("INSERT INTO events (ts, type, actor, source, payload) VALUES ('x', 'note', 'inst', 'inst', '{}')");
  db.close();
  const open = (store as unknown as { openLog?: (p: string) => { rows: () => Iterable<{ id: bigint | number; type: string }>; close: () => void } }).openLog;
  assert.equal(typeof open, 'function', 'the store opens a log as one read (openLog)');
  const read = open!(path);
  try {
    const other = new DatabaseSync(path);
    other.exec("ALTER TABLE events RENAME TO real_events; CREATE VIEW events AS SELECT * FROM real_events UNION ALL SELECT 999, 'x', 'merge.decided', 'inst', 'inst', '{}'");
    other.exec("INSERT INTO real_events (ts, type, actor, source, payload) VALUES ('x', 'note', 'inst', 'inst', '{}')");
    other.close();
    const rows = [...read.rows()].map((e) => [String(e.id), e.type]);
    assert.deepEqual(rows, [
      ['1', 'coordinator.started'],
      ['2', 'note'],
    ]);
  } finally {
    read.close();
  }
});
