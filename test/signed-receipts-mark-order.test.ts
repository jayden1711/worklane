// Signed receipts, #918 round 12 (the round-11 delta check's advisory): the ended chain is marked only after its
// successor's receipts are computed, pinned by a failure that depends on the log and that no later round turns into a
// receipt. Round 10 marked the ended chain first, so a successor that then failed on the log burned the mark: the
// ended chain could never be succeeded (the round-10 review, P3a). Round 11's own P3a test failed at round 10 for a
// parse error that round 11 turned into an `event.unsignable` receipt, not for the order. Here the successor's log
// can't be opened at all. Fixture logs and keys made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against older code (the fail-without run,
// against round 10, where the mark came first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner } from '../src/signed-receipts.js';
import { signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r12m-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const signer = () => keySigner(generateKeyPairSync('ed25519').privateKey);
const bytes = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

test('a successor that fails on its log leaves the ended chain unmarked and the registry as it was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r12m-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['held'] }, 'inst');
  log.close();
  const registry = fresh('registry.jsonl');
  const A = { out: join(dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  const a = signer();
  sign({ log: path, ...A, genesis: true, registry, signer: a });
  const db = new DatabaseSync(path);
  db.exec('DROP TRIGGER IF EXISTS events_no_update');
  db.prepare('UPDATE events SET payload = ? WHERE id = 2').run(JSON.stringify({ issue: 8, number: 42, head: sha('b'), auto: true, reasons: [] }));
  db.close();
  assert.throws(() => sign({ log: path, ...A, signer: a }), /log changed/);
  const before = { state: bytes(A.state), registry: bytes(registry) };
  // The successor's log isn't an event database: its receipts can't be computed.
  const broken = fresh('events.db');
  writeFileSync(broken, 'not a database');
  const b = signer();
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  assert.throws(() => sign({ log: broken, ...B, genesis: true, after: A.state, registry, signer: b }));
  assert.equal(bytes(A.state), before.state, 'the ended chain was marked before its successor computed anything');
  assert.equal(bytes(registry), before.registry, 'the registry recorded a successor that never started');
  assert.ok(!existsSync(B.state) && !existsSync(B.out));
  // With its log, the same successor starts.
  sign({ log: path, ...B, genesis: true, after: A.state, registry, signer: b });
  assert.ok(existsSync(B.out));
});
