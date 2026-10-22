// Signed receipts, #918 round 12: what the signer couldn't read is shown, not only counted. Since round 11 a merge event
// the signer can't read gets an `event.unsignable` receipt, and an empty or over-bound `ts` gives `at: "unrecorded"`.
// Round 11's `verify` only counted the first in its summary line and said nothing of the second, and `sign` said
// neither (the round-11 delta check, 3.5, measured). Now `sign` reports how many of each it signed, and `verify` prints
// one line per such receipt, as it does for FLAGGED and UNRECORDED. Fixture logs and keys made here, in temp dirs; no
// network, no real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { engineCli } from './helpers.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r12v-')), name);
const cli = (...a: string[]) => spawnSync(process.execPath, [engineCli, 'receipts', ...a], { encoding: 'utf8', timeout: 60_000 });

function insert(dbPath: string, ts: string, payload: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(ts, 'merge.decided', 'inst', 'inst', payload);
  } finally {
    db.close();
  }
}

test('sign reports, and verify lists, each event.unsignable receipt and each at "unrecorded"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r12v-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.close();
  // Event 2: not JSON. Event 3: a whole decision with an empty ts.
  insert(path, '2026-10-21T00:00:00.000Z', 'not json');
  insert(path, '', JSON.stringify({ issue: 9, number: 9, head: sha('d'), auto: true, reasons: [] }));
  const k = generateKeyPairSync('ed25519');
  const priv = fresh('receipts.key');
  const pub = fresh('receipts.pub');
  writeFileSync(priv, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pub, k.publicKey.export({ type: 'spki', format: 'pem' }));
  const out = join(dir, 'receipts.jsonl');
  const sg = cli('sign', '--log', path, '--key', priv, '--out', out, '--state', fresh('chain-state.json'), '--genesis', '--registry', fresh('registry.jsonl'));
  assert.equal(sg.status, 0, sg.stderr);
  assert.match(sg.stdout, /1 event\.unsignable/);
  assert.match(sg.stdout, /1 with at "unrecorded"/);
  const v = cli('verify', out, '--key', pub);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^UNSIGNABLE: receipt 2: event 2 \(merge\.decided\): /m);
  assert.match(v.stdout, /^UNRECORDED TIME: receipt 3: event 3: /m);
});
