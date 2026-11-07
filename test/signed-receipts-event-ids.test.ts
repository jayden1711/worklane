// Signed receipts, #918 round 12: an event id past 2^53 never stalls signing. The coordinator owns the log's database
// and can append an event with any id SQLite holds (up to 2^63 - 1). AUTOINCREMENT then gives every later honest event
// a larger id still. Round 11 read ids as JavaScript numbers, so one such event made every later `sign` throw (the
// round-11 second review, row 9, measured). Ids are decimal strings in a receipt, by design. Fixture logs and keys made
// here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-11 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, verifyChain, type Envelope } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r12i-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
type St = { kind: string; event?: unknown; inputs?: { pr: number } };
const statements = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as St);
const decided = (n: number) => JSON.stringify({ issue: n, number: n, head: sha('d'), auto: true, reasons: [] });

/** The coordinator writes straight into its own database: with an id it chose, or with none (SQLite's next). */
function insert(dbPath: string, payload: string, id?: bigint): void {
  const db = new DatabaseSync(dbPath);
  try {
    if (id === undefined) db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run('2026-10-21T00:00:00.000Z', 'merge.decided', 'inst', 'inst', payload);
    else db.prepare('INSERT INTO events (id, ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?, ?)').run(id, '2026-10-21T00:00:00.000Z', 'merge.decided', 'inst', 'inst', payload);
  } finally {
    db.close();
  }
}

for (const [label, id] of [
  ['2^53 + 10', 2n ** 53n + 10n],
  ['2^53 - 1, so the next honest append is 2^53', 2n ** 53n - 1n],
] as const) {
  test(`one appended event at id ${label} never stops later honest events being signed`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'r12i-log-'));
    const path = join(dir, 'events.db');
    const log = new EventLog(path);
    log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
    log.append('merge.decided', { issue: 7, number: 41, head: sha('a'), auto: true, reasons: [] }, 'inst');
    log.close();
    const k = generateKeyPairSync('ed25519');
    const signer = keySigner(k.privateKey);
    const out = join(dir, 'receipts.jsonl');
    const state = fresh('chain-state.json');
    sign({ log: path, out, state, genesis: true, registry: fresh('registry.jsonl'), signer });
    insert(path, decided(50), id);
    sign({ log: path, out, state, signer });
    // The coordinator's next ordinary appends: ids past the one above, every one of them past 2^53 - 1.
    insert(path, decided(51));
    insert(path, decided(52));
    sign({ log: path, out, state, signer });
    const merges = statements(out).filter((s) => s.kind === 'merge.decided');
    assert.deepEqual(
      merges.map((s) => [s.inputs!.pr, String(s.event)]),
      [
        [41, '2'],
        [50, String(id)],
        [51, String(id + 1n)],
        [52, String(id + 2n)],
      ],
    );
    // Each id is exact: a decimal string, never a number rounded to a double.
    for (const s of merges) assert.equal(typeof s.event, 'string');
    assert.ok(verifyChain(readReceiptFiles(out), { keys: [k.publicKey] }).ok);
  });
}
