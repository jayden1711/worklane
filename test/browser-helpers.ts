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
import { launchChrome, liveProcesses, type Browser, type Cdp } from '../src/browser/cdp.js';
import { isLocal } from '../src/browser/run.js';

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

/**
 * Scale the browser's timeouts (unless the environment already does), and fail any test that leaks a process, or
 * whose pages asked for anything outside this machine (launchTestChrome), naming each URL.
 */
export function realChromeTests(): void {
  process.env[SCALE] ??= '3';
  afterEach(() => {
    assert.deepEqual(liveProcesses(), [], 'a browser or app process outlived its test');
    const asked = outsideRequests.splice(0);
    assert.deepEqual(asked, [], 'a page asked for a host outside this machine (no live outside calls from tests, #462)');
  });
}

/**
 * WHY: a real-Chrome test that reaches the internet depends on its answer (a 404, a redirect, a timeout, a rate
 * limit), which moves layouts and timings (#452's flake: avatars from github.com). In a test's Chrome no host resolves
 * but loopback (localhost, 127.0.0.1, ::1), so an outside request fails at once, the same way every run.
 */
// MAP * covers IP literals too, so each loopback form is excluded by name (::1 without brackets; with them it isn't).
export const OFFLINE_CHROME_ARGS = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1'];

/**
 * Outside URLs a page may still ask for (they fail at once, never reaching the network) until the product stops
 * asking: a person's GitHub picture, until the dashboard serves them from its own origin (#462, option B).
 */
export const KNOWN_OUTSIDE: RegExp[] = [/^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\.png(?:\?[^#]*)?$/];

/** Outside URLs pages asked for since the last test ended; realChromeTests' afterEach fails on any. */
const outsideRequests: string[] = [];

/** The outside URLs asked for so far, emptied: for the test that checks this guard itself. */
export const takeOutsideRequests = (): string[] => outsideRequests.splice(0);

/** Whether a page's request goes outside this machine: http(s) or ws(s) to any host but loopback. */
export const isOutside = (url: string): boolean => /^(?:https?|wss?):/i.test(url) && !isLocal(url);

/**
 * The only way a test starts a real Chrome (test/offline-chrome.test.ts keeps it so): launchChrome with no host but
 * localhost resolving, and every request its page makes watched. One outside the machine that isn't KNOWN_OUTSIDE, or
 * `allow` for this test (one it answers itself with Fetch, say), fails the test, named.
 */
export async function launchTestChrome(chrome: string, o: Parameters<typeof launchChrome>[1] & { allow?: RegExp[] } = {}): Promise<Browser> {
  const { allow = [], ...launch } = o;
  const b = await launchChrome(chrome, { ...launch, extraArgs: [...OFFLINE_CHROME_ARGS, ...(launch.extraArgs ?? [])] });
  const known = [...KNOWN_OUTSIDE, ...allow];
  b.cdp.on('Network.requestWillBeSent', (p) => {
    const url = String((p.request as { url?: unknown } | undefined)?.url ?? '');
    if (isOutside(url) && !known.some((r) => r.test(url))) outsideRequests.push(url);
  });
  try {
    await b.cdp.send('Network.enable');
  } catch (e) {
    await b.close();
    throw e;
  }
  return b;
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

/** How far (CSS px) a target may drift between the read and the press: sub-pixel layout rounding, nothing more. */
export const STEADY_PX = 0.5;

/**
 * Where to press `element` (an in-page expression): its centre, scrolled to the middle of the view, read, then read
 * again two frames later, just before the press. A target that moved in between (a panel answering late above it)
 * fails here at once, saying where it was, where it went and what the press would have reached, never a press that
 * silently lands on something else and a wait that times out later (#453: Install moved 208 px onto a heading).
 */
export async function steadyCentre(cdp: Cdp, element: string, what: string = element): Promise<{ x: number; y: number }> {
  const r = await cdp.send<{ result: { value: { a: { x: number; y: number }; b: { x: number; y: number }; connected: boolean; under: string } | null }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
    expression: `(async () => {
      const e = ${element};
      if (!e) return null;
      e.scrollIntoView({ block: 'center' });
      const at = () => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
      const a = at();
      // Two frames (at most 250 ms, should frames not come): long enough for a late answer's render to land.
      await Promise.race([new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))), new Promise((ok) => setTimeout(ok, 250))]);
      const b = at();
      const h = document.elementFromPoint(a.x, a.y);
      const under = h === e || (h && e.contains(h)) ? 'the target' : h ? '<' + h.tagName.toLowerCase() + [...h.attributes].map((x) => ' ' + x.name + '="' + x.value.slice(0, 60) + '"').join('') + '>' + (h.textContent || '').trim().slice(0, 60) : 'nothing';
      return { a, b, connected: e.isConnected, under };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  const v = r.result.value;
  if (!v) throw new Error(`${what}: not in the page at the press`);
  const p = (q: { x: number; y: number }) => `(${Math.round(q.x)}, ${Math.round(q.y)})`;
  if (!v.connected || Math.abs(v.a.x - v.b.x) > STEADY_PX || Math.abs(v.a.y - v.b.y) > STEADY_PX) {
    throw new Error(`${what} moved between the read and the press: from ${p(v.a)} to ${v.connected ? p(v.b) : 'out of the page'}; a press at ${p(v.a)} would reach ${v.under}`);
  }
  return v.b;
}

/** A real mouse press and release at a steady target's centre (steadyCentre above). */
export async function pressSteady(cdp: Cdp, element: string, what: string = element): Promise<void> {
  const at = await steadyCentre(cdp, element, what);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
}
