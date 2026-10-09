import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLAIM_ABANDONED_MS, tryLock } from '../src/locks.js';
import { repoRoot } from './helpers.js';

test('regression: twelve processes racing for one lock, including over a stale one, leave exactly one holder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockrace-'));
  const lockPath = join(dir, 'x.lock');
  // A stale lock from a dead process: everyone will try to take it over at once.
  writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, owner: 'dead', acquiredAt: 'then' }));
  const locks = join(repoRoot, 'dist', 'src', 'locks.js');
  const child = (k: number) =>
    new Promise<string>((res) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', `const { tryLock } = await import(${JSON.stringify(pathToFileURL(locks).href)}); const r = tryLock(${JSON.stringify(lockPath)}, 'p${k}'); console.log('lock' in r ? 'got' : 'busy'); setTimeout(() => {}, 3000);`]);
      let out = '';
      p.stdout.on('data', (d) => {
        out += String(d);
        if (out.includes('\n')) res(out.trim());
      });
      p.on('exit', () => res(out.trim()));
    });
  const results = await Promise.all(Array.from({ length: 12 }, (_, k) => child(k)));
  assert.equal(results.filter((r) => r === 'got').length, 1, results.join(','));
});

test('regression: a takeover never removes a lock it did not inspect (five-step interleaving)', () => {
  // 1. A dead process left a stale lock. 2. B reads it and judges it stale. 3. A takes it over and holds a fresh
  // lock. 4. B, acting on what it read, does its takeover step. 5. C tries in the middle of B's takeover.
  // Exactly one of A, B, C may come away holding the lock, and it must be the one recorded in the file.
  const lockPath = join(mkdtempSync(join(tmpdir(), 'lockstep-')), 'x.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, owner: 'dead', acquiredAt: 'then' }));
  let a: ReturnType<typeof tryLock> | undefined;
  let c: ReturnType<typeof tryLock> | undefined;
  const b = tryLock(lockPath, 'B', {
    inspected: () => {
      a ??= tryLock(lockPath, 'A');
    },
    taking: () => {
      c ??= tryLock(lockPath, 'C');
    },
  });
  c ??= tryLock(lockPath, 'C');
  const results = { A: a!, B: b, C: c };
  const holders = Object.entries(results).filter(([, r]) => 'lock' in r).map(([k]) => k);
  assert.deepEqual(holders.length, 1, `holders: ${holders.join(', ')}`);
  assert.equal((JSON.parse(readFileSync(lockPath, 'utf8')) as { owner: string }).owner, holders[0], 'the lock on disk is the holder\'s');
});

test('a takeover claim left by a crashed or stalled taker is cleared; a live, recent one is respected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockclaim-'));
  const lockPath = join(dir, 'x.lock');
  const stale = JSON.stringify({ pid: 2147483646, owner: 'dead', acquiredAt: 'then' });
  const claimPath = `${lockPath}.${createHash('sha256').update(stale).digest('hex').slice(0, 16)}.claim`;
  const attempt = (claim: object) => {
    writeFileSync(lockPath, stale);
    writeFileSync(claimPath, JSON.stringify(claim));
    // acquireLock polls tryLock; two tries model that: the first clears an abandoned claim, the second takes the lock.
    const first = tryLock(lockPath, 'me');
    return 'lock' in first ? first : tryLock(lockPath, 'me');
  };
  const got = (r: ReturnType<typeof tryLock>) => {
    const ok = 'lock' in r;
    if (ok) r.lock.release();
    return ok;
  };
  assert.equal(got(attempt({ pid: 2147483646, at: Date.now() })), true, 'its taker is dead');
  assert.equal(got(attempt({ pid: process.pid, at: Date.now() - CLAIM_ABANDONED_MS - 1000 })), true, 'its taker stalled past the limit');
  assert.equal(got(attempt({ pid: process.pid, at: Date.now() })), false, 'a live taker is mid-takeover: leave it');
});
