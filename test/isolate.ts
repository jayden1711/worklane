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
// state. Here those all point into a fresh temporary directory, whatever the shell said. So do the machine's own
// locations (src/os/system-paths.ts: /etc/<cli>, /var/lib/<cli>, the root helpers in /usr/local/libexec, /opt/<cli>,
// /run/lock): on a live machine a test read the real machine owners, helper, updates log and settings.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BRAND } from '../src/brand.js';
import { SYSTEMD_MARKERS, SYSTEM_ROOT_VAR, TEST_MARK_FILE, TEST_TOKEN_VAR } from '../src/os/system-paths.js';

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
  [SYSTEM_ROOT_VAR]: join(testMachine, 'root'),
});
for (const [k, v] of Object.entries(isolatedEnv)) {
  mkdirSync(v, { recursive: true });
  process.env[k] = v;
}

// The mark that lets this process and its children use the system root above (src/os/system-paths.ts
// systemRootRefusal): a fresh token, in the environment and in a file of this user's alone inside the root. A suite
// run inside a service (a coordinator testing a PR) inherits systemd's markers; they say nothing about a test, and
// would refuse the root, so they are dropped here.
for (const k of SYSTEMD_MARKERS) delete process.env[k];
const systemRoot = isolatedEnv[SYSTEM_ROOT_VAR]!;
chmodSync(systemRoot, 0o700);
const token = randomBytes(32).toString('hex');
writeFileSync(join(systemRoot, TEST_MARK_FILE), `${token}\n`, { mode: 0o600 });
process.env[TEST_TOKEN_VAR] = token;

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

/**
 * A machine location as a real machine has it (/etc/<cli>/…), from the one this process uses (inside the test's
 * system root): for the checks that the engine and the root scripts name the same file.
 */
export function onRealMachine(p: string): string {
  const r = relative(isolatedEnv[SYSTEM_ROOT_VAR]!, p);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) throw new Error(`${p} is not inside the test's system root`);
  return `/${r.split(sep).join('/')}`;
}

process.on('exit', () => {
  try {
    rmSync(testMachine, { recursive: true, force: true });
  } catch {
    // best effort: a temporary directory left behind is harmless
  }
});

/**
 * An environment for a service mode a test starts (`dashboard --hub`, `--hub-setup --service`): those never run
 * with the system root (src/os/system-paths.ts serviceModeRefusal), so it and the test mark are left out. Only for a
 * mode that reads no machine location.
 */
export function serviceModeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out[SYSTEM_ROOT_VAR];
  delete out[TEST_TOKEN_VAR];
  return out;
}

/** How a runner loads this: node's own flags, before --test (relative to the repo root, where every runner runs). */
export const TEST_PRELOAD = ['--import', './dist/test/isolate.js'] as const;

/** Set in this process once the isolation ran; test/helpers.ts refuses to load in a test file's process without it. */
export const ISOLATED = Symbol.for('test-isolation');
(globalThis as Record<symbol, unknown>)[ISOLATED] = testMachine;
