// Signed receipts, #918 round 12: the signer's chain registry knows a chain by its start line, not by where its state
// sits. Round 11 matched a chain's end by its state's path: a state directory renamed, then a successor started from a
// receipts copy, left two live chains that signed the same event with different facts (the round-11 second review,
// row 3, and the delta check's 3.2, measured). The copy route took the first chain whose key a copy names, so a
// successor's successor was a dead end (3.3). A registry took a second first chain (`previous: null`) beside a recorded
// one (row 1), and an interrupted successor start could be finished as a first chain (row 2). Fixture logs, keys and
// directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-11 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keyId, keySigner, statementOf, verifyChain, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r12d-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
type St = { kind: string; event?: unknown; previous?: { keys: string[]; head: string; from: string } | null };
const statements = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as St);
const events = (out: string) => statements(out).filter((s) => s.kind !== 'chain.started').map((s) => String(s.event));

function keys(): { pub: KeyObject; signer: ReceiptSigner; id: string } {
  const k = generateKeyPairSync('ed25519');
  return { pub: k.publicKey, signer: keySigner(k.privateKey), id: keyId(k.publicKey) };
}

/** A log: coordinator.started (1), a decision that merged (2-3), decision 42 held (4) and its failure (5). */
function fixtureLog(): { dir: string; path: string; log: EventLog } {
  const dir = mkdtempSync(join(tmpdir(), 'r12d-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: sha('a'), auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: sha('a'), sha: sha('c'), url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['touches the merge policy'] }, 'inst');
  log.append('merge.failed', { issue: 8, number: 42, head: sha('b'), why: 'GitHub refused the merge' }, 'inst');
  return { dir, path, log };
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

const decide = (log: EventLog, n: number) => log.append('merge.decided', { issue: n, number: n, head: sha('e'), auto: true, reasons: [] }, 'inst');

test('a state moved from where its start was recorded never signs, and a copy-started successor ends it wherever it is', () => {
  const f = fixtureLog();
  const registry = fresh('registry.jsonl');
  const a = keys();
  const stateDir = mkdtempSync(join(tmpdir(), 'r12d-st-'));
  const A = { out: join(f.dir, 'receipts.jsonl'), state: join(stateDir, 'chain-state.json') };
  sign({ log: f.path, ...A, genesis: true, registry, signer: a.signer });
  const copy = fresh('copy.jsonl');
  copyFileSync(A.out, copy);
  const moved = `${stateDir}-moved`;
  renameSync(stateDir, moved);
  decide(f.log, 6);
  const signedBefore = events(A.out);
  assert.throws(() => sign({ log: f.path, out: A.out, state: join(moved, 'chain-state.json'), signer: a.signer }), /recorded|moved/, 'a moved state signed');
  // Nothing at the recorded path can be read, so the copy route starts a successor.
  const b = keys();
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...B, genesis: true, after: copy, registry, signer: b.signer });
  assert.equal(statements(B.out)[0]!.previous?.from, 'copy');
  decide(f.log, 7);
  sign({ log: f.path, ...B, signer: b.signer });
  // The ended chain is refused at its new path, and moved back.
  assert.throws(() => sign({ log: f.path, out: A.out, state: join(moved, 'chain-state.json'), signer: a.signer }), /ended|successor|recorded|moved/);
  renameSync(moved, stateDir);
  assert.throws(() => sign({ log: f.path, ...A, signer: a.signer }), /ended|successor/);
  assert.deepEqual(events(A.out), signedBefore, 'the ended chain signed again');
  assert.deepEqual(events(A.out).filter((e) => events(B.out).includes(e)), [], 'an event receipted by both chains');
});

test("a successor's successor starts from a copy of its receipts, found by the copy's own start key", () => {
  const f = fixtureLog();
  const registry = fresh('registry.jsonl');
  const a = keys();
  const A = { out: join(f.dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...A, genesis: true, registry, signer: a.signer });
  flip(f.path);
  assert.throws(() => sign({ log: f.path, ...A, signer: a.signer }), /log changed/);
  const b = keys();
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...B, genesis: true, after: A.state, registry, signer: b.signer });
  decide(f.log, 6);
  sign({ log: f.path, ...B, signer: b.signer });
  // B's state is lost (it no longer reads); a copy of its receipts is kept.
  const copy = fresh('copy.jsonl');
  copyFileSync(B.out, copy);
  writeFileSync(B.state, 'not a state');
  decide(f.log, 7);
  const c = keys();
  const C = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...C, genesis: true, after: copy, registry, signer: c.signer });
  const started = statements(C.out)[0]!;
  assert.equal(started.previous?.from, 'copy');
  assert.deepEqual([...started.previous!.keys].sort(), [a.id, b.id].sort());
  assert.ok(verifyChain(readReceiptFiles(C.out), { keys: [c.pub] }).ok);
  // And B has that one successor only.
  const D = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  assert.throws(() => sign({ log: f.path, ...D, genesis: true, after: copy, registry, signer: keys().signer }), /successor/);
  assert.ok(!existsSync(D.out) && !existsSync(D.state));
});

