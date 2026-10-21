// Signed receipts, #918 rounds 8 and 9: the signer never writes a state it couldn't read back. A rotation whose state
// would be over the 64 MiB read cap, while the receipts it writes stay under it, is refused with nothing written (the
// round-8 delta check's cap.mjs, rewritten as a test: on round 7's code the state was written, and the next sign
// refused it). The chain is built close to the cap with receipts whose fields all stay within their bounds (round 9
// cuts longer ones), then tuned to the byte. Fixture logs and keys made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against older code (the fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { keySigner } from '../src/signed-receipts.js';
import { RECEIPTS_MAX_BYTES, rotateFile, signLog } from '../src/signed-receipts-store.js';

const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const rotate = (o: Record<string, unknown>) => rotateFile(o as unknown as Parameters<typeof rotateFile>[0]);
const size = (p: string) => statSync(p).size;
const digest = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const HEAD = 'a'.repeat(40);

/** A decision whose receipt is large but within every bound: 64 reasons and 64 why entries of 1,000 characters. */
const BIG = {
  issue: 8,
  number: 42,
  head: HEAD,
  auto: false,
  reasons: Array.from({ length: 64 }, (_, i) => `r${i}`.padEnd(1000, 'x')),
  why: Array.from({ length: 64 }, (_, i) => ({ category: `c${i}`.padEnd(1000, 'y'), text: `t${i}`.padEnd(1000, 'z') })),
};
/** A decision to tune the size with: `c` reasons of 1,000 characters and one of `m` (each within the bounds). */
const tune = (c: number, m: number) => ({ issue: 8, number: 42, head: HEAD, auto: false, reasons: [...Array.from({ length: c }, (_, i) => `u${i}`.padEnd(1000, 'u')), 'v'.repeat(m)] });

function chain(): { log: EventLog; path: string; out: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rcap-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  return { log, path, out: join(dir, 'receipts.jsonl'), state: join(mkdtempSync(join(tmpdir(), 'rcaps-')), 'chain-state.json') };
}

test('a rotation whose state would be over the read cap is refused, with nothing written', { timeout: 600_000 }, () => {
  const a = generateKeyPairSync('ed25519');
  const b = generateKeyPairSync('ed25519');
  const sa = keySigner(a.privateKey);
  // Calibration, on a small chain: the size of a big receipt, of a tuning receipt, and what a rotation adds.
  const small = chain();
  small.log.append('merge.decided', tune(0, 0), 'inst');
  sign({ log: small.path, out: small.out, state: small.state, genesis: true, signer: sa });
  const s0 = size(small.out);
  small.log.append('merge.decided', tune(0, 0), 'inst');
  sign({ log: small.path, out: small.out, state: small.state, signer: sa });
  const tail0 = size(small.out) - s0;
  small.log.append('merge.decided', tune(1, 0), 'inst');
  sign({ log: small.path, out: small.out, state: small.state, signer: sa });
  const perReason = size(small.out) - s0 - 2 * tail0;
  small.log.append('merge.decided', BIG, 'inst');
  const s3 = size(small.out);
  sign({ log: small.path, out: small.out, state: small.state, signer: sa });
  const big = size(small.out) - s3;
  const r = size(small.out);
  rotate({ out: small.out, state: small.state, signer: sa, next: b.publicKey });
  const rot = size(small.out) - r;
  const over = size(small.state) - size(small.out);
  assert.ok(over > 16, `the state is ${over} bytes over the receipts: too close to aim between`);
  // The receipts after the rotation stay within the cap; the state then would not.
  const target = RECEIPTS_MAX_BYTES - rot - Math.floor(over / 2);
  // The big chain: big receipts up to near the target, then one tuning receipt to the byte.
  const c = chain();
  const n = Math.floor((target - s0 - tail0 - 64 * perReason) / big);
  for (let i = 0; i < n; i++) c.log.append('merge.decided', BIG, 'inst');
  sign({ log: c.path, out: c.out, state: c.state, genesis: true, signer: sa });
  // Full tuning receipts (63 reasons of 1,000 characters and one more) until one partial one is left to the target.
  const full = tail0 + 63 * perReason + Math.ceil((1000 * 4) / 3);
  const fulls = Math.max(0, Math.floor((target - size(c.out) - tail0) / full));
  for (let i = 0; i < fulls; i++) c.log.append('merge.decided', tune(63, 1000), 'inst');
  if (fulls) sign({ log: c.path, out: c.out, state: c.state, signer: sa });
  // One partial tuning receipt that leaves room for a last small one, then the last one to the byte (measured each time,
  // so the estimates' error is only the last step's).
  const room = tail0 + 650;
  let rest = target - size(c.out) - tail0 - room;
  const reasons = Math.min(63, Math.max(0, Math.floor(rest / perReason)));
  rest -= reasons * perReason;
  c.log.append('merge.decided', tune(reasons, Math.max(0, Math.min(1000, Math.round((rest * 3) / 4)))), 'inst');
  sign({ log: c.path, out: c.out, state: c.state, signer: sa });
  const last = target - size(c.out) - tail0;
  c.log.append('merge.decided', tune(0, Math.max(0, Math.min(1000, Math.round((last * 3) / 4)))), 'inst');
  sign({ log: c.path, out: c.out, state: c.state, signer: sa });
  const receipts = size(c.out);
  assert.ok(receipts + rot <= RECEIPTS_MAX_BYTES && receipts + rot + over > RECEIPTS_MAX_BYTES, `tuned to ${receipts} receipts bytes; rotation adds ${rot}, the state ${over} more; cap ${RECEIPTS_MAX_BYTES}`);
  const before = [digest(c.out), digest(c.state)];
  assert.throws(() => rotate({ out: c.out, state: c.state, signer: sa, next: b.publicKey }), /over/);
  assert.deepEqual([digest(c.out), digest(c.state)], before, 'nothing was written');
});
