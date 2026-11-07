// Signed receipts, #918 round 14: the signer streams the event log and never keeps it. Round 13 read the log row by
// row but kept every row (and every parsed payload) until signing ended: a few large `coordinator.started` events
// (each parsed up to 64 MiB) or a few million small events ran every `sign`, and every successor, out of heap for good
// (the round-13 reviews, measured). Now the running digest is folded as each row is read, a `coordinator.started`
// payload is read only up to 64 KiB, and only receipts, the digests at receipted ids and the decided map are kept.
// Each case runs `sign` in a child process with a small heap. Fixture logs and keys made here, in temp dirs; no
// network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-13 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, type Envelope } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r14m-')), name);
const TS = '2026-10-21T00:00:00.000Z';

/** `sign` in a child process whose heap is `heapMb`: its exit status, and the last of its output. */
function signSmall(o: Record<string, unknown>, heapMb: number): { status: number | null; out: string } {
  const store = new URL('../src/signed-receipts-store.js', import.meta.url).href;
  const code = `const ST = await import(${JSON.stringify(store)});
const o = JSON.parse(process.argv[1]);
ST.signLog({ ...o, signer: ST.loadSigner(o.key) });
console.log('signed');`;
  const r = spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, '--input-type=module', '-e', code, JSON.stringify(o)], { encoding: 'utf8', timeout: 540_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.slice(-600) };
}

/** A chain started over a fresh log (its first event only), the key as a file for the child. */
function started(): { path: string; out: string; state: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'r14m-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.close();
  const k = generateKeyPairSync('ed25519');
  const key = fresh('k.pem');
  writeFileSync(key, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const out = join(dir, 'receipts.jsonl');
  const state = fresh('chain-state.json');
  signLog({ log: path, out, state, genesis: true, registry: fresh('registry.jsonl'), signer: keySigner(k.privateKey) } as unknown as Parameters<typeof signLog>[0]);
  return { path, out, state, key };
}

/** Rows written straight into the log in one transaction, as the coordinator can. */
function append(path: string, rows: Iterable<{ type: string; payload: string }>): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(TS, r.type, 'inst', 'inst', r.payload);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}
const honest = { type: 'merge.decided', payload: JSON.stringify({ issue: 70, number: 70, head: sha('d'), auto: true, reasons: [] }) };
const lastPr = (out: string) => (statementOf((readReceiptFiles(out) as Envelope[]).at(-1)!) as { inputs?: { pr: number } }).inputs?.pr;

test('large coordinator.started events never run sign out of a small heap', { timeout: 600_000 }, () => {
  const c = started();
  // Each payload is a flat JSON list of empty lists (about 20 MiB): parsed whole, it takes many times that in heap.
  const flat = `[${'[],'.repeat(7_000_000)}[]]`;
  append(c.path, [1, 2, 3].map(() => ({ type: 'coordinator.started', payload: flat })));
  append(c.path, [honest]);
  const r = signSmall({ log: c.path, out: c.out, state: c.state, key: c.key }, 128);
  assert.equal(r.status, 0, r.out);
  assert.equal(lastPr(c.out), 70, 'the honest decision after them was receipted');
});

test('many small events never run sign out of a small heap', { timeout: 600_000 }, () => {
  const c = started();
  function* notes() {
    for (let i = 0; i < 400_000; i++) yield { type: 'note', payload: '{}' };
  }
  append(c.path, notes());
  append(c.path, [honest]);
  const r = signSmall({ log: c.path, out: c.out, state: c.state, key: c.key }, 128);
  assert.equal(r.status, 0, r.out);
  assert.equal(lastPr(c.out), 70, 'the honest decision after them was receipted');
});
