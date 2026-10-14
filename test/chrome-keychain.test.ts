import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CHROME_NO_KEYCHAIN_ARGS, launchChrome } from '../src/browser/cdp.js';
import { repoRoot } from './helpers.js';

// On macOS a headless Chrome that may use the OS keychain pops up "A keychain cannot be found to store Chrome".

test('launchChrome starts Chrome with a mock keychain and a basic password store', { skip: process.platform === 'win32' && 'the stand-in browser is a shell script' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-keychain-'));
  const stub = join(dir, 'chrome');
  // A stand-in that writes down its arguments and fails to start.
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\nexit 1\n`);
  chmodSync(stub, 0o755);
  await assert.rejects(launchChrome(stub, { launchMs: 5_000 }), /exited \(1\) before it opened DevTools/);
  const args = readFileSync(join(dir, 'args'), 'utf8').split('\n');
  for (const a of ['--use-mock-keychain', '--password-store=basic']) assert.ok(args.includes(a), `Chrome started without ${a}: ${args.join(' ')}`);
  assert.deepEqual([...CHROME_NO_KEYCHAIN_ARGS], ['--use-mock-keychain', '--password-store=basic']);
});

test('every place that starts Chrome itself keeps it off the OS keychain', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs|js|sh)$/.test(n)) files.push(p);
    }
  };
  for (const d of ['src', 'scripts', 'test', 'web/src', 'desktop']) {
    try {
      walk(join(repoRoot, d));
    } catch {
      // not in this checkout
    }
  }
  const self = join(repoRoot, 'test', 'chrome-keychain.test.ts');
  const bad = files
    .filter((f) => f !== self && !f.endsWith('chrome-keychain.test.js'))
    .filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /['"`]--headless/.test(s) && !(s.includes('--use-mock-keychain') && s.includes('--password-store=basic')) && !s.includes('...CHROME_NO_KEYCHAIN_ARGS');
    })
    .map((f) => relative(repoRoot, f));
  assert.deepEqual(bad, [], `these start Chrome without --use-mock-keychain --password-store=basic (use launchChrome, or CHROME_NO_KEYCHAIN_ARGS): ${bad.join(', ')}`);
});
