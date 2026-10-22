// Signed receipts, #918 round 7: every recovery is a give-back, never a second chain. The signer's state keeps the
// receipts its current key can't make again (the start, and everything through the latest rotation), so a missing,
// emptied or short receipts file, after a genesis, a rotation or a failed write, is given back byte for byte from the
// state and the log, or refused when the log changed (round-6 review, finding 1: the documented recovery for a failed
// genesis, "delete the state", let the same key sign a second chain over an edited log). Fixture logs, keys and
// directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-6 code (the fail-without
// run). A failed write is forced by wrapping node:fs's renameSync for one call (syncBuiltinESMExports).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { canonicalJson, keySigner, statementOf, verifyChain, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, rotateFile, signLog } from '../src/signed-receipts-store.js';

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const sha = (c: string) => c.repeat(40).slice(0, 40);
const H1 = sha('a');
const H2 = sha('b');
const M1 = sha('c');

/** The signer's chain registry for each log (round 12: a registry holds one first chain, for one log), unless a test gives its own. */
const registries = new Map<unknown, string>();
const registryFor = (log: unknown) => registries.get(log) ?? registries.set(log, join(mkdtempSync(join(tmpdir(), 'rreg-')), 'registry.jsonl')).get(log)!;
const sign = (o: Record<string, unknown>) => signLog({ ...(o.genesis ? { registry: registryFor(o.log) } : {}), ...o } as unknown as Parameters<typeof signLog>[0]);
const rotate = (o: Record<string, unknown>) => rotateFile(o as unknown as Parameters<typeof rotateFile>[0]);
const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

function keys(): { pub: KeyObject; signer: ReceiptSigner } {
  const k = generateKeyPairSync('ed25519');
  return { pub: k.publicKey, signer: keySigner(k.privateKey) };
}

/** A log with one decision that merged; `held` adds a decision held for the owner and its failed merge. */
function fixtureLog(): { dir: string; path: string; held: () => void; more: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'r7-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: H1, auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: H1, sha: M1, url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  const held = () => {
    log.append('merge.decided', { issue: 8, number: 42, head: H2, auto: false, reasons: ['touches the merge policy'] }, 'inst');
    log.append('merge.failed', { issue: 8, number: 42, head: H2, why: 'GitHub refused the merge' }, 'inst');
  };
  const more = () => log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  return { dir, path, held, more };
}

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'rs7-')), 'chain-state.json');

/** Whoever owns the log's database file: drops the append-only trigger and flips the held decision to auto. */
function editHeldDecision(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.prepare("UPDATE events SET payload = ? WHERE type = 'merge.decided' AND json_extract(payload, '$.number') = 42").run(JSON.stringify({ issue: 8, number: 42, head: H2, auto: true, reasons: [] }));
  } finally {
    db.close();
  }
}

/** Run `fn` with the write that publishes `out` failing once, as a crash or a full disk would. */
function outWriteFails(out: string, fn: () => void): void {
  const real = fs.renameSync;
  let failed = false;
  fs.renameSync = ((from: string, to: string) => {
    if (to === out && !failed) {
      failed = true;
      throw Object.assign(new Error('simulated failure of the receipts write'), { code: 'EIO' });
    }
    real(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
}

const kinds = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => (statementOf(e) as { kind: string }).kind);

test('after a genesis, receipts deleted or emptied with the log unchanged: given back byte for byte', () => {
  for (const gone of ['deleted', 'emptied']) {
    const f = fixtureLog();
    const k = keys();
    const out = join(f.dir, 'receipts.jsonl');
    const state = stateFile();
    sign({ log: f.path, out, state, genesis: true, signer: k.signer });
    const published = readFileSync(out, 'utf8');
    if (gone === 'deleted') unlinkSync(out);
    else writeFileSync(out, '');
    sign({ log: f.path, out, state, signer: k.signer });
    assert.equal(text(out), published, `${gone}: not given back byte for byte`);
  }
});

test('after a genesis, receipts deleted and the log edited: refused, nothing written, and no second chain (pin)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  f.held();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  const stateBefore = readFileSync(state, 'utf8');
  unlinkSync(out);
  editHeldDecision(f.path);
  assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /missing or empty/);
  assert.throws(() => sign({ log: f.path, out, state, genesis: true, signer: k.signer }), /already has a chain/);
  assert.ok(!existsSync(out), 'nothing was written');
  assert.equal(readFileSync(state, 'utf8'), stateBefore);
});

