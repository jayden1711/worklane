import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ConfigInvalid } from '../src/config/load.js';
import { initInstance, loadInstance } from '../src/instance.js';
import { asUser } from '../src/os/index.js';
import { agentEnv, runAsEnv } from '../src/runner.js';
import { exampleProject } from './helpers.js';

function instance(extraInstance = '', policy = 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\n') {
  const dir = mkdtempSync(join(tmpdir(), 'instances-'));
  const { dir: repo } = exampleProject();
  const home = initInstance('shop', repo, 'example-org/example-shop', dir);
  writeFileSync(join(home, 'policy.yaml'), policy);
  if (extraInstance !== null) writeFileSync(join(home, 'instance.yaml'), readFileSync(join(home, 'instance.yaml'), 'utf8').replace(/# Agents run as[\s\S]*$/, extraInstance));
  return { dir, home };
}

test('safe default: an instance without a separate agent user is refused unless its policy explicitly allows it', () => {
  const { dir } = instance('');
  assert.throws(
    () => loadInstance('shop', dir),
    (e: unknown) => e instanceof ConfigInvalid && /agents must run as their own OS user/.test(e.message),
  );
  const allowed = instance('', 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nallow_same_user: true\n');
  assert.equal(loadInstance('shop', allowed.dir).runAs, null);
  const separate = instance('run_as:\n  agent_user: shop-agent\n  agent_home: /home/shop-agent\n');
  assert.deepEqual(loadInstance('shop', separate.dir).runAs, { user: 'shop-agent', home: '/home/shop-agent' });
});

test('an agent run as its own user gets its home and login, git trusts its worktrees, and no tokens', () => {
  const env = runAsEnv(agentEnv({ PATH: '/usr/bin', HOME: '/home/coord', GH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/home/coord/.claude' }, 'cli'), { user: 'shop-agent', home: '/home/shop-agent' });
  assert.equal(env.HOME, '/home/shop-agent');
  assert.equal(env.USER, 'shop-agent');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/shop-agent/.claude', 'never the coordinator\'s login');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'safe.directory');
  const [file, args] = asUser('shop-agent', 'claude', ['-p', 'hi'], { HOME: '/home/shop-agent', X: undefined });
  assert.equal(file, 'sudo');
  assert.deepEqual(args, ['-n', '-u', 'shop-agent', '--', '/usr/bin/env', '-i', 'HOME=/home/shop-agent', 'claude', '-p', 'hi'], 'a clean environment: only what is passed');
});

// Acceptance, on a machine set up with separate users (see docs/separate-users.md):
//   AGENT_USER=<agent user>  SECRET_FILE=<a credential file only the coordinator user can read>
const agentUser = process.env[`${BRAND.envPrefix}_TEST_AGENT_USER`];
const secret = process.env[`${BRAND.envPrefix}_TEST_SECRET_FILE`];
const live = agentUser && secret ? false : `set ${BRAND.envPrefix}_TEST_AGENT_USER and ${BRAND.envPrefix}_TEST_SECRET_FILE to run against real users`;

test('acceptance: an agent running `python -c "open(<token path>)"` fails; the coordinator can read it', { skip: live }, () => {
  assert.ok(readFileSync(secret!, 'utf8').length > 0, 'the coordinator user can read its own credential');
  const env = runAsEnv(agentEnv({ PATH: '/usr/local/bin:/usr/bin:/bin' }, 'cli'), { user: agentUser!, home: `/home/${agentUser}` });
  for (const [file, args] of [
    ['python3', ['-c', `open(${JSON.stringify(secret)}).read()`]],
    ['cat', [secret!]],
  ] as [string, string[]][]) {
    const [f, a] = asUser(agentUser!, file, args, env);
    const r = spawnSync(f, a, { encoding: 'utf8', env: { PATH: env.PATH! }, timeout: 30_000 });
    assert.notEqual(r.status, 0, `${file} read the secret as ${agentUser}`);
    assert.match(r.stderr, /Permission denied|PermissionError/, r.stderr);
  }
  // And the agent user really runs: it can read a world-readable file.
  const [f, a] = asUser(agentUser!, 'python3', ['-c', 'import os; print(os.getuid() != 0)'], env);
  const ok = spawnSync(f, a, { encoding: 'utf8', env: { PATH: env.PATH! }, timeout: 30_000 });
  assert.equal(ok.stdout.trim(), 'True', ok.stderr);
});

test('a separate agent user cannot reach an instance home on this machine (0700), even by path', { skip: live }, () => {
  const home = mkdtempSync(join(tmpdir(), 'inst-home-'));
  mkdirSync(join(home, 'gh'), { mode: 0o700 });
  const env = runAsEnv(agentEnv({ PATH: '/usr/local/bin:/usr/bin:/bin' }, 'cli'), { user: agentUser!, home: `/home/${agentUser}` });
  const [f, a] = asUser(agentUser!, 'ls', [join(home, 'gh')], env);
  assert.notEqual(spawnSync(f, a, { encoding: 'utf8', env: { PATH: env.PATH! } }).status, 0);
});
