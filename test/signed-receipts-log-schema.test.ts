// Signed receipts, #918 round 13 (the round-12 reviews' advisories): the signer reads only the log shape it knows,
// never skips a merge event silently, and names what it refuses. Round 12 read whatever `events` was: a view (which
// can yield endless rows: `sign` ran on with the signer's lock held), or a table rebuilt with an untyped id, where an
// id "abc" threw a raw SyntaxError. Merge events at ids <= 0 were skipped with no word. A registry through a linked
// directory was refused as a "chain state", and a rotation to a key the registry holds said it "already signed a
// chain". Fixture logs, keys and directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-12 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, ReceiptError } from '../src/signed-receipts.js';
import { rotateFile, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r13s-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const rotate = (o: Record<string, unknown>) => rotateFile(o as unknown as Parameters<typeof rotateFile>[0]);

function fixtureLog(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'r13s-log-')), 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['held'] }, 'inst');
  log.close();
  return path;
}
const genesis = (log: string) => sign({ log, out: fresh('receipts.jsonl'), state: fresh('chain-state.json'), genesis: true, registry: fresh('registry.jsonl'), signer: keySigner(generateKeyPairSync('ed25519').privateKey) });
const refusedAsSchema = (log: string, what: string) =>
  assert.throws(
    () => genesis(log),
    (e: unknown) => e instanceof ReceiptError && /events/.test(e.message) && /table|INTEGER PRIMARY KEY/.test(e.message),
    what,
  );

test('an events view, or a table whose id is not INTEGER PRIMARY KEY, is refused as a log the signer does not read', () => {
  const view = fixtureLog();
  const v = new DatabaseSync(view);
  v.exec('ALTER TABLE events RENAME TO real_events; CREATE VIEW events AS SELECT * FROM real_events');
  v.close();
  refusedAsSchema(view, 'a view');
  const untyped = fixtureLog();
  const u = new DatabaseSync(untyped);
  u.exec('ALTER TABLE events RENAME TO old_events; CREATE TABLE events (id, ts, type, actor, source, payload); INSERT INTO events SELECT * FROM old_events; DROP TABLE old_events');
  u.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)').run('abc', '2026-10-21T00:00:00.000Z', 'merge.decided', 'inst', 'inst', '{}');
  u.close();
  refusedAsSchema(untyped, 'an untyped id');
});

test('merge events at ids <= 0 are reported as skipped, never passed over silently', () => {
  const log = fixtureLog();
  const db = new DatabaseSync(log);
  for (const id of [-5, 0]) db.prepare('INSERT INTO events (id, ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?, ?)').run(id, '2026-10-21T00:00:00.000Z', 'merge.decided', 'inst', 'inst', JSON.stringify({ issue: 1, number: 1, head: sha('f'), auto: true, reasons: [] }));
  db.close();
  assert.equal((genesis(log) as unknown as { skipped: number }).skipped, 2);
});

test('a registry through a linked directory is refused as a registry; a rotation to a key the registry holds says to make a new key', () => {
  const real = mkdtempSync(join(tmpdir(), 'r13s-real-'));
  const linkDir = join(mkdtempSync(join(tmpdir(), 'r13s-ln-')), 'reg');
  symlinkSync(real, linkDir);
  const log = fixtureLog();
  assert.throws(() => sign({ log, out: fresh('receipts.jsonl'), state: fresh('chain-state.json'), genesis: true, registry: join(linkDir, 'registry.jsonl'), signer: keySigner(generateKeyPairSync('ed25519').privateKey) }), /chain registry goes in a directory/);
  const k1 = generateKeyPairSync('ed25519');
  const k2 = generateKeyPairSync('ed25519');
  const A = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log, ...A, genesis: true, registry: fresh('registry.jsonl'), signer: keySigner(k1.privateKey) });
  rotate({ ...A, signer: keySigner(k1.privateKey), next: k2.publicKey });
  assert.throws(() => rotate({ ...A, signer: keySigner(k2.privateKey), next: k1.publicKey }), /make a new key/i);
});
