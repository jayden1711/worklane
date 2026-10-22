// Signed receipts, #918 round 15: the signer never opens the event log itself; a child process reads it, under a
// deadline and a heap limit. Round 14 opened it in the signer: a FIFO at `<log>-journal`, or at the log, blocked
// SQLite's open for good while `sign` held the signer's lock, and every later `sign` was refused until someone killed
// it (the round-14 second review, rows 1, 1b and 2, measured); one 64 MiB merge payload of flat `[[],…]` ran a
// 512 MB signer out of heap (the round-14 final check, 3d). Each `sign` here runs in a process of its own, killed after
// 60 s, so the old code's hang fails the test instead of hanging it. Fixture logs and keys made here, in temp dirs; no
// network, no real state; `mkfifo` makes the FIFOs.
//
// The calls take their options as plain objects, so this file also builds against the round-14 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { statementOf, type Envelope } from '../src/signed-receipts.js';
import { readReceiptFiles } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r15c-')), name);
const TS = '2026-10-21T00:00:00.000Z';
const bytes = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/** signLog in a process of its own (heap `heapMb`), killed after 60 s: its answer, or why it gave none. */
function sign(o: Record<string, unknown>, heapMb?: number): { ok: boolean; err: string; ms: number } {
  const store = new URL('../src/signed-receipts-store.js', import.meta.url).href;
  const code = `const ST = await import(${JSON.stringify(store)});
const o = JSON.parse(process.argv[1]);
try { ST.signLog({ ...o, signer: ST.loadSigner(o.key) }); console.log(JSON.stringify({ ok: true })); }
catch (e) { console.log(JSON.stringify({ ok: false, err: String(e && e.message) })); }`;
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [...(heapMb ? [`--max-old-space-size=${heapMb}`] : []), '--input-type=module', '-e', code, JSON.stringify(o)], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const ms = performance.now() - t0;
  try {
    const a = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { ok: boolean; err?: string };
    return { ok: a.ok, err: a.err ?? '', ms };
  } catch {
    return { ok: false, err: `no answer (status ${r.status}, signal ${r.signal}): ${r.stderr.slice(-300)}`, ms };
  }
}

function keyFile(): string {
  const path = fresh('k.pem');
  writeFileSync(path, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return path;
}
function insert(path: string, type: string, payload: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(TS, type, 'inst', 'inst', payload);
  } finally {
    db.close();
  }
}
const decision = (n: number) => JSON.stringify({ issue: n, number: n, head: sha('d'), auto: true, reasons: [] });

/** A chain started over a log with one decision: its files, and its key. */
function started(): { dir: string; log: string; out: string; state: string; registry: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'r15c-log-'));
  const log = join(dir, 'events.db');
  const l = new EventLog(log);
  l.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  l.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['held'] }, 'inst');
  l.close();
  const c = { dir, log, out: join(dir, 'receipts.jsonl'), state: fresh('chain-state.json'), registry: fresh('registry.jsonl'), key: keyFile() };
  const r = sign({ log: c.log, out: c.out, state: c.state, registry: c.registry, genesis: true, key: c.key });
  assert.ok(r.ok, r.err);
  return c;
}
const snapshot = (c: { out: string; state: string; registry: string }) => [bytes(c.out), bytes(c.state), bytes(c.registry)];

for (const where of ['<log>-journal', '--log'] as const) {
  test(`a FIFO at ${where} ends the read at its deadline, writes nothing and keeps no lock; once gone, sign signs`, { timeout: 300_000 }, () => {
    const c = started();
    insert(c.log, 'merge.decided', decision(70));
    const before = snapshot(c);
    const fifo = where === '--log' ? c.log : `${c.log}-journal`;
    const away = `${c.log}.away`;
    if (where === '--log') renameSync(c.log, away);
    execFileSync('mkfifo', [fifo]);
    const r = sign({ log: c.log, out: c.out, state: c.state, key: c.key, logDeadlineMs: 3_000 });
    assert.ok(!r.ok, 'signed through a FIFO');
    assert.match(r.err, /took over|deadline/, r.err);
    assert.ok(r.ms < 30_000, `it took ${Math.round(r.ms)} ms`);
    assert.deepEqual(snapshot(c), before, 'something was written');
    unlinkSync(fifo);
    if (where === '--log') renameSync(away, c.log);
    const again = sign({ log: c.log, out: c.out, state: c.state, key: c.key, logDeadlineMs: 3_000 });
    assert.ok(again.ok, again.err);
    assert.equal((statementOf((readReceiptFiles(c.out) as Envelope[]).at(-1)!) as { inputs?: { pr: number } }).inputs?.pr, 70);
  });
}

test('a FIFO beside the log stops a successor at its deadline: the ended chain stays unmarked, and it starts once the FIFO is gone', { timeout: 300_000 }, () => {
  const c = started();
  const db = new DatabaseSync(c.log);
  db.exec('DROP TRIGGER IF EXISTS events_no_update');
  db.prepare('UPDATE events SET payload = ? WHERE id = 2').run(JSON.stringify({ issue: 8, number: 42, head: sha('b'), auto: true, reasons: [] }));
  db.close();
  assert.match(sign({ log: c.log, out: c.out, state: c.state, key: c.key }).err, /log changed/);
  const fifo = `${c.log}-journal`;
  execFileSync('mkfifo', [fifo]);
  const before = snapshot(c);
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  const r = sign({ log: c.log, ...B, genesis: true, after: c.state, registry: c.registry, key: keyFile(), logDeadlineMs: 3_000 });
  assert.ok(!r.ok && /took over|deadline/.test(r.err), r.err);
  assert.deepEqual(snapshot(c), before, 'the ended chain or the registry changed');
  assert.ok(!existsSync(B.out) && !existsSync(B.state));
  unlinkSync(fifo);
  const again = sign({ log: c.log, ...B, genesis: true, after: c.state, registry: c.registry, key: keyFile(), logDeadlineMs: 3_000 });
  assert.ok(again.ok, again.err);
});

test('one 64 MiB merge payload of flat [[],…] never runs a small-heap signer out of memory: it is unsignable, and the next decision is signed', { timeout: 300_000 }, () => {
  const c = started();
  const n = Math.floor((64 * 1024 * 1024 - 4) / 3);
  insert(c.log, 'merge.decided', `[${'[],'.repeat(n)}[]]`);
  insert(c.log, 'merge.decided', decision(70));
  const r = sign({ log: c.log, out: c.out, state: c.state, key: c.key }, 128);
  assert.ok(r.ok, r.err);
  const st = (readReceiptFiles(c.out) as Envelope[]).map((e) => statementOf(e) as { kind: string; event?: string; problem?: string; inputs?: { pr: number } });
  assert.equal(st.find((s) => s.event === '3')?.kind, 'event.unsignable');
  assert.equal(st.at(-1)?.inputs?.pr, 70);
});
