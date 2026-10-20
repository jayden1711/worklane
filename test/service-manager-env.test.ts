// #738: what this user's service manager gives the local coordinator's service, read through the OS adapter
// (src/os/index.ts serviceManagerEnv): systemd's user manager on Linux, launchd on macOS. Against stand-ins for
// `systemctl` and `launchctl` (functions here; a script on PATH in test/setup-claude-runtime.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceManagerEnv } from '../src/os/index.js';

const NAMES = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
const KEY = 'sk-ant-manager-CANARY-738';

test('Linux: the names asked for, from `systemctl --user show-environment`; nothing else', () => {
  const calls: string[][] = [];
  const out = `PATH=/usr/bin:/bin\nHOME=/home/u\nCLAUDE_CONFIG_DIR=/home/u/.claude-work\nANTHROPIC_API_KEY=${KEY}\nOTHER=x\n`;
  const r = serviceManagerEnv(NAMES, { platform: 'linux', run: (cmd, args) => (calls.push([cmd, ...args]), out) });
  assert.deepEqual(r, { env: { CLAUDE_CONFIG_DIR: '/home/u/.claude-work', ANTHROPIC_API_KEY: KEY } });
  assert.deepEqual(calls, [['systemctl', '--user', 'show-environment']]);
  assert.deepEqual(serviceManagerEnv(NAMES, { platform: 'linux', run: () => 'PATH=/bin\n' }), { env: {} }, 'none set');
});

test('Linux: unreadable is an error, and the error never carries a value', () => {
  const down = serviceManagerEnv(NAMES, {
    platform: 'linux',
    run: () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'Failed to connect to bus: No medium found\n' });
    },
  });
  assert.deepEqual(down, { error: 'systemctl --user show-environment failed: Failed to connect to bus: No medium found' });
  // A value systemd had to quote ($'...') is not read, so not guessed: an error naming the variable only.
  const quoted = serviceManagerEnv(NAMES, { platform: 'linux', run: () => `ANTHROPIC_API_KEY=$'${KEY}\\n'\n` });
  assert.ok('error' in quoted);
  assert.match(quoted.error, /sets ANTHROPIC_API_KEY in a quoted form/);
  assert.ok(!quoted.error.includes(KEY));
});

test('macOS: `launchctl getenv` per name; an empty answer is unset; a failure is an error', () => {
  const calls: string[][] = [];
  const r = serviceManagerEnv(NAMES, { platform: 'darwin', run: (cmd, args) => (calls.push([cmd, ...args]), args[1] === 'CLAUDE_CONFIG_DIR' ? '/Users/u/.claude-work\n' : '') });
  assert.deepEqual(r, { env: { CLAUDE_CONFIG_DIR: '/Users/u/.claude-work' } });
  assert.deepEqual(calls.map((c) => c.join(' ')), NAMES.map((n) => `launchctl getenv ${n}`));
  const failed = serviceManagerEnv(NAMES, {
    platform: 'darwin',
    run: () => {
      throw new Error('launchctl: not found');
    },
  });
  assert.deepEqual(failed, { error: 'launchctl getenv CLAUDE_CONFIG_DIR failed: launchctl: not found' });
});

test('elsewhere: no service manager this check knows, as an error (fail closed)', () => {
  assert.deepEqual(serviceManagerEnv(NAMES, { platform: 'win32', run: () => '' }), { error: 'no user service manager this check knows on win32' });
});
