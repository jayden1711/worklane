// Signed receipts, #918 round 14: what a log field holds is never misread. Round 13 hashed a NULL as it hashed "",
// and labelled it "unread" (a table whose NOT NULL was only written into its schema text, the round-13 second review's
// row 5, measured); read log text that wasn't UTF-8 as U+FFFD, so different bytes gave the same receipt (row 6); started
// a chain over an empty log with no first event to know it by (the round-13 final check, 3a); and said nothing when an
// actor was past the read bound (3b). Now each column is hashed with its storage class, a NULL is cut as `of: "null"`,
// text that isn't UTF-8 as `of: "not-utf8"`, `--genesis` over an empty log is refused, and `sign` and `verify` name an
// unread instance. Fixture logs and keys made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-13 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, type Envelope } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';
import { engineCli } from './helpers.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r14f-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
type St = { kind: string; event?: unknown; instance?: string; at?: string; cut?: Record<string, { length: number; of: string }> };
const statements = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as St);
const DECISION = JSON.stringify({ issue: 9, number: 9, head: sha('d'), auto: true, reasons: [] });

function fixtureLog(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'r14f-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.close();
  return { dir, path };
}
const chain = (path: string, dir: string) => {
  const k = keySigner(generateKeyPairSync('ed25519').privateKey);
  const A = { out: join(dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: path, ...A, genesis: true, registry: fresh('registry.jsonl'), signer: k });
  return { ...A, k };
};

test('a NULL hashes apart from "" and is cut as null, never as unread', () => {
  const f = fixtureLog();
  const db = new DatabaseSync(f.path);
  // The coordinator rebuilds its table so ts takes a NULL, then writes NOT NULL back into the schema's text.
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events'").get() as { sql: string }).sql;
  db.exec(`ALTER TABLE events RENAME TO old_events; ${sql.replace(/ts TEXT NOT NULL/, 'ts TEXT')}; INSERT INTO events SELECT * FROM old_events; DROP TABLE old_events`);
  db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (NULL, ?, ?, ?, ?)').run('merge.decided', 'inst', 'inst', DECISION);
  db.exec('PRAGMA writable_schema = ON');
  db.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'events'").run(sql);
  db.close();
  const A = chain(f.path, f.dir);
  const nine = statements(A.out).find((s) => String(s.event) === '2')!;
  assert.equal(nine.at, 'unrecorded');
  assert.equal(nine.cut?.at?.of, 'null');
  // The NULL turned into "" under the signed receipt is a log edit: refused.
  const w = new DatabaseSync(f.path);
  w.exec('DROP TRIGGER IF EXISTS events_no_update');
  w.exec("UPDATE events SET ts = '' WHERE id = 2");
  w.close();
  assert.throws(() => sign({ log: f.path, out: A.out, state: A.state, signer: A.k }), /log changed/);
});

test('an actor that is not UTF-8 is cut as not-utf8, never receipted as U+FFFD', () => {
  const f = fixtureLog();
  const db = new DatabaseSync(f.path);
  db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run('2026-10-21T00:00:00.000Z', 'merge.decided', Uint8Array.from([0x69, 0xff, 0xfe]), 'inst', DECISION);
  db.close();
  const A = chain(f.path, f.dir);
  const s = statements(A.out).find((x) => String(x.event) === '2')!;
  assert.equal(s.instance, '');
  assert.equal(s.cut?.instance?.of, 'not-utf8');
});

test('--genesis over an empty log is refused: a chain starts once the log has its first event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r14f-log-'));
  const path = join(dir, 'events.db');
  new EventLog(path).close();
  const out = join(dir, 'receipts.jsonl');
  const state = fresh('chain-state.json');
  const registry = fresh('registry.jsonl');
  assert.throws(() => sign({ log: path, out, state, genesis: true, registry, signer: keySigner(generateKeyPairSync('ed25519').privateKey) }), /no event/);
  assert.ok(!existsSync(out) && !existsSync(state) && !existsSync(registry));
});

test('sign reports, and verify lists, each receipt whose instance was never read', () => {
  const f = fixtureLog();
  const db = new DatabaseSync(f.path);
  db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run('2026-10-21T00:00:00.000Z', 'merge.decided', 'a'.repeat(70_000), 'inst', DECISION);
  db.close();
  const k = generateKeyPairSync('ed25519');
  const priv = fresh('k.key');
  const pub = fresh('k.pub');
  writeFileSync(priv, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(pub, k.publicKey.export({ type: 'spki', format: 'pem' }));
  const out = join(f.dir, 'receipts.jsonl');
  const cli = (...a: string[]) => spawnSync(process.execPath, [engineCli, 'receipts', ...a], { encoding: 'utf8', timeout: 60_000 });
  const sg = cli('sign', '--log', f.path, '--key', priv, '--out', out, '--state', fresh('chain-state.json'), '--genesis', '--registry', fresh('registry.jsonl'));
  assert.equal(sg.status, 0, sg.stderr);
  assert.match(sg.stdout, /1 with its instance unread/);
  const v = cli('verify', out, '--key', pub);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^UNREAD INSTANCE: receipt 2: event 2: /m);
});
