// One real Chrome at a time across test files (test/browser-helpers.ts): node --test runs files in parallel
// processes, and headless Chromes started together on a small CI runner starved each other (main went red with
// "timed out after 20000 ms waiting for Chrome to open its DevTools port").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { globSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { takeChromeLock } from './browser-helpers.js';
import { repoRoot } from './helpers.js';

const helpers = pathToFileURL(join(import.meta.dirname, 'browser-helpers.js')).href;

/** A pid no process has: one that just exited. */
const deadPid = () =>
  new Promise<number>((ok) => {
    const c = spawn(process.execPath, ['-e', '']);
    c.on('exit', () => ok(c.pid!));
  });

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
    writeFileSync(lock, String(await deadPid()));
    const release = await takeChromeLock(lock);
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
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
  // 15 on main, plus #414's two (machine cards) and #418's one (web-key-in-url), the dashboard speed test's five, and
  // offline-chrome's two (#462).
  assert.ok(found === 25, `found the real-Chrome tests (${found})`);
  assert.deepEqual(missing, [], 'start with `await oneChromeAtATime(ctx);`');
});

/**
 * Four processes that ask for the lock at the same instant (each spins until an agreed moment), and each holds it a
 * moment: the log of who held it, "+pid" on taking and "-pid" before giving back (O_APPEND: whole lines, in order).
 */
async function race(dir: string, lock: string): Promise<string[]> {
  const log = join(dir, 'log');
  rmSync(log, { force: true });
  const at = Date.now() + 400;
  const code = `import { appendFileSync } from 'node:fs';
const { takeChromeLock } = await import(${JSON.stringify(helpers)});
while (Date.now() < ${at});
const release = await takeChromeLock(${JSON.stringify(lock)});
appendFileSync(${JSON.stringify(log)}, '+' + process.pid + '\\n');
await new Promise((r) => setTimeout(r, 5));
appendFileSync(${JSON.stringify(log)}, '-' + process.pid + '\\n');
release();`;
  await Promise.all([0, 1, 2, 3].map(() => new Promise<void>((ok, fail) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('error', fail);
    c.on('exit', (status) => (status === 0 ? ok() : fail(new Error(`exit ${status}`))));
  })));
  return readFileSync(log, 'utf8').trim().split('\n');
}

test('stress: the four-process race, 50 times (and 10 more from a dead owner\'s lock): no two ever hold the lock together', { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-lock-'));
  try {
    const lock = join(dir, 'lock');
    for (let round = 0; round < 60; round++) {
      // The last 10 start from a lock whose owner has exited: only one of the four may take it over at a time.
      if (round >= 50) writeFileSync(lock, String(await deadPid()));
      const lines = await race(dir, lock);
      assert.equal(lines.length, 8, `round ${round}: each of the four took the lock once: ${lines.join(' ')}`);
      for (let i = 0; i < lines.length; i += 2) {
        assert.ok(lines[i]!.startsWith('+') && lines[i + 1] === `-${lines[i]!.slice(1)}`, `round ${round}: held together: ${lines.join(' ')}`);
      }
      assert.deepEqual(readdirSync(dir), ['log'], `round ${round}: no lock, takeover guard or half-made lock left behind`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock whose owner cannot be read is waited for, never taken over while it is recent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-lock-'));
  try {
    const lock = join(dir, 'lock');
    // What a waiter saw before the fix, in the moment between a lock's making and its pid's writing.
    writeFileSync(lock, '');
    let taken = false;
    const waiting = takeChromeLock(lock).then((r) => ((taken = true), r));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(taken, false, 'an empty lock is not a dead owner');
    rmSync(lock);
    (await waiting)();
    assert.equal(taken, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
