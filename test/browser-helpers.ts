// For tests that drive a real Chrome: a loaded CI runner can take far longer than a normal machine to start
// Chrome or answer a command, so these tests scale the browser's timeouts (as such a machine would be
// configured), give each test room for that, and check that nothing one test started is still running when the
// next begins.
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
