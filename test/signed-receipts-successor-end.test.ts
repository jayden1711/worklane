// Signed receipts, #918 round 10: an ended chain stays ended, a successor never re-signs, and one event can't stall the
// signer. Rows of the round-9 second review: an ended chain resuming beside its successor once the log is restored
// (1); two successors of one chain (2); a successor from a receipts copy cut short (3), and cut before a rotation (3b);
// `verify` honouring a successor's `previous` (4); a 3.5 MB string of private-key BEGIN markers (6); a lone surrogate
// and U+FFFD past the cut (7). Fixture logs, keys and directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-9 code (the fail-without
// run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { canonicalJson, keyId, keySigner, pae, PAYLOAD_TYPE, receiptId, statementOf, verifyChain, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, rotateFile, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
/** The signer's chain registry for each log (round 12: a registry holds one first chain, for one log), unless a test gives its own. */
const registries = new Map<unknown, string>();
const registryFor = (log: unknown) => registries.get(log) ?? registries.set(log, join(mkdtempSync(join(tmpdir(), 'rreg-')), 'registry.jsonl')).get(log)!;
const sign = (o: Record<string, unknown>) => signLog({ ...(o.genesis ? { registry: registryFor(o.log) } : {}), ...o } as unknown as Parameters<typeof signLog>[0]);
const rotate = (o: Record<string, unknown>) => rotateFile(o as unknown as Parameters<typeof rotateFile>[0]);
type St = { kind: string; event?: string; previous?: { keys: string[]; event: string; from?: string } | null; decision?: { auto: boolean; reasons: string[] }; cut?: Record<string, { sha256: string }> };
const statements = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as St);
const merges = (out: string) => statements(out).filter((s) => s.kind === 'merge.decided' || s.kind === 'merge.result');

function keys(): { pub: KeyObject; signer: ReceiptSigner } {
  const k = generateKeyPairSync('ed25519');
  return { pub: k.publicKey, signer: keySigner(k.privateKey) };
}

/** A log: coordinator.started (1), a decision that merged (2-3). `held` adds decision 42 held (4) and its failure (5). */
function fixtureLog(): { dir: string; path: string; log: EventLog; held: () => void; next: (n: number) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rx-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: sha('a'), auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: sha('a'), sha: sha('c'), url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  const held = () => {
    log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['touches the merge policy'] }, 'inst');
    log.append('merge.failed', { issue: 8, number: 42, head: sha('b'), why: 'GitHub refused the merge' }, 'inst');
  };
  const next = (n: number) => log.append('merge.decided', { issue: n, number: n, head: sha('d'), auto: false, reasons: ['X: held'] }, 'inst');
  return { dir, path, log, held, next };
}

const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'rxs-')), name);

/** The coordinator, which owns the log's database: sets one event's stored payload text, append-only trigger dropped. */
function setPayload(dbPath: string, id: number, text: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(text, id);
  } finally {
    db.close();
  }
}
function payloadOf(dbPath: string, id: number): string {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare('SELECT payload FROM events WHERE id = ?').get(id) as { payload: string }).payload;
  } finally {
    db.close();
  }
}
const FLIPPED = JSON.stringify({ issue: 8, number: 42, head: sha('b'), auto: true, reasons: [] });

/** Chain A over the held decision, then the decision flipped: A refuses, and ends. */
function endedA(): { f: ReturnType<typeof fixtureLog>; a: ReturnType<typeof keys>; out: string; state: string; original: string } {
  const f = fixtureLog();
  f.held();
  const a = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = fresh('chain-state.json');
  sign({ log: f.path, out, state, genesis: true, signer: a.signer });
  const original = payloadOf(f.path, 4);
  setPayload(f.path, 4, FLIPPED);
  assert.throws(() => sign({ log: f.path, out, state, signer: a.signer }), /log changed/);
  return { f, a, out, state, original };
}

