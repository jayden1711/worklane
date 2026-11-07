// Signed receipts, #918 round 11: the signer's chain registry, and one appended event never ends a chain. The registry
// (one append-only, hash-chained file per signer, outside any chain's state) records every chain start, rotation and
// end, so a key starts one chain only and a chain has one successor (round-10 review: P1, the same successor key
// starting a second chain; P2, a successor from a copy while the ended chain's state reads). A registry deleted or
// edited is refused. An appended event the signer can't read (not JSON, the wrong shape, a `ts` past the bound or
// empty) is signed as such and the chain goes on (P3); a successor never rotates to its predecessor's key (P7).
// Fixture logs, keys and directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-10 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, verifyChain, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, rotateFile, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'rr11-')), name);
/** The signer's chain registry for each log (round 12: a registry holds one first chain, for one log), unless a test gives its own. */
const registries = new Map<unknown, string>();
const registryFor = (log: unknown) => registries.get(log) ?? registries.set(log, fresh('registry.jsonl')).get(log)!;
const sign = (o: Record<string, unknown>) => signLog({ ...(o.genesis ? { registry: registryFor(o.log) } : {}), ...o } as unknown as Parameters<typeof signLog>[0]);
const rotate = (o: Record<string, unknown>) => rotateFile(o as unknown as Parameters<typeof rotateFile>[0]);
type St = { kind: string; event?: string; at?: string; cut?: Record<string, { length: number; of?: string }> };
const statements = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as St);

function keys(): { pub: KeyObject; signer: ReceiptSigner } {
  const k = generateKeyPairSync('ed25519');
  return { pub: k.publicKey, signer: keySigner(k.privateKey) };
}

/** A log: coordinator.started (1), a decision that merged (2-3), decision 42 held (4) and its failure (5). */
function fixtureLog(): { dir: string; path: string; log: EventLog } {
  const dir = mkdtempSync(join(tmpdir(), 'r11-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: sha('a'), auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: sha('a'), sha: sha('c'), url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['touches the merge policy'] }, 'inst');
  log.append('merge.failed', { issue: 8, number: 42, head: sha('b'), why: 'GitHub refused the merge' }, 'inst');
  return { dir, path, log };
}

/** The coordinator, which owns the log's database: an event written straight in, as it likes. */
function insert(dbPath: string, row: { ts: string; type: string; payload: string }): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(row.ts, row.type, 'inst', 'inst', row.payload);
  } finally {
    db.close();
  }
}
/** The coordinator flips decision 42 (event 4), its append-only trigger dropped. */
function flip(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.prepare('UPDATE events SET payload = ? WHERE id = 4').run(JSON.stringify({ issue: 8, number: 42, head: sha('b'), auto: true, reasons: [] }));
  } finally {
    db.close();
  }
}
const decided = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({ issue: n, number: n, head: sha('d'), auto: true, reasons: [], ...extra });
const TS = '2026-10-21T00:00:00.000Z';

/** Chain A signed, then decision 42 flipped: A refuses, and ends. */
function endedA(): { f: ReturnType<typeof fixtureLog>; a: ReturnType<typeof keys>; out: string; state: string } {
  const f = fixtureLog();
  const a = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = fresh('chain-state.json');
  sign({ log: f.path, out, state, genesis: true, signer: a.signer });
  flip(f.path);
  assert.throws(() => sign({ log: f.path, out, state, signer: a.signer }), /log changed/);
  return { f, a, out, state };
}

test('one successor key starts one chain: a second --after with a fresh --state and --out is refused (P1)', () => {
  const A = endedA();
  insert(A.f.path, { ts: TS, type: 'merge.decided', payload: decided(6) });
  const b = keys();
  sign({ log: A.f.path, out: fresh('receipts.jsonl'), state: fresh('chain-state.json'), genesis: true, after: A.state, signer: b.signer });
  const out2 = fresh('receipts.jsonl');
  assert.throws(() => sign({ log: A.f.path, out: out2, state: fresh('chain-state.json'), genesis: true, after: A.state, signer: b.signer }), /already started a chain/);
  assert.ok(!existsSync(out2));
});

