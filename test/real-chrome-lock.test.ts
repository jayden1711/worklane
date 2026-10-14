// One real Chrome at a time across test files (test/browser-helpers.ts): node --test runs files in parallel
// processes, and headless Chromes started together on a small CI runner starved each other (main went red with
// "timed out after 20000 ms waiting for Chrome to open its DevTools port").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { takeChromeLock } from './browser-helpers.js';
import { repoRoot } from './helpers.js';

const helpers = pathToFileURL(join(import.meta.dirname, 'browser-helpers.js')).href;

test('the lock holds across processes: four at once each get it in turn, never two together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-lock-'));
  try {
    const lock = join(dir, 'lock');
    const code = `const { takeChromeLock } = await import(${JSON.stringify(helpers)});
const release = await takeChromeLock(${JSON.stringify(lock)});
const from = Date.now();
await new Promise((r) => setTimeout(r, 300));
console.log(JSON.stringify({ from, to: Date.now() }));
release();`;
    const runs = await Promise.all([0, 1, 2, 3].map(() => new Promise<string>((ok, fail) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('error', fail);
      c.on('exit', (status) => (status === 0 ? ok(out) : fail(new Error(`exit ${status}: ${out}`))));
    })));
    const spans = runs.map((o) => JSON.parse(o) as { from: number; to: number }).sort((a, b) => a.from - b.from);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i]!.from >= spans[i - 1]!.to, `held together: ${JSON.stringify(spans)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a process that has exited is taken over; one a live process holds is waited for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-lock-'));
  try {
    const lock = join(dir, 'lock');
    // A pid no process has: one that just exited.
    const gone = await new Promise<number>((ok) => {
      const c = spawn(process.execPath, ['-e', '']);
      c.on('exit', () => ok(c.pid!));
    });
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(gone));
    const release = await takeChromeLock(lock);
    assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid));
    let second = false;
    const waiting = takeChromeLock(lock).then((r) => ((second = true), r));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(second, false, 'held by a live process: the next one waits');
    release();
    (await waiting)();
    assert.equal(second, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every test that drives a real Chrome takes the lock first', () => {
  const files = globSync('test/**/*.test.ts', { cwd: repoRoot }).map((f) => f.split('\\').join('/'));
  const missing: string[] = [];
  let found = 0;
  for (const f of files) {
    const src = readFileSync(join(repoRoot, f), 'utf8');
    // A test( call whose options name a real Chrome: the real-Chrome timeout, the web-UI skip, or a skip for no Chrome.
    for (const m of src.matchAll(/^test\(([\s\S]*?)(?:async )?\((?:t|ctx)?\) => \{\n/gm)) {
      const head = m[1]!;
      if (!/REAL_CHROME_TIMEOUT|webUiSkip\(chrome\)|!chrome &&/.test(head)) continue;
      found++;
      const next = src.slice(m.index + m[0].length).split('\n', 1)[0]!;
      if (!/^\s*await oneChromeAtATime\((?:t|ctx)\);$/.test(next)) missing.push(`${f}: ${head.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
  }
  assert.ok(found === 16, `found the real-Chrome tests (${found})`);
  assert.deepEqual(missing, [], 'start with `await oneChromeAtATime(ctx);`');
});