test('an ended chain never resumes beside its successor, even once the log is restored (row 1)', () => {
  const A = endedA();
  A.f.next(6);
  const b = keys();
  const outB = fresh('receipts.jsonl');
  sign({ log: A.f.path, out: outB, state: fresh('chain-state.json'), genesis: true, after: A.state, signer: b.signer });
  assert.deepEqual(merges(outB).map((s) => s.event), ['6']);
  // The coordinator restores event 4 and changes event 6.
  setPayload(A.f.path, 4, A.original);
  setPayload(A.f.path, 6, JSON.stringify({ issue: 6, number: 6, head: sha('d'), auto: true, reasons: ['Y: auto'] }));
  const before = readFileSync(A.out, 'utf8');
  assert.throws(() => sign({ log: A.f.path, out: A.out, state: A.state, signer: A.a.signer }), /ended/);
  assert.equal(readFileSync(A.out, 'utf8'), before, 'the ended chain signed nothing');
});

test('an ended chain has one successor: a second --after on it is refused (row 2)', () => {
  const A = endedA();
  A.f.next(6);
  const outB = fresh('receipts.jsonl');
  sign({ log: A.f.path, out: outB, state: fresh('chain-state.json'), genesis: true, after: A.state, signer: keys().signer });
  setPayload(A.f.path, 6, JSON.stringify({ issue: 6, number: 6, head: sha('d'), auto: true, reasons: ['Y: auto'] }));
  const outC = fresh('receipts.jsonl');
  assert.throws(() => sign({ log: A.f.path, out: outC, state: fresh('chain-state.json'), genesis: true, after: A.state, signer: keys().signer }), /successor/);
});

test('a successor from a receipts copy cut short starts after the log, never re-signing (rows 3 and 3b)', () => {
  for (const rotated of [false, true]) {
    const f = fixtureLog();
    const k1 = keys();
    const k2 = keys();
    const out = join(f.dir, 'receipts.jsonl');
    const state = fresh('chain-state.json');
    sign({ log: f.path, out, state, genesis: true, signer: k1.signer });
    // The auditor's look, and the copy later cut back to it: before the held decision (and before a rotation).
    const look = readFileSync(out, 'utf8');
    if (rotated) rotate({ out, state, signer: k1.signer, next: k2.pub });
    f.held();
    sign({ log: f.path, out, state, signer: rotated ? k2.signer : k1.signer });
    setPayload(f.path, 4, FLIPPED);
    const copy = fresh('copy.jsonl');
    writeFileSync(copy, look);
    // Round 11: a copy is taken only when the ended chain's state can't be read.
    writeFileSync(state, 'not a state');
    const outB = fresh('receipts.jsonl');
    if (rotated) {
      // Row 3b: the chain's own current key, which the cut copy doesn't name: the registry does, so it is refused.
      assert.throws(() => sign({ log: f.path, out: outB, state: fresh('chain-state.json'), genesis: true, after: copy, signer: k2.signer }), /already signed a chain/);
      continue;
    }
    // Row 3: a new key starts, and signs nothing the ended chain covered.
    sign({ log: f.path, out: outB, state: fresh('chain-state.json'), genesis: true, after: copy, signer: keys().signer });
    const signed = statements(outB);
    assert.deepEqual(signed.filter((s) => s.kind !== 'chain.started' && BigInt(s.event ?? '0') <= 5n).map((s) => s.event), [], 'events the ended chain covered were signed again');
    assert.equal(signed[0]!.previous?.from, 'copy', 'the successor says it came from a copy');
  }
});

test('rotate on an ended chain is refused, nothing written', () => {
  const A = endedA();
  sign({ log: A.f.path, out: fresh('receipts.jsonl'), state: fresh('chain-state.json'), genesis: true, after: A.state, signer: keys().signer });
  const before = [readFileSync(A.out, 'utf8'), readFileSync(A.state, 'utf8')];
  assert.throws(() => rotate({ out: A.out, state: A.state, signer: A.a.signer, next: keys().pub }), /ended/);
  assert.deepEqual([readFileSync(A.out, 'utf8'), readFileSync(A.state, 'utf8')], before);
});

