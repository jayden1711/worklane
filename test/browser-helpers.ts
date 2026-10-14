// For tests that drive a real Chrome: a loaded CI runner can take far longer than a normal machine to start
// Chrome or answer a command, so these tests scale the browser's timeouts (as such a machine would be
// configured), give each test room for that, and check that nothing one test started is still running when the
// next begins.
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { liveProcesses } from '../src/browser/cdp.js';
import { repoRoot } from './helpers.js';

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

function required(what: string): void {
  if (process.env[REQUIRE_WEB] === '1') throw new Error(`${REQUIRE_WEB}=1, but ${what}: in CI the web-UI tests must run, not skip (build the UI before the tests)`);
}

/** Whether the dashboard UI is built (dist/web/index.html); with CI_REQUIRE_WEB=1, not built throws. */
export function webUiBuilt(root = repoRoot): boolean {
  const built = existsSync(join(root, 'dist', 'web', 'index.html'));
  if (!built) required('the web UI is not built (npm run build:web)');
  return built;
}

/** A web-UI test's skip: why it can't run here (no Chrome, UI not built, Windows), or false; CI_REQUIRE_WEB=1 makes the first two throw. */
export function webUiSkip(chrome: string | null, root = repoRoot): string | false {
  if (process.platform === 'win32') return 'checked on macOS and Linux';
  if (!chrome) required('no Chrome or Chromium was found (set CHROME)');
  const built = webUiBuilt(root);
  return (!chrome && 'no Chrome or Chromium') || (!built && 'web UI not built (npm run build:web)');
}
