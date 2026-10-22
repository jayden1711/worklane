// Signed receipts, #918 round 13: a start whose state was saved is never "finished" again. Round 12 finished an
// interrupted start by matching its registry line, and couldn't tell a start that crashed before its state was
// written from a chain whose state and receipts were deleted later: the same key then signed the chain again from its
// start, over the log as it was then (the round-12 builder's probes X1 and X8, measured). Now the registry gets a line
// once a start's state is saved, and a rerun over a saved start is refused. Fixture logs, keys and directories made
// here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-12 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, type Envelope } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r13r-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const signer = () => keySigner(generateKeyPairSync('ed25519').privateKey);
const bytes = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/** A log: coordinator.started (1), decision 42 held (2). */
function fixtureLog(): { dir: string; path: string; log: EventLog } {
  const dir = mkdtempSync(join(tmpdir(), 'r13r-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['held'] }, 'inst');
  return { dir, path, log };
}
function flip(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TRIGGER IF EXISTS events_no_update');
  db.prepare('UPDATE events SET payload = ? WHERE id = 2').run(JSON.stringify({ issue: 8, number: 42, head: sha('b'), auto: true, reasons: [] }));
  db.close();
}

test("a first chain's state and receipts deleted, then its own --genesis rerun: refused, nothing written (X1)", () => {
  const f = fixtureLog();
  const registry = fresh('registry.jsonl');
  const a = signer();
  const A = { out: join(f.dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...A, genesis: true, registry, signer: a });
  const copy = fresh('copy.jsonl');
  copyFileSync(A.out, copy);
  unlinkSync(A.state);
  unlinkSync(A.out);
  flip(f.path);
  const before = bytes(registry);
  assert.throws(() => sign({ log: f.path, ...A, genesis: true, registry, signer: a }), /saved/);
  assert.equal(bytes(registry), before);
  assert.ok(!existsSync(A.state) && !existsSync(A.out), 'the deleted chain was signed again');
  // The way on: a new key succeeds it from a copy of its receipts (its state can't be read).
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...B, genesis: true, after: copy, registry, signer: signer() });
  assert.equal((statementOf((readReceiptFiles(B.out) as Envelope[])[0]!) as { previous: { from: string } }).previous.from, 'copy');
});

test("a successor's state and receipts deleted, then its own --genesis --after rerun: refused, nothing written (X8)", () => {
  const f = fixtureLog();
  const registry = fresh('registry.jsonl');
  const a = signer();
  const A = { out: join(f.dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...A, genesis: true, registry, signer: a });
  flip(f.path);
  assert.throws(() => sign({ log: f.path, ...A, signer: a }), /log changed/);
  const b = signer();
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...B, genesis: true, after: A.state, registry, signer: b });
  f.log.append('merge.decided', { issue: 9, number: 43, head: sha('e'), auto: true, reasons: [] }, 'inst');
  sign({ log: f.path, ...B, signer: b });
  unlinkSync(B.state);
  unlinkSync(B.out);
  const before = bytes(registry);
  assert.throws(() => sign({ log: f.path, ...B, genesis: true, after: A.state, registry, signer: b }), /saved/);
  assert.equal(bytes(registry), before);
  assert.ok(!existsSync(B.state) && !existsSync(B.out), 'the deleted successor was signed again');
});