/** A DSSE envelope over `st`, signed by `k` (what a successor's key holder can make by hand). */
function sealWith(k: { signer: ReceiptSigner; pub: KeyObject }, st: unknown): Envelope {
  const bytes = Buffer.from(canonicalJson(st), 'utf8');
  return { payloadType: PAYLOAD_TYPE, payload: bytes.toString('base64'), signatures: [{ keyid: keyId(k.pub), sig: k.signer.sign(pae(PAYLOAD_TYPE, bytes)).toString('base64') }] };
}

test("verify holds a successor to its own previous: no event at or before the ended chain's last, no key of it (row 4)", () => {
  const A = endedA();
  const b = keys();
  const outB = fresh('receipts.jsonl');
  sign({ log: A.f.path, out: outB, state: fresh('chain-state.json'), genesis: true, after: A.state, signer: b.signer });
  const started = (readReceiptFiles(outB) as Envelope[])[0]!;
  // A receipt for event 4, which the ended chain covered, signed by hand after the successor's start.
  const old = (readReceiptFiles(A.out) as Envelope[]).map((e) => statementOf(e) as Record<string, unknown>).find((s) => s.event === '4')!;
  assert.ok(old, "the ended chain's receipt for event 4");
  const resigned = sealWith(b, { ...old, seq: 1, prev: receiptId(started) });
  const r1 = verifyChain([started, resigned], { keys: [b.pub] });
  assert.ok(!r1.ok, 'an event at or before previous.event verified');
  // A start key among previous.keys, signed by hand.
  const st = statementOf(started) as { previous: { keys: string[] } } & Record<string, unknown>;
  const own = sealWith(b, { ...st, previous: { ...st.previous, keys: [...st.previous.keys, keyId(b.pub)] } });
  assert.ok(!verifyChain([own], { keys: [b.pub] }).ok, 'a successor started by a key of the chain it succeeds verified');
});

test('one event of 3.5 MB of private-key BEGIN markers never stalls the signer (row 6)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = fresh('chain-state.json');
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  // Written by the coordinator straight into its database, as the review did (the log's own write would redact it).
  const marker = '-----BEGIN PRIVATE KEY-----';
  const reason = marker.repeat(Math.ceil((3.5 * 1024 * 1024) / marker.length));
  const db = new DatabaseSync(f.path);
  try {
    db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), 'merge.decided', 'inst', 'inst', JSON.stringify({ issue: 9, number: 9, head: sha('d'), auto: false, reasons: [reason] }));
  } finally {
    db.close();
  }
  // A duration, so from the monotonic clock (test/no-wall-clock-durations.test.ts, #582).
  const t0 = performance.now();
  sign({ log: f.path, out, state, signer: k.signer });
  const ms = Math.round(performance.now() - t0);
  assert.ok(ms < 15_000, `signing took ${ms} ms`);
  assert.ok(verifyChain(readReceiptFiles(out), { keys: [k.pub] }).ok);
});

test('two values that differ only past the cut get different digests: a lone surrogate is not U+FFFD (row 7)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const base = 'a'.repeat(2001);
  f.log.append('merge.decided', { issue: 9, number: 9, head: sha('d'), auto: false, reasons: [base + String.fromCharCode(0xd800)] }, 'inst');
  f.log.append('merge.decided', { issue: 10, number: 10, head: sha('e'), auto: false, reasons: [base + String.fromCharCode(0xfffd)] }, 'inst');
  sign({ log: f.path, out, state: fresh('chain-state.json'), genesis: true, signer: k.signer });
  const cuts = statements(out).filter((s) => s.kind === 'merge.decided' && s.cut?.['decision.reasons.0']).map((s) => s.cut!['decision.reasons.0']!.sha256);
  assert.equal(cuts.length, 2);
  assert.notEqual(cuts[0], cuts[1]);
});
