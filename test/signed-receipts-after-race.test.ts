// Signed receipts, #918 round 12: a successor started while the chain it succeeds is signing never signs the same
// events. Round 11 read the ended chain's state without its lock and took the lock only to write the ended mark, after
// the successor's receipts were computed. A `sign` of the ended chain that ran in between signed events the successor
// also signed, and both chains verified (the round-11 delta check's race.mjs, "Race C", measured). Now `--after
// <state>` holds the ended chain's lock from its read through the mark. This is that race, as two real processes.
// Fixture logs and keys made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-11 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { keySigner, statementOf, verifyChain, type Envelope } from '../src/signed-receipts.js';
import { readReceiptFiles, rotateFile, signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r12r-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
type St = { kind: string; event?: unknown; previous?: { head: string } | null };
const statements = (out: string) => (readReceiptFiles(out) as Envelope[]).map((e) => statementOf(e) as St);
const events = (out: string) => statements(out).filter((s) => s.kind !== 'chain.started').map((s) => String(s.event));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A key as a PEM file (0600) for the child process, and its signer here. */
function keyFile(): { path: string; signer: ReturnType<typeof keySigner>; pub: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const k = generateKeyPairSync('ed25519');
  const path = fresh('k.pem');
  writeFileSync(path, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { path, signer: keySigner(k.privateKey), pub: k.publicKey };
}

/** One `sign` in a process of its own: what it returned, or the refusal. */
function signInChild(o: Record<string, unknown>): Promise<{ ok: boolean; err?: string }> {
  const store = new URL('../src/signed-receipts-store.js', import.meta.url).href;
  const code = `const ST = await import(${JSON.stringify(store)});
const o = JSON.parse(process.argv[1]);
try { ST.signLog({ ...o, signer: ST.loadSigner(o.key) }); console.log(JSON.stringify({ ok: true })); }
catch (e) { console.log(JSON.stringify({ ok: false, err: String(e && e.message).slice(0, 300) })); }`;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(o)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let errors = '';
    c.stdout.on('data', (d: Buffer) => (text += d.toString()));
    c.stderr.on('data', (d: Buffer) => (errors += d.toString()));
    c.on('close', () => {
      try {
        resolve(JSON.parse(text.trim().split('\n').at(-1)!) as { ok: boolean; err?: string });
      } catch {
        resolve({ ok: false, err: `unparsed: ${(text + errors).slice(0, 300)}` });
      }
    });
  });
}

test('a successor started while the ended chain signs never signs the same events (Race C)', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r12r-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: sha('a'), auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: sha('a'), sha: sha('c'), url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  const registry = fresh('registry.jsonl');
  const k1 = keyFile();
  const A = { out: join(dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: path, ...A, genesis: true, registry, signer: k1.signer });
  // Twelve decisions that take a while to sign (the redactor's work), so the two runs overlap.
  const heavy = '-----BEGIN PRIVATE KEY-----'.repeat(600).slice(0, 16_000);
  for (let n = 0; n < 12; n++) log.append('merge.decided', { issue: 100 + n, number: 100 + n, head: sha('d'), auto: false, reasons: Array<string>(64).fill(heavy) }, 'inst');
  log.close();
  // A's own sign, in another process; the successor starts once A holds its lock.
  const running = signInChild({ log: path, ...A, key: k1.path });
  const lock = join(dirname(A.state), '.receipts-signer.lock');
  for (let i = 0; i < 2000 && !existsSync(lock); i++) await sleep(5);
  const k2 = keyFile();
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  let started = true;
  try {
    sign({ log: path, ...B, genesis: true, after: A.state, registry, signer: k2.signer });
  } catch {
    started = false;
  }
  const a = await running;
  assert.ok(a.ok, `A's own sign: ${a.err}`);
  if (!started) {
    // Refused while A signed: started again now, it succeeds A at A's new head.
    sign({ log: path, ...B, genesis: true, after: A.state, registry, signer: k2.signer });
  }
  const both = events(A.out).filter((e) => events(B.out).includes(e));
  assert.deepEqual(both, [], 'an event receipted by both chains');
  const finalA = JSON.parse(readFileSync(A.state, 'utf8')) as { head: string };
  assert.equal(statements(B.out)[0]!.previous?.head, finalA.head, "the successor names the ended chain's last head");
  assert.ok(verifyChain(readReceiptFiles(A.out), { keys: [k1.pub] }).ok);
  assert.ok(verifyChain(readReceiptFiles(B.out), { keys: [k2.pub] }).ok);
});

test('while a successor starts, the chain it succeeds never moves its head (the successor holds its lock)', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r12r-log-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: sha('a'), auto: true, reasons: [] }, 'inst');
  const registry = fresh('registry.jsonl');
  const k1 = keyFile();
  const A = { out: join(dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  sign({ log: path, ...A, genesis: true, registry, signer: k1.signer });
  // Decisions the successor takes a while to sign, so A acts while it runs.
  const heavy = '-----BEGIN PRIVATE KEY-----'.repeat(600).slice(0, 16_000);
  for (let n = 0; n < 12; n++) log.append('merge.decided', { issue: 100 + n, number: 100 + n, head: sha('d'), auto: false, reasons: Array<string>(64).fill(heavy) }, 'inst');
  log.close();
  const k2 = keyFile();
  const B = { out: fresh('receipts.jsonl'), state: fresh('chain-state.json') };
  const running = signInChild({ log: path, ...B, genesis: true, after: A.state, registry, key: k2.path });
  // The successor takes A's lock before it reads A's state; round 11 took it only to write the mark, at the end.
  const lock = join(dirname(A.state), '.receipts-signer.lock');
  for (let i = 0; i < 200 && !existsSync(lock); i++) await sleep(5);
  // A rotates meanwhile (its head moves): refused while the successor holds A's lock.
  let rotated = true;
  try {
    rotateFile({ out: A.out, state: A.state, signer: k1.signer, next: generateKeyPairSync('ed25519').publicKey });
  } catch {
    rotated = false;
  }
  const b = await running;
  assert.ok(b.ok, `the successor: ${b.err}`);
  const finalA = JSON.parse(readFileSync(A.state, 'utf8')) as { head: string };
  assert.equal(statements(B.out)[0]!.previous?.head, finalA.head, `the successor names a head A has moved on from (A rotated: ${rotated})`);
});
