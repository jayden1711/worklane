// Signed receipts, #918 round 13: the coordinator can't block a successor by moving its own log. Round 12's registry
// knew a log by its real path only: the coordinator ended a chain, renamed its events.db and left a link at the old
// name, and every successor was refused until the owner moved the log back (the round-12 final check, n12b.mjs,
// measured). A successor's log is now its predecessor's when it is at the same path OR starts with the same first event;
// another instance's log (another path and another first event) is still refused. Fixture logs, keys and directories
// made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-12 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, type Envelope } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r13l-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const signer = () => keySigner(generateKeyPairSync('ed25519').privateKey);

function fixtureLog(instance: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'r13l-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance, pid: 1, version: '1.2.3' }, instance);
  log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['held'] }, instance);
  log.close();
  return { dir, path };
}
function flip(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TRIGGER IF EXISTS events_no_update');
  db.prepare('UPDATE events SET payload = ? WHERE id = 2').run(JSON.stringify({ issue: 8, number: 42, head: sha('b'), auto: true, reasons: [] }));
  db.close();
}

test('a log the coordinator moved (a link left at its old name) still takes its successor', () => {
  const f = fixtureLog('inst');
  const registry = fresh('registry.jsonl');
  const a = signer();
  const A = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...A, genesis: true, registry, signer: a });
  flip(f.path);
  assert.throws(() => sign({ log: f.path, ...A, signer: a }), /log changed/);
  const moved = join(f.dir, 'events-moved.db');
  renameSync(f.path, moved);
  symlinkSync(moved, f.path);
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...B, genesis: true, after: A.state, registry, signer: signer() });
  assert.equal((statementOf((readReceiptFiles(B.out) as Envelope[])[0]!) as { kind: string }).kind, 'chain.started');
  // Another instance's log (another path, another first event) is still refused.
  const other = fixtureLog('other');
  const before = readFileSync(registry, 'utf8');
  const C = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  assert.throws(() => sign({ log: other.path, ...C, genesis: true, after: B.state, registry, signer: signer() }), /log/);
  assert.equal(readFileSync(registry, 'utf8'), before);
  assert.ok(!existsSync(C.out) && !existsSync(C.state));
});
