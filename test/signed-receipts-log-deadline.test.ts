// Signed receipts, #918 round 16: the log reader's deadline is never "none". The log child is started with
// spawnSync's `timeout`, which reads 0 as no timeout at all: round 15's `logDeadlineMs: 0` read a log with a FIFO
// beside it until something outside killed it (the round-15 second review, row 5 and advisory A1, measured). Now any
// deadline that isn't a positive whole number of milliseconds is refused before anything is read or written. Fixture
// logs and keys made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-15 code (the
// fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { keySigner } from '../src/signed-receipts.js';
import { signLog } from '../src/signed-receipts-store.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const fresh = (name: string) => join(mkdtempSync(join(tmpdir(), 'r16d-')), name);
const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const bytes = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

test('a log deadline of 0, negative, fractional, NaN or Infinity is refused, and nothing is read or written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r16d-log-'));
  const log = join(dir, 'events.db');
  const l = new EventLog(log);
  l.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  l.append('merge.decided', { issue: 8, number: 42, head: sha('b'), auto: false, reasons: ['held'] }, 'inst');
  l.close();
  const signer = keySigner(generateKeyPairSync('ed25519').privateKey);
  const registry = fresh('registry.jsonl');
  const A = { out: join(dir, 'receipts.jsonl'), state: fresh('chain-state.json') };
  for (const ms of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => sign({ log, ...A, genesis: true, registry, signer, logDeadlineMs: ms }), /deadline/, `logDeadlineMs ${ms}`);
    assert.ok(!existsSync(A.out) && !existsSync(A.state) && !existsSync(registry), `logDeadlineMs ${ms}: something was written`);
  }
  // A positive deadline reads and signs.
  sign({ log, ...A, genesis: true, registry, signer, logDeadlineMs: 60_000 });
  assert.ok(bytes(A.out));
});
