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
import { launchTestChrome, takeChromeLock } from './browser-helpers.js';
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

/** The test( heads in a file (top level or inside a loop) and whether each opens with `await oneChromeAtATime(..)`. */
export function chromeTestHeads(src: string): { head: string; realChrome: boolean; locks: boolean }[] {
  return [...src.matchAll(/^[ \t]*test\(([\s\S]*?)(?:async )?\((?:t|ctx)?\) => \{\n/gm)].map((m) => ({
    head: m[1]!,
    // Options that name a real Chrome: the real-Chrome timeout, the web-UI skip, or a skip for no Chrome.
    realChrome: /REAL_CHROME_TIMEOUT|webUiSkip\(chrome\)|!chrome &&/.test(m[1]!),
    locks: /^\s*await oneChromeAtATime\((?:t|ctx)\);$/.test(src.slice(m.index! + m[0].length).split('\n', 1)[0]!),
  }));
}

// WHY no pinned count: one number every browser-test PR edited forced a main merge and a new CI run on the others.
// What the count guarded, that this scan really sees the tests (a pattern that stops matching passes vacuously), is
// checked per file from two independent readings: every `await oneChromeAtATime(` in a file opens a test head the
// scan found, and every real-Chrome head opens with it. And launchTestChrome refuses at run time without the lock.
test('every test that drives a real Chrome takes the lock first, and the scan sees every test that takes it', () => {
  const files = globSync('test/**/*.test.ts', { cwd: repoRoot }).map((f) => f.split('\\').join('/')).filter((f) => !f.endsWith('/real-chrome-lock.test.ts'));
  const missing: string[] = [];
  const unseen: string[] = [];
  let found = 0;
  for (const f of files) {
    const src = readFileSync(join(repoRoot, f), 'utf8');
    const heads = chromeTestHeads(src);
    for (const h of heads.filter((x) => x.realChrome)) {
      found++;
      if (!h.locks) missing.push(`${f}: ${h.head.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
    const calls = (src.match(/await oneChromeAtATime\(/g) ?? []).length;
    const seen = heads.filter((x) => x.locks).length;
    if (calls !== seen) unseen.push(`${f}: ${calls} lock call(s), ${seen} opening a test the scan found`);
  }
  assert.ok(found > 0, 'the scan found no real-Chrome test at all');
  assert.deepEqual(unseen, [], 'a lock call outside any test head the scan recognises: the scan no longer sees that test');
  assert.deepEqual(missing, [], 'start with `await oneChromeAtATime(ctx);`');
});

test('the scan: top-level and looped tests, the markers, and a lock call it can\'t place', () => {
  const src = [
    "test('a', { timeout: REAL_CHROME_TIMEOUT }, async (ctx) => {",
    '  await oneChromeAtATime(ctx);',
    '});',
    "for (const x of xs) {",
    "  test(`b ${x}`, { skip: webUiSkip(chrome) }, async (t) => {",
    '    await oneChromeAtATime(t);',
    '  });',
    '}',
    "test('c', () => {",
    '  assert.ok(true);',
    '});',
    "test('d', { skip: !chrome && 'no Chrome' }, async () => {",
    '  await go();',
    '});',
    '',
  ].join('\n');
  assert.deepEqual(chromeTestHeads(src).map((h) => [h.realChrome, h.locks]), [[true, true], [true, true], [false, false], [true, false]]);
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

test('launchTestChrome refuses to start a Chrome without the real-Chrome lock, before starting anything', async () => {
  await assert.rejects(launchTestChrome('/nonexistent/chrome'), /launchTestChrome without the real-Chrome lock: start the test with `await oneChromeAtATime\(ctx\);`/);
  // A lock file of a test's own (the lock's own tests) is not the real-Chrome lock.
  const dir = mkdtempSync(join(tmpdir(), 'chrome-lock-own-'));
  const release = await takeChromeLock(join(dir, 'lock'));
  try {
    await assert.rejects(launchTestChrome('/nonexistent/chrome'), /without the real-Chrome lock/);
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
});
