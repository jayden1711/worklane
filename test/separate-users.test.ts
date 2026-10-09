import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ConfigInvalid } from '../src/config/load.js';
import { initInstance, laneRuns, loadInstance } from '../src/instance.js';
import { asUser, projectCommand } from '../src/os/index.js';
import { agentEnv, cliArgs, CliRunner, runAsEnv } from '../src/runner.js';
import { sandboxSettings } from '../src/sandbox.js';
import { instanceEnv } from '../src/service.js';
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
  assert.throws(() => loadInstance('shop', allowed.dir), /set claude\.config_dir/, 'same-user agents need the Claude login named');
  writeFileSync(join(allowed.home, 'credentials.yaml'), `version: 1\ngithub: { kind: gh-config-dir, path: ${join(allowed.home, 'gh')} }\nclaude: { config_dir: ${join(allowed.home, 'claude')} }\n`);
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
  if (process.platform === 'win32') {
    assert.throws(() => asUser('shop-agent', 'claude', [], {}), /needs macOS or Linux/, 'refused, never run as the coordinator instead');
    return;
  }
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
  // A project command (a check or test suite, which runs agent-written code) is just as unable to read it.
  const pc = projectCommand(`cat ${JSON.stringify(secret)}`, { user: agentUser!, home: `/home/${agentUser}` });
  const pr = spawnSync(pc.file, pc.args, { encoding: 'utf8', env: pc.env, timeout: 30_000 });
  assert.notEqual(pr.status, 0, 'a project command read the secret');
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

test('sandbox settings fail closed and deny the same paths to commands and to the Read tool', () => {
  const s = sandboxSettings({ lane: { allowedDomains: ['registry.npmjs.org', 'registry.npmjs.org'] }, denyRead: ['/srv/inst/shop', '/home/shop-agent/.ssh'] });
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.failIfUnavailable, true, 'no sandbox, no run');
  assert.equal(s.sandbox.allowUnsandboxedCommands, false, 'no retry outside the sandbox');
  assert.deepEqual(s.sandbox.network.allowedDomains, ['registry.npmjs.org']);
  assert.deepEqual(s.sandbox.filesystem.denyRead, ['/srv/inst/shop', '/home/shop-agent/.ssh']);
  assert.deepEqual(s.permissions.deny, ['Read(//srv/inst/shop/**)', 'Read(//home/shop-agent/.ssh/**)']);
  assert.match(cliArgs({ prompt: 'p', model: 'm', cwd: '.', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 1, timeoutMs: 1, role: 'worker' }, s).slice(0, 2).join(' '), /^--settings \{"sandbox":/);
});