test('a successor from a receipts copy is refused while the ended chain state can be read (P2)', () => {
  const A = endedA();
  sign({ log: A.f.path, out: fresh('receipts.jsonl'), state: fresh('chain-state.json'), genesis: true, after: A.state, signer: keys().signer });
  const copy = fresh('copy.jsonl');
  copyFileSync(A.out, copy);
  insert(A.f.path, { ts: TS, type: 'merge.decided', payload: decided(6) });
  const out = fresh('receipts.jsonl');
  assert.throws(() => sign({ log: A.f.path, out, state: fresh('chain-state.json'), genesis: true, after: copy, signer: keys().signer }), /can be read|successor/);
  assert.ok(!existsSync(out));
});

test('a registry deleted or edited is refused by every later sign', () => {
  for (const how of ['deleted', 'edited']) {
    const f = fixtureLog();
    const k = keys();
    const registry = fresh('registry.jsonl');
    const out = join(f.dir, 'receipts.jsonl');
    const state = fresh('chain-state.json');
    sign({ log: f.path, out, state, genesis: true, registry, signer: k.signer });
    insert(f.path, { ts: TS, type: 'merge.decided', payload: decided(6) });
    if (how === 'deleted') {
      if (existsSync(registry)) unlinkSync(registry);
      else writeFileSync(registry, 'x');
    } else writeFileSync(registry, existsSync(registry) ? readFileSync(registry, 'utf8').replace(/"key":"(.)/, (_m, c: string) => `"key":"${c === 'a' ? 'b' : 'a'}`) : 'x');
    const before = readFileSync(out, 'utf8');
    assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /registry/, how);
    assert.equal(readFileSync(out, 'utf8'), before);
  }
});

test('an appended event the signer cannot read is signed as unsignable, and the chain goes on (P3)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = fresh('chain-state.json');
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  insert(f.path, { ts: TS, type: 'merge.decided', payload: 'not json' });
  insert(f.path, { ts: TS, type: 'merge.decided', payload: decided(7, { head: 'zz' }) });
  insert(f.path, { ts: TS, type: 'merge.decided', payload: decided(8) });
  sign({ log: f.path, out, state, signer: k.signer });
  const st = statements(out);
  assert.deepEqual(st.slice(-3).map((s) => [s.kind, s.event]), [['event.unsignable', '6'], ['event.unsignable', '7'], ['merge.decided', '8']]);
  assert.ok(verifyChain(readReceiptFiles(out), { keys: [k.pub] }).ok);
});

test('an appended event with a ts past the bound, or empty, gets a receipt that records it (P3)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = fresh('chain-state.json');
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  insert(f.path, { ts: 't'.repeat(20_000), type: 'merge.decided', payload: decided(6) });
  insert(f.path, { ts: '', type: 'merge.decided', payload: decided(7) });
  sign({ log: f.path, out, state, signer: k.signer });
  const [six, seven] = statements(out).slice(-2);
  for (const [s, length] of [[six!, 20_000], [seven!, 0]] as const) {
    assert.ok(s.at && s.at !== '', 'at is never ""');
    assert.equal(s.cut?.at?.length, length);
  }
  assert.ok(verifyChain(readReceiptFiles(out), { keys: [k.pub] }).ok);
});

test('an unreadable appended event never burns the ended chain: its successor starts (P3a)', () => {
  const A = endedA();
  insert(A.f.path, { ts: TS, type: 'merge.decided', payload: 'not json' });
  const out = fresh('receipts.jsonl');
  sign({ log: A.f.path, out, state: fresh('chain-state.json'), genesis: true, after: A.state, signer: keys().signer });
  assert.deepEqual(statements(out).slice(1).map((s) => [s.kind, s.event]), [['event.unsignable', '6']]);
});

test('a successor never rotates to a key of the chain it succeeds; nothing is written (P7)', () => {
  const A = endedA();
  const b = keys();
  const out = fresh('receipts.jsonl');
  const state = fresh('chain-state.json');
  sign({ log: A.f.path, out, state, genesis: true, after: A.state, signer: b.signer });
  const before = [readFileSync(out, 'utf8'), readFileSync(state, 'utf8')];
  assert.throws(() => rotate({ out, state, signer: b.signer, next: A.a.pub }));
  assert.deepEqual([readFileSync(out, 'utf8'), readFileSync(state, 'utf8')], before);
});
