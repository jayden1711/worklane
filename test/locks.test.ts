import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
