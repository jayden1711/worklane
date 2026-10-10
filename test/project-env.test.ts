import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { TestsConfig } from '../src/config/schema.js';
import { projectCommand } from '../src/os/index.js';
import { projectEnvProblem, safeProjectEnv } from '../src/project-env.js';
import { CliRunner } from '../src/runner.js';

const tests = (env: Record<string, string>) => TestsConfig.safeParse({ version: 1, runner: { kind: 'command', changed: 'x', full: 'x' }, env });

test('tests.yaml env takes a project variable such as a fixed test worker count', () => {
  const r = tests({ PYTEST_XDIST_AUTO_NUM_WORKERS: '6', SIM_REALTIME: '1' });
  assert.ok(r.success);
  assert.deepEqual(r.data.env, { PYTEST_XDIST_AUTO_NUM_WORKERS: '6', SIM_REALTIME: '1' });
  assert.deepEqual(tests({}).data!.env, {});
});

test('tests.yaml env refuses harness and system variables, secret-looking names and multi-line values', () => {
  for (const name of ['PATH', 'HOME', 'GIT_CONFIG_COUNT', 'GIT_AUTHOR_NAME', 'GH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', `${BRAND.envPrefix}_AGENT`, 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'https_proxy', 'HTTPS_PROXY', 'SSL_CERT_FILE', 'XDG_RUNTIME_DIR', 'SUDO_USER']) {
    assert.match(projectEnvProblem(name) ?? '', /harness or the system/, name);
    assert.equal(tests({ [name]: 'x' }).success, false, name);
  }
  for (const name of ['NPM_TOKEN', 'DB_PASSWORD', 'MY_API_KEY', 'SERVICE_SECRET', 'AUTH_HEADER']) assert.match(projectEnvProblem(name) ?? '', /secret/, name);
  assert.equal(tests({ 'BAD-NAME': 'x' }).success, false);
  assert.equal(tests({ OK_NAME: 'a\nb' }).success, false);
});

test('a project command sees the project variables; one the harness owns is dropped even if passed', () => {
  const { file, args, env } = projectCommand('echo "$PYTEST_XDIST_AUTO_NUM_WORKERS ${GIT_CONFIG_COUNT:-unset}"', undefined, { PYTEST_XDIST_AUTO_NUM_WORKERS: '6', GIT_CONFIG_COUNT: '9' });
  delete env.GIT_CONFIG_COUNT;
  assert.equal(execFileSync(file, args, { env, encoding: 'utf8' }).trim(), '6 unset');
  assert.deepEqual(safeProjectEnv({ A_B: '1', GIT_DIR: '/x', MY_TOKEN: 't' }), { A_B: '1' });
});

test('an agent session (and the hooks it runs) gets the project variables, never over the harness ones', { skip: process.platform === 'win32' && 'POSIX shell stand-in' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const log = join(dir, 'env.json');
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
require('node:fs').readFileSync(0);
require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.env));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, num_turns: 1 }));
`,
  );
  chmodSync(bin, 0o755);
  const req = { prompt: 'p', model: 'm', cwd: '.', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 60_000, timeoutMs: 60_000, role: 'worker', env: { PYTEST_XDIST_AUTO_NUM_WORKERS: '6', GIT_CONFIG_COUNT: '0', [`${BRAND.envPrefix}_AGENT`]: '0' } };
  const r = await new CliRunner('cli', process.env, bin).run(req);
  assert.equal(r.reason, 'succeeded', r.detail);
  const env = JSON.parse(readFileSync(log, 'utf8')) as Record<string, string>;
  assert.equal(env.PYTEST_XDIST_AUTO_NUM_WORKERS, '6');
  assert.equal(env.GIT_CONFIG_COUNT, '1', 'the no-credential-helper setup stays');
  assert.equal(env[`${BRAND.envPrefix}_AGENT`], '1');
});
