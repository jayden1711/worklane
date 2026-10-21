// Signed receipts, #918 round 9: a chain that ended never gets its events signed again by the chain after it, and one
// oversized event can't end receipts. A successor chain (`--genesis --after <the ended chain's state or receipts>`)
// names the chain it succeeds in its `chain.started` and receipts only events after that chain's last one, with a
// key that never signed it (round-8 review, routes 1, 1b, 1c). A free-text field over its bound is cut in the
// receipt, with the SHA-256 of the whole (route 2). Also: a directory `--out` is refused before the state is written,
// a whitespace-only receipts line is refused, and every unreadable state gets the "chain ends here" guidance.
// Fixture logs, keys and directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-8 code (the fail-without
// run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { canonicalJson, keySigner, statementOf, verifyChain, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, rotateFile, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const H1 = sha('a');
const H2 = sha('b');
const M1 = sha('c');

const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const rotate = (o: Record<string, unknown>) => rotateFile(o as unknown as Parameters<typeof rotateFile>[0]);
const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
type St = { kind: string; event?: number; decision?: { auto: boolean; reasons: string[] }; previous?: unknown; cut?: Record<string, { sha256: string; length: number }> };
const statements = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as St);

function keys(): { pub: KeyObject; signer: ReceiptSigner } {
  const k = generateKeyPairSync('ed25519');
  return { pub: k.publicKey, signer: keySigner(k.privateKey) };
}

/** A log with one decision that merged, and one held for the owner (event 4) that then failed to merge. */
function fixtureLog(): { dir: string; path: string; log: EventLog } {
  const dir = mkdtempSync(join(tmpdir(), 'r9-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: H1, auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: H1, sha: M1, url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: H2, auto: false, reasons: ['touches the merge policy'] }, 'inst');
  log.append('merge.failed', { issue: 8, number: 42, head: H2, why: 'GitHub refused the merge' }, 'inst');
  return { dir, path, log };
}

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'rs9-')), 'chain-state.json');
const outFile = () => join(mkdtempSync(join(tmpdir(), 'ro9-')), 'receipts.jsonl');

/** The coordinator, which owns the log's database file: drops the append-only trigger and flips the held decision. */
function editHeldDecision(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.prepare("UPDATE events SET payload = ? WHERE type = 'merge.decided' AND json_extract(payload, '$.number') = 42").run(JSON.stringify({ issue: 8, number: 42, head: H2, auto: true, reasons: [] }));
  } finally {
    db.close();
  }
}

/** A chain signed by `k`, the held decision then edited: `sign` refuses, and the chain ends. */
function endedChain(k = keys()): { f: ReturnType<typeof fixtureLog>; k: ReturnType<typeof keys>; out: string; state: string } {
  const f = fixtureLog();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  editHeldDecision(f.path);
  f.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /log changed/);
  return { f, k, out, state };
}

test('a successor chain with a new key never signs the events the ended chain signed (round-8 review, route 1)', () => {
  for (const from of ['state', 'receipts copy']) {
    const old = endedChain();
    const after = from === 'state' ? old.state : join(mkdtempSync(join(tmpdir(), 'rc9-')), 'copy.jsonl');
    if (from !== 'state') copyFileSync(old.out, after);
    const k2 = keys();
    const out = outFile();
    sign({ log: old.f.path, out, state: stateFile(), genesis: true, after, signer: k2.signer });
    const st = statements(out);
    assert.ok(verifyChain(readReceiptFiles(out), { keys: [k2.pub] }).ok);
    // Only the event after the ended chain's last one (decision 43, event 6); the edited decision 42 (event 4) never.
    assert.deepEqual(st.filter((s) => s.kind !== 'chain.started').map((s) => s.event), [6], `${from}: ${JSON.stringify(st.map((s) => s.event))}`);
    assert.ok(st[0]!.previous, `${from}: chain.started names the chain it succeeds`);
  }
});

test('a successor chain refuses a key that signed the ended chain: the same key on a fresh state (route 1b)', () => {
  const old = endedChain();
  const out = outFile();
  assert.throws(() => sign({ log: old.f.path, out, state: stateFile(), genesis: true, after: old.state, signer: old.k.signer }), /signed the chain/);
  assert.ok(!existsSync(out));
});

test('a successor chain refuses a retired key of the ended chain, and its last key (route 1c)', () => {
  const f = fixtureLog();
  const s = keys();
  const k2 = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: s.signer });
  rotate({ out, state, signer: s.signer, next: k2.pub });
  editHeldDecision(f.path);
  for (const k of [s, k2]) {
    const next = outFile();
    assert.throws(() => sign({ log: f.path, out: next, state: stateFile(), genesis: true, after: state, signer: k.signer }), /signed the chain/);
    assert.ok(!existsSync(next));
  }
});

test('one oversized free-text field is cut in its receipt, with the SHA-256 of the whole: receipts stay verifiable (route 2)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  const huge = 'x'.repeat(50 * 1024 * 1024);
  f.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: false, reasons: [huge] }, 'inst');
  sign({ log: f.path, out, state, signer: k.signer });
  assert.ok(statSync(out).size < 1024 * 1024, `the receipts file is ${statSync(out).size} bytes`);
  const envs = readReceiptFiles(out) as Envelope[];
  assert.ok(verifyChain(envs, { keys: [k.pub] }).ok);
  const last = statementOf(envs.at(-1)!) as St;
  assert.ok(last.decision!.reasons[0]!.length < 4096, 'the reason is cut');
  assert.deepEqual(last.cut?.['decision.reasons.0'], { sha256: createHash('sha256').update(huge, 'utf8').digest('hex'), length: huge.length });
});

test('a directory --out is refused before the state is written', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  const dir = mkdtempSync(join(tmpdir(), 'rd9-'));
  copyFileSync(out, join(dir, '0001.jsonl'));
  f.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  const before = readFileSync(state, 'utf8');
  assert.throws(() => sign({ log: f.path, out: dir, state, signer: k.signer }), /directory/);
  assert.equal(readFileSync(state, 'utf8'), before, 'the state did not move on');
});

test('a receipts line holding only whitespace is refused, not skipped', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  sign({ log: f.path, out, state: stateFile(), genesis: true, signer: k.signer });
  const lines = (readReceiptFiles(out) as Envelope[]).map((e) => canonicalJson(e));
  const file = join(mkdtempSync(join(tmpdir(), 'rw9-')), 'r.jsonl');
  writeFileSync(file, `${lines[0]}\n${String.fromCharCode(0xa0)}\n${lines.slice(1).join('\n')}\n`);
  assert.throws(() => readReceiptFiles(file), /r\.jsonl:2 is not (JSON|one receipt in canonical JSON)/);
});

test('every unreadable state says the chain ends here: a second name, or bytes that are not UTF-8', () => {
  for (const how of ['second name', 'not UTF-8']) {
    const f = fixtureLog();
    const k = keys();
    const out = join(f.dir, 'receipts.jsonl');
    const state = stateFile();
    sign({ log: f.path, out, state, genesis: true, signer: k.signer });
    if (how === 'second name') linkSync(state, join(dirname(state), 'alias.json'));
    else writeFileSync(state, Buffer.concat([readFileSync(state), Buffer.from([0xff])]));
    assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /chain ends here/, how);
    assert.equal(text(out) !== null, true);
  }
});