test('a genesis whose receipts write failed: the next sign gives the receipts back', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  outWriteFails(out, () => assert.throws(() => sign({ log: f.path, out, state, genesis: true, signer: k.signer }), /simulated failure/));
  assert.ok(!existsSync(out));
  sign({ log: f.path, out, state, signer: k.signer });
  const r = verifyChain(readReceiptFiles(out), { keys: [k.pub] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).head, r.head, 'the very chain the state names');
});

test('after a rotation, receipts deleted: given back byte for byte with the log unchanged, refused when it changed', () => {
  for (const edited of [false, true]) {
    const f = fixtureLog();
    const a = keys();
    const b = keys();
    const out = join(f.dir, 'receipts.jsonl');
    const state = stateFile();
    f.held();
    sign({ log: f.path, out, state, genesis: true, signer: a.signer });
    rotate({ out, state, signer: a.signer, next: b.pub });
    const published = readFileSync(out, 'utf8');
    unlinkSync(out);
    if (edited) {
      editHeldDecision(f.path);
      const stateBefore = readFileSync(state, 'utf8');
      assert.throws(() => sign({ log: f.path, out, state, signer: b.signer }));
      assert.ok(!existsSync(out), 'nothing was written');
      assert.equal(readFileSync(state, 'utf8'), stateBefore);
    } else {
      sign({ log: f.path, out, state, signer: b.signer });
      assert.equal(text(out), published, 'not given back byte for byte');
    }
  }
});

test('a rotation whose receipts write failed: the new key gives it back, the old key never rotates again (no fork)', () => {
  const f = fixtureLog();
  const a = keys();
  const b = keys();
  const c = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: a.signer });
  outWriteFails(out, () => assert.throws(() => rotate({ out, state, signer: a.signer, next: b.pub }), /simulated failure/));
  f.more();
  sign({ log: f.path, out, state, signer: b.signer });
  assert.throws(() => rotate({ out, state, signer: a.signer, next: c.pub }), /not the chain's current key/);
  const r = verifyChain(readReceiptFiles(out), { keys: [a.pub] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(kinds(out).filter((x) => x === 'key.rotated').length, 1);
  assert.equal(kinds(out).at(-1), 'merge.decided');
});

test('an unreadable state ends the chain: the refusal never sends the owner to an older copy (round 8: S3, S4)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  writeFileSync(state, '{"schema":"not a state"}\n');
  assert.throws(
    () => sign({ log: f.path, out, state, signer: k.signer }),
    (e: Error) => /chain ends here/.test(e.message) && /never restored/.test(e.message) && /new key/.test(e.message) && !/from a backup/.test(e.message),
  );
  assert.throws(() => sign({ log: f.path, out, state, genesis: true, signer: k.signer }));
});

test('a receipts file that is not valid UTF-8 is refused, compared as bytes', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  sign({ log: f.path, out, state: stateFile(), genesis: true, signer: k.signer });
  const lines = (readReceiptFiles(out) as Envelope[]).map((e) => canonicalJson(e));
  const at = lines[1]!.indexOf('"keyid":"') + 9;
  const bad = Buffer.concat([Buffer.from(lines.slice(0, 1).join('\n') + '\n' + lines[1]!.slice(0, at), 'utf8'), Buffer.from([0xff]), Buffer.from(lines[1]!.slice(at) + '\n' + lines.slice(2).join('\n') + '\n', 'utf8')]);
  const file = join(mkdtempSync(join(tmpdir(), 'ru7-')), 'r.jsonl');
  writeFileSync(file, bad);
  assert.throws(() => readReceiptFiles(file), /UTF-8/);
});