test('a registry holds one first chain, for one log: a second plain --genesis is refused, and nothing is written', () => {
  const f = fixtureLog();
  const registry = fresh('registry.jsonl');
  const a = keys();
  const A = { out: join(f.dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...A, genesis: true, registry, signer: a.signer });
  const other = fixtureLog();
  const refused = (o: Record<string, unknown>, why: RegExp, what: string) => {
    const before = readFileSync(registry, 'utf8');
    const C = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
    assert.throws(() => sign({ ...C, genesis: true, registry, signer: keys().signer, ...o }), why, what);
    assert.equal(readFileSync(registry, 'utf8'), before, `${what}: the registry changed`);
    assert.ok(!existsSync(C.out) && !existsSync(C.state), `${what}: something was written`);
  };
  refused({ log: f.path }, /first chain|previous: null|--after/, 'a new key, the same log');
  refused({ log: other.path }, /first chain|previous: null|--after|log/, 'a new key, another log');
  // After A ended and its successor started, still none.
  flip(f.path);
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...B, genesis: true, after: A.state, registry, signer: keys().signer });
  refused({ log: f.path }, /first chain|previous: null|--after/, 'after a successor');
  // A successor of B over another log is refused too: a registry serves one log.
  refused({ log: other.path, after: B.state }, /log/, 'a successor over another log');
});

test('an interrupted successor start is finished only as what the registry recorded it as, and then marks the ended chain', () => {
  const f = fixtureLog();
  const registry = fresh('registry.jsonl');
  const a = keys();
  const A = { out: join(f.dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...A, genesis: true, registry, signer: a.signer });
  flip(f.path);
  assert.throws(() => sign({ log: f.path, ...A, signer: a.signer }), /log changed/);
  const unmarked = readFileSync(A.state, 'utf8');
  const b = keys();
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: f.path, ...B, genesis: true, after: A.state, registry, signer: b.signer });
  // The start as a crash right after the registry's start line leaves it: no ended mark yet, no state, no receipts,
  // and (round 13) no `saved` line after B's start line, which is the registry's last line.
  writeFileSync(A.state, unmarked);
  unlinkSync(B.state);
  unlinkSync(B.out);
  const lines = readFileSync(registry, 'utf8').trimEnd().split('\n');
  assert.equal((JSON.parse(lines.at(-1)!) as { kind: string }).kind, 'saved', "B's saved line is the registry's last: the crash is simulated by cutting it");
  writeFileSync(registry, `${lines.slice(0, -1).join('\n')}\n`);
  // Finished as a first chain: refused, nothing written (round 11 took it, and B signed decision 42 flipped).
  assert.throws(() => sign({ log: f.path, ...B, genesis: true, registry, signer: b.signer }), /--after/);
  assert.ok(!existsSync(B.state) && !existsSync(B.out));
  assert.equal(readFileSync(A.state, 'utf8'), unmarked);
  // Finished as recorded: it starts after A, and marks A ended.
  sign({ log: f.path, ...B, genesis: true, after: A.state, registry, signer: b.signer });
  assert.deepEqual(events(B.out), [], 'the successor signed an event the ended chain covered');
  assert.equal((JSON.parse(readFileSync(A.state, 'utf8')) as { ended: { successor: string } | null }).ended?.successor, b.id);
});