test('lanes: each runs as its user in its own sandbox; only the eval user\'s lane can read the eval key', { skip: process.platform === 'win32' && 'separate users and the sandbox are POSIX-only; native Windows runs commands unsandboxed' }, () => {
  const { dir, home } = instance('run_as:\n  agent_user: shop-agent\n  agent_home: /home/shop-agent\n  eval_user: shop-eval\n  eval_home: /home/shop-eval\n', 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nlanes:\n  default: { allowed_domains: [registry.npmjs.org] }\n  eval: { allowed_domains: [api.anthropic.com], run_as: eval }\n');
  writeFileSync(join(home, 'credentials.yaml'), `version: 1\ngithub: { kind: gh-config-dir, path: ${join(home, 'gh')} }\nclaude: { config_dir: ${join(home, 'claude')} }\neval_key: /home/shop-eval/key\n`);
  const lanes = laneRuns(loadInstance('shop', dir));
  assert.equal(lanes.default!.runAs!.user, 'shop-agent');
  assert.equal(lanes.eval!.runAs!.user, 'shop-eval');
  const d = lanes.default!.settings!.sandbox;
  const e = lanes.eval!.settings!.sandbox;
  assert.deepEqual(d.network.allowedDomains, ['registry.npmjs.org']);
  assert.deepEqual(e.network.allowedDomains, ['api.anthropic.com']);
  for (const p of [home, '/home/shop-agent/.ssh', '/home/shop-agent/.config/gh', '/home/shop-agent/.claude/.credentials.json', '/home/shop-eval/key']) assert.ok(d.filesystem.denyRead.includes(p), `default lane denies ${p}`);
  assert.ok(!e.filesystem.denyRead.includes('/home/shop-eval/key'), 'the eval lane may read its key');
  assert.ok(e.filesystem.denyRead.includes(home), 'but never the coordinator\'s home');
});

test('lane policy: eval lanes need an eval user, lanes need a default, and the sandbox is off only when said', () => {
  const noEvalUser = instance('run_as:\n  agent_user: shop-agent\n  agent_home: /home/shop-agent\n', 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nlanes:\n  default: {}\n  eval: { run_as: eval }\n');
  assert.throws(() => loadInstance('shop', noEvalUser.dir), /a lane runs as eval, so set eval_user/);
  const noDefault = instance('run_as:\n  agent_user: shop-agent\n  agent_home: /home/shop-agent\n', 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nlanes:\n  build: {}\n');
  assert.throws(() => loadInstance('shop', noDefault.dir), /lanes must include default/);
  const off = instance('run_as:\n  agent_user: shop-agent\n  agent_home: /home/shop-agent\n', 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nsandbox: false\n');
  assert.equal(laneRuns(loadInstance('shop', off.dir)).default!.settings, undefined);
  const on = instance('run_as:\n  agent_user: shop-agent\n  agent_home: /home/shop-agent\n');
  assert.ok(laneRuns(loadInstance('shop', on.dir)).default!.settings, 'on by default');
});

test('a run in a lane the instance does not define is refused', async () => {
  const r = await new CliRunner('cli', { PATH: '' }, 'claude', undefined, { default: {} }).run({ prompt: 'p', model: 'm', cwd: '.', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 1, timeoutMs: 1, role: 'worker', lane: 'nope' });
  assert.equal(r.reason, 'failed');
  assert.match(r.detail, /unknown lane "nope"/);
});

test('the coordinator\'s git runs no hooks and no fsmonitor command, whatever a checkout agents can write to says', { skip: process.platform === 'win32' && 'POSIX hooks' }, () => {
  const { dir, home } = instance('run_as:\n  agent_user: shop-agent\n  agent_home: /home/shop-agent\n');
  const repo = loadInstance('shop', dir).repo.path;
  const marker = join(home, 'pwned');
  // What an agent could plant if it could write the checkout's git config or hooks.
  writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  spawnSync('git', ['config', 'core.fsmonitor', `touch ${marker}.fsmonitor; false`], { cwd: repo });
  const env = instanceEnv(loadInstance('shop', dir), { PATH: process.env.PATH });
  const r = spawnSync('git', ['checkout', '-q', '-b', 'probe'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  spawnSync('git', ['status', '--porcelain'], { cwd: repo, env });
  assert.equal(existsSync(marker), false, 'the planted hook did not run');
  assert.equal(existsSync(`${marker}.fsmonitor`), false, 'the planted fsmonitor command did not run');
  // Sanity: without the coordinator's environment, the planted hook would have run.
  spawnSync('git', ['checkout', '-q', '-b', 'probe2'], { cwd: repo, env: { PATH: process.env.PATH } });
  assert.equal(existsSync(marker), true);
});

test('project commands (checks, gates, setup, full runs) run as the agent user with a clean environment', () => {
  if (process.platform === 'win32') {
    assert.throws(() => projectCommand('npm test', { user: 'shop-agent', home: '/home/shop-agent' }), /needs macOS or Linux/, 'refused, never run as the coordinator instead');
    return;
  }
  const { file, args, env } = projectCommand('npm test | tail -5', { user: 'shop-agent', home: '/home/shop-agent' });
  assert.equal(file, 'sudo');
  assert.deepEqual(args.slice(0, 6), ['-n', '-u', 'shop-agent', '--', '/usr/bin/env', '-i']);
  assert.ok(args.includes('HOME=/home/shop-agent') && args.includes('USER=shop-agent'));
  assert.ok(!args.some((a) => /GH_|GITHUB|TOKEN/.test(a)), 'no credentials reach project code');
  // Git settings: exactly no credential helper, and trust in the coordinator's checkout (nothing else).
  assert.deepEqual(args.filter((a) => a.startsWith('GIT_CONFIG')), ['GIT_CONFIG_COUNT=2', 'GIT_CONFIG_KEY_0=credential.helper', 'GIT_CONFIG_VALUE_0=', 'GIT_CONFIG_KEY_1=safe.directory', 'GIT_CONFIG_VALUE_1=*']);
  assert.deepEqual(args.slice(-4), ['-o', 'pipefail', '-c', 'npm test | tail -5']);
  assert.deepEqual(Object.keys(env), ['PATH'], 'sudo itself gets only PATH');
});

// A real other user, which passwordless sudo can switch to (CI runners; skipped where sudo asks for a password).
const canSudoNobody = process.platform !== 'win32' && spawnSync('sudo', ['-n', '-u', 'nobody', 'true']).status === 0;

test('regression: a check that runs git, run as the agent user in the coordinator\'s checkout, gets git\'s answer (not "dubious ownership")', { skip: !canSudoNobody && 'needs passwordless sudo to another user' }, () => {
  // The checkout belongs to the coordinator user; checks run as the agent user. Git refuses a repository owned by
  // someone else unless it is trusted, so `git diff --exit-code` failed with 128 on a clean tree and failed the check.
  const repo = mkdtempSync('/tmp/wl-check-git-');
  chmodSync(repo, 0o755);
  const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', 'a.txt');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'a');
  spawnSync('chmod', ['-R', 'a+rX', repo]);
  try {
    const { file, args, env } = projectCommand('git diff --exit-code', { user: 'nobody', home: '/' });
    const r = spawnSync(file, args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
