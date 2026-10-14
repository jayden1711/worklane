// Every test process gets a machine of its own: a temporary home, state dir and agent-slot directory, and none of
// the machine's own engine settings (issue #312). Every way the suite runs preloads it (TEST_PRELOAD below: npm test,
// the CI shards, the touched-tests check; test/isolate.test.ts checks each), so a test file gets it without importing
// anything, before any of its modules reads the environment. A test file's process without it stops at once
// (test/helpers.ts).
//
// WHY: the suite runs on machines that already run the engine (the release runs `npm test` on one). Through the
// defaults, a test read and wrote the person's own state dir (~/.local/state/<cli>, ~/Library/Application Support/<cli>),
// the machine's slot directory (/var/lib/<cli>/agent-slots when it exists, with its STOP file and cap) and whatever
// <PREFIX>_* the shell had set, so a live instance could change a test's result and a test could change the instance's
// state. Here those all point into a fresh temporary directory, whatever the shell said.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';

/** Engine settings that only tune speed, kept from the shell (a slow CI runner scales the browser's timeouts). */
const KEEP = new Set([`${BRAND.envPrefix}_BROWSER_TIMEOUT_SCALE`]);
for (const k of Object.keys(process.env)) {
  if ((k.startsWith(`${BRAND.envPrefix}_`) && !KEEP.has(k)) || k.startsWith('AGENT_SLOTS_')) delete process.env[k];
}

/** This test process's machine: everything below is inside it. */
export const testMachine = mkdtempSync(join(tmpdir(), 'test-machine-'));
const home = join(testMachine, 'home');

/**
 * Whether HOME itself moves. Not on macOS: headless Chrome there never answers a navigation with a fresh home
 * (browser-run and browser-check time out after 90 s), so each default the engine derives from the home is moved
 * one by one instead: XDG_*, the state dir and the tool prefix below.
 */
export const homeMoved = process.platform !== 'darwin';

/** What the isolation sets: each a directory inside testMachine. */
export const isolatedEnv: Readonly<Record<string, string>> = Object.freeze({
  ...(homeMoved ? { HOME: home } : { [`${BRAND.envPrefix}_PREFIX`]: join(home, '.local') }),
  ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  [`${BRAND.envPrefix}_STATE_DIR`]: join(testMachine, 'state'),
  [`${BRAND.envPrefix}_MACHINE_INIT_DIR`]: join(testMachine, 'machine-init'),
  AGENT_SLOTS_DIR: join(testMachine, 'agent-slots'),
});
for (const [k, v] of Object.entries(isolatedEnv)) {
  mkdirSync(v, { recursive: true });
  process.env[k] = v;
}

/**
 * Put these variables back to this process's isolated values, after a test pointed them somewhere of its own.
 * Never `delete` one of them (test/isolate.test.ts checks): unset, it falls back to the machine's own directory.
 */
export function restoreIsolated(...keys: string[]): void {
  for (const k of keys) {
    const v = isolatedEnv[k];
    if (v === undefined) throw new Error(`${k} is not one of the isolated variables`);
    process.env[k] = v;
  }
}

process.on('exit', () => {
  try {
    rmSync(testMachine, { recursive: true, force: true });
  } catch {
    // best effort: a temporary directory left behind is harmless
  }
});

/** How a runner loads this: node's own flags, before --test (relative to the repo root, where every runner runs). */
export const TEST_PRELOAD = ['--import', './dist/test/isolate.js'] as const;

/** Set in this process once the isolation ran; test/helpers.ts refuses to load in a test file's process without it. */
export const ISOLATED = Symbol.for('test-isolation');
(globalThis as Record<symbol, unknown>)[ISOLATED] = testMachine;
