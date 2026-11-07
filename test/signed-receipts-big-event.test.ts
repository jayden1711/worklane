// Signed receipts, #918 round 13: one appended event of any size never stalls signing. Round 12 hashed each event as
// one JavaScript string (the canonical JSON of its fields) and read the whole log with `.all()`: one ordinary event of
// 90,000,000 U+0001 characters (JSON writes each as 6) made every `sign`, and every successor, throw `RangeError:
// Invalid string length` (the round-12 second review, row 1, measured). Now each column is hashed from its bytes, in
// bounded chunks, rows are read one at a time, and a merge event's payload past the read bound is signed as
// `event.unsignable`. Fixture logs and keys made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-12 code (the
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
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r13b-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
type St = { kind: string; event?: unknown; at?: string; inputs?: { pr: number }; type?: string; cut?: Record<string, { length: number; of: string }> };
const statements = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as St);
const decided = (n: number) => ({ issue: n, number: n, head: sha('d'), auto: true, reasons: [] });
const HUGE = '\u0001'.repeat(90_000_000);

/** The coordinator writes one row straight into its own database, with the append-only triggers in place. */
function insert(dbPath: string, row: { ts: string; type: string; payload: string }): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(row.ts, row.type, 'inst', 'inst', row.payload);
  } finally {
    db.close();
  }
}

const TS = '2026-10-21T00:00:00.000Z';
for (const [what, row] of [
  ['a non-merge event', { ts: TS, type: 'note', payload: HUGE }],
  ['a merge event', { ts: TS, type: 'merge.decided', payload: HUGE }],
  ['a merge event with that as its ts', { ts: HUGE, type: 'merge.decided', payload: JSON.stringify(decided(60)) }],
] as const) {
  test(`one appended 90 MB event of control characters (${what}) never stops signing, nor a successor`, { timeout: 600_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'r13b-log-'));
    const path = join(dir, 'events.db');
    const log = new EventLog(path);
    log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
    log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['held'] }, 'inst');
    log.close();
    const registry = fresh('registry.jsonl');
    const a = generateKeyPairSync('ed25519');
    const A = { out: join(dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
    sign({ log: path, ...A, genesis: true, registry, signer: keySigner(a.privateKey) });
    insert(path, row); // event 3
    insert(path, { ts: TS, type: 'merge.decided', payload: JSON.stringify(decided(70)) }); // event 4, honest
    sign({ log: path, ...A, signer: keySigner(a.privateKey) });
    const st = statements(A.out);
    assert.deepEqual(st.filter((s) => s.kind === 'merge.decided' && s.inputs?.pr === 70).map((s) => String(s.event)), ['4'], 'the honest decision after it was receipted');
    const three = st.find((s) => String(s.event) === '3');
    if (row.type === 'note') assert.equal(three, undefined);
    else if (row.ts === HUGE) assert.equal(three?.at, 'unrecorded');
    else assert.equal(three?.kind, 'event.unsignable');
    assert.ok(verifyChain(readReceiptFiles(A.out), { keys: [a.publicKey] }).ok);
    // A ends (decision 42 flipped); its successor starts over the same log, and receipts the next honest decision.
    const db = new DatabaseSync(path);
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.prepare('UPDATE events SET payload = ? WHERE id = 2').run(JSON.stringify({ issue: 8, number: 42, head: sha('b'), auto: true, reasons: [] }));
    db.close();
    assert.throws(() => sign({ log: path, ...A, signer: keySigner(a.privateKey) }), /log changed/);
    insert(path, { ts: TS, type: 'merge.decided', payload: JSON.stringify(decided(80)) }); // event 5
    const b = generateKeyPairSync('ed25519');
    const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
    sign({ log: path, ...B, genesis: true, after: A.state, registry, signer: keySigner(b.privateKey) });
    assert.deepEqual(statements(B.out).filter((s) => s.kind !== 'chain.started').map((s) => String(s.event)), ['5']);
    assert.ok(verifyChain(readReceiptFiles(B.out), { keys: [b.publicKey] }).ok);
  });
}
