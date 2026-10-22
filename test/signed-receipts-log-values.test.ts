// Signed receipts, #918 round 15: a REAL in the log is hashed exactly, and a `coordinator.started` the signer never
// read is said in the decisions after it. Round 14 hashed a column from `CAST(… AS BLOB)`, which writes a REAL with 15
// significant digits: 1.0 changed to 1.0000000000000002 under a signed receipt kept the digest (the round-14 final
// check, 3c, and second review, row 9, measured). A `coordinator.started` past the 64 KiB bound left `engine.version`
// null with no mark (the final check's advisory A). Fixture logs and keys made here, in temp dirs; no network, no real
// state.
//
// The calls take their options as plain objects, so this file also builds against the round-14 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, type Envelope } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r15v-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const DECISION = JSON.stringify({ issue: 9, number: 9, head: sha('d'), auto: true, reasons: [] });

function fixtureLog(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'r15v-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.close();
  return { dir, path };
}

test('a REAL changed to the next double under a signed receipt is a log edit: refused', () => {
  const f = fixtureLog();
  const db = new DatabaseSync(f.path);
  // The coordinator rebuilds its table with an untyped ts, so a REAL stays a REAL (every column NOT NULL).
  db.exec('ALTER TABLE events RENAME TO old_events; CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL); INSERT INTO events SELECT * FROM old_events; DROP TABLE old_events');
  db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(1.0, 'merge.decided', 'inst', 'inst', DECISION);
  db.exec('UPDATE events SET ts = CAST(ts AS REAL) WHERE id = 2');
  assert.equal((db.prepare('SELECT typeof(ts) AS t FROM events WHERE id = 2').get() as { t: string }).t, 'real');
  db.close();
  const k = keySigner(generateKeyPairSync('ed25519').privateKey);
  const A = { out: join(f.dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...A, genesis: true, registry: fresh('registry.jsonl'), signer: k });
  const w = new DatabaseSync(f.path);
  w.exec('UPDATE events SET ts = 1.0000000000000002 WHERE id = 2');
  assert.equal((w.prepare('SELECT typeof(ts) AS t FROM events WHERE id = 2').get() as { t: string }).t, 'real');
  w.close();
  assert.throws(() => sign({ log: f.path, ...A, signer: k }), /log changed/);
});

// Round 16: a REAL is hashed as its 8 IEEE-754 bytes. Round 15 hashed quote()'s text, which writes 0.0 and -0.0, and
// some neighbouring doubles, the same (the round-15 reviews, measured): each such edit under a signed receipt is refused.
for (const [from, to] of [
  [0.0, -0.0],
  [6.62192789667149e243, 6.6219278966714905e243],
  [9.35553159930226e-191, 9.355531599302261e-191],
] as const) {
  test(`a REAL changed from ${from} to ${Object.is(to, -0) ? '-0.0' : to} under a signed receipt is a log edit: refused`, () => {
    assert.notEqual(Buffer.from(new Float64Array([from]).buffer).toString('hex'), Buffer.from(new Float64Array([to]).buffer).toString('hex'), 'two different doubles');
    const f = fixtureLog();
    const db = new DatabaseSync(f.path);
    db.exec('ALTER TABLE events RENAME TO old_events; CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL); INSERT INTO events SELECT * FROM old_events; DROP TABLE old_events');
    db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(from, 'merge.decided', 'inst', 'inst', DECISION);
    db.exec('UPDATE events SET ts = CAST(ts AS REAL) WHERE id = 2');
    db.close();
    const k = keySigner(generateKeyPairSync('ed25519').privateKey);
    const A = { out: join(f.dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
    sign({ log: f.path, ...A, genesis: true, registry: fresh('registry.jsonl'), signer: k });
    const w = new DatabaseSync(f.path);
    w.prepare('UPDATE events SET ts = ? WHERE id = 2').run(to);
    const now = w.prepare('SELECT typeof(ts) AS t, ts AS v FROM events WHERE id = 2').get() as { t: string; v: number };
    w.close();
    assert.equal(now.t, 'real');
    assert.ok(Object.is(now.v, to), `stored ${now.v}`);
    assert.throws(() => sign({ log: f.path, ...A, signer: k }), /log changed/);
  });
}

test('decisions after a coordinator.started the signer never read say so: engine.version is cut as unread', () => {
  const f = fixtureLog();
  const db = new DatabaseSync(f.path);
  db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run('2026-10-21T00:00:00.000Z', 'coordinator.started', 'inst', 'inst', JSON.stringify({ instance: 'inst', pid: 2, version: 'v'.repeat(70_000) }));
  db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run('2026-10-21T00:00:00.000Z', 'merge.decided', 'inst', 'inst', DECISION);
  db.close();
  const k = keySigner(generateKeyPairSync('ed25519').privateKey);
  const out = join(f.dir, 'receipts.jsonl');
  sign({ log: f.path, out, state: fresh('chain-state.json'), genesis: true, registry: fresh('registry.jsonl'), signer: k });
  const d = (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as { kind: string; engine?: { version: string | null }; cut?: Record<string, { of: string; length: number }> }).find((s) => s.kind === 'merge.decided')!;
  assert.equal(d.engine?.version, null);
  assert.equal(d.cut?.['engine.version']?.of, 'unread');
});
