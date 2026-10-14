// For tests that drive a real Chrome: a loaded CI runner can take far longer than a normal machine to start
// Chrome or answer a command, so these tests scale the browser's timeouts (as such a machine would be
// configured), give each test room for that, and check that nothing one test started is still running when the
// next begins.
import { afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BRAND } from '../src/brand.js';
import { liveProcesses } from '../src/browser/cdp.js';

/** Per real-Chrome test: room for scaled launches, a retry and teardown on a loaded runner. */
export const REAL_CHROME_TIMEOUT = 300_000;

const SCALE = `${BRAND.envPrefix}_BROWSER_TIMEOUT_SCALE`;

/** Run `fn` with the browser's default timeouts: for a wait that is meant to time out, so the test isn't slower. */
export async function unscaled<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env[SCALE];
  process.env[SCALE] = '1';
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env[SCALE];
    else process.env[SCALE] = was;
  }
}

/** Scale the browser's timeouts (unless the environment already does), and fail any test that leaks a process. */
export function realChromeTests(): void {
  process.env[SCALE] ??= '3';
  afterEach(() => {
    assert.deepEqual(liveProcesses(), [], 'a browser or app process outlived its test');
  });
}

/**
 * CI sets CI_REQUIRE_WEB=1 on its test step: there a web-UI test must run, never skip. A test that needs the built
 * dashboard UI (npm run build:web) or a Chrome asks through these two, the only place a test looks at dist/web
 * (test/web-ui-required.test.ts keeps it so); with CI_REQUIRE_WEB=1 a missing UI or Chrome throws when the test file
 * loads, so the file fails instead of reporting a quiet "# SKIP web UI not built".
 */
const REQUIRE_WEB = 'CI_REQUIRE_WEB';
/** The built UI's page, from dist/test/ where this runs (not repoRoot: a use of that reads the whole repo, to the test selection). */
const WEB_INDEX = join(import.meta.dirname, '..', '..', 'dist', 'web', 'index.html');

function required(what: string): void {
  if (process.env[REQUIRE_WEB] === '1') throw new Error(`${REQUIRE_WEB}=1, but ${what}: in CI the web-UI tests must run, not skip (build the UI before the tests)`);
}

/** Whether the dashboard UI is built (dist/web/index.html, or `index`); with CI_REQUIRE_WEB=1, not built throws. */
export function webUiBuilt(index = WEB_INDEX): boolean {
  const built = existsSync(index);
  if (!built) required('the web UI is not built (npm run build:web)');
  return built;
}

/** A web-UI test's skip: why it can't run here (no Chrome, UI not built, Windows), or false; CI_REQUIRE_WEB=1 makes the first two throw. */
export function webUiSkip(chrome: string | null, index = WEB_INDEX): string | false {
  if (process.platform === 'win32') return 'checked on macOS and Linux';
  if (!chrome) required('no Chrome or Chromium was found (set CHROME)');
  const built = webUiBuilt(index);
  return (!chrome && 'no Chrome or Chromium') || (!built && 'web UI not built (npm run build:web)');
}

/**
 * One real Chrome at a time across every test file: node --test runs files in parallel processes, and two or three
 * headless Chromes starting together on a small CI runner starve each other (a DevTools port that never came in
 * 20 s, its first output 13 s late).
 *
 * The lock is a file holding its owner's pid, and it appears whole: the pid is written to a file of the taker's own,
 * which is then hard-linked to the lock's name (link is atomic and fails when the name exists), so no one ever sees a
 * lock without its owner. A lock is taken over only when its pid is readable and that process is gone, and only by
 * the one waiter holding the takeover guard (an atomic mkdir), which checks again under the guard that the lock is
 * still that dead owner's before removing it; then every waiter races for the name as before.
 */
export const CHROME_LOCK = join(tmpdir(), `${BRAND.envPrefix.toLowerCase()}-test-real-chrome.pid`);

/** A lock (or guard) left this long with no readable owner is a crashed taker's: only then is it cleared. */
const UNREADABLE_MS = 60_000;

function readLock(lock: string): string | null {
  try {
    return readFileSync(lock, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return '';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function olderThan(path: string, ms: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ms;
  } catch {
    return false;
  }
}

/** Take the lock if no one holds it: true when this process now does. */
function tryTake(lock: string, mine: string): boolean {
  const own = `${lock}.${process.pid}.${randomUUID()}`;
  writeFileSync(own, mine);
  try {
    linkSync(own, lock);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return false;
  } finally {
    rmSync(own, { force: true });
  }
}

/** Remove the lock when its owner is gone (under the takeover guard, checked again there); true when it did. */
function clearStale(lock: string): boolean {
  const seen = readLock(lock);
  if (seen === null) return true; // given back meanwhile: race for it now
  const pid = Number(seen);
  const stale = Number.isInteger(pid) && pid > 0 && /^\d+$/.test(seen) ? !alive(pid) : olderThan(lock, UNREADABLE_MS);
  if (!stale) return false;
  const guard = `${lock}.takeover`;
  try {
    mkdirSync(guard);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Another waiter is taking it over; a guard left by one that crashed in those few lines is cleared when old.
    if (olderThan(guard, UNREADABLE_MS)) rmSync(guard, { recursive: true, force: true });
    return false;
  }
  try {
    // Only the guard's holder removes a stale lock, and a dead owner never gives it back: if the lock still holds
    // what was judged stale, it is that one.
    if (readLock(lock) === seen) rmSync(lock, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

/** Wait for the real-Chrome lock and take it; the returned function gives it back. */
export async function takeChromeLock(lock = CHROME_LOCK): Promise<() => void> {
  const mine = String(process.pid);
  for (;;) {
    if (tryTake(lock, mine)) {
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (readLock(lock) === mine) rmSync(lock, { force: true });
      };
    }
    if (!clearStale(lock)) await sleep(100);
  }
}

/** First thing in a real-Chrome test: hold the lock for the whole test, given back when it ends. */
export async function oneChromeAtATime(t: TestContext): Promise<void> {
  const release = await takeChromeLock();
  t.after(release);
}
