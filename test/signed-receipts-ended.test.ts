// Signed receipts, #918 round 9: once a chain ends, the chain after it never signs again an event the ended chain
// covered. E1: the receipts deleted and a held decision edited, then a new key starts a new chain. E2: the log edited
// with the receipts intact, then the same (the round-8 delta check, measured: both re-signed the edited decision). The
// new chain is a successor (`--genesis --after <the ended chain's state>`), started with a new `--state` and `--out`,
// the old files kept. Fixture logs, keys and directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-8 code (the fail-without
// run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, verifyChain, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
/** The signer's chain registry for this file (round 11): every genesis is recorded there unless a test gives its own. */
const REGISTRY = join(mkdtempSync(join(tmpdir(), 'rreg-')), 'registry.jsonl');
const sign = (o: Record<string, unknown>) => signLog({ ...(o.genesis ? { registry: REGISTRY } : {}), ...o } as unknown as Parameters<typeof signLog>[0]);

function keys(): { pub: KeyObject; signer: ReceiptSigner } {
  const k = generateKeyPairSync('ed25519');
  return { pub: k.publicKey, signer: keySigner(k.privateKey) };
}

/** A log: a decision that merged (events 2-3), one held for the owner (event 4) that then failed (event 5). */
function fixtureLog(): { dir: string; path: string; log: EventLog } {
  const dir = mkdtempSync(join(tmpdir(), 're9-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: sha('a'), auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: sha('a'), sha: sha('c'), url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['touches the merge policy'] }, 'inst');
  log.append('merge.failed', { issue: 8, number: 42, head: sha('b'), why: 'GitHub refused the merge' }, 'inst');
  return { dir, path, log };
}

const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'rn9-')), name);

/** The coordinator, which owns the log's database file: drops the append-only trigger and flips the held decision. */
function editHeldDecision(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.prepare("UPDATE events SET payload = ? WHERE type = 'merge.decided' AND json_extract(payload, '$.number') = 42").run(JSON.stringify({ issue: 8, number: 42, head: sha('b'), auto: true, reasons: [] }));
  } finally {
    db.close();
  }
}

for (const route of ['E1: receipts deleted, held decision edited', 'E2: log edited, receipts intact']) {
  test(`after a chain ends (${route}), the new chain never signs again what the ended chain covered`, () => {
    const f = fixtureLog();
    const k1 = keys();
    const out = join(f.dir, 'receipts.jsonl');
    const state = fresh('chain-state.json');
    sign({ log: f.path, out, state, genesis: true, signer: k1.signer });
    const published = readFileSync(out, 'utf8');
    if (route.startsWith('E1')) unlinkSync(out);
    editHeldDecision(f.path);
    f.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
    assert.throws(() => sign({ log: f.path, out, state, signer: k1.signer }), /log changed|missing or empty/);
    // The chain ended. A new key, a new --state and --out, the old files kept: a successor of the ended chain.
    const k2 = keys();
    const out2 = fresh('receipts.jsonl');
    sign({ log: f.path, out: out2, state: fresh('chain-state.json'), genesis: true, after: state, signer: k2.signer });
    const envs = readReceiptFiles(out2) as Envelope[];
    assert.ok(verifyChain(envs, { keys: [k2.pub] }).ok);
    const signed = envs.map((e) => statementOf(e) as { kind: string; event?: number }).filter((s) => s.kind !== 'chain.started');
    assert.deepEqual(signed.map((s) => s.event), [6], 'only the event after the ended chain (6); never 2-5, the edited 4 included');
    if (route.startsWith('E2')) assert.equal(readFileSync(out, 'utf8'), published, 'the ended chain stays the record up to its head');
    assert.ok(existsSync(state), 'the ended chain keeps its state');
  });
}
