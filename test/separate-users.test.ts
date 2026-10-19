import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ConfigInvalid } from '../src/config/load.js';
import { initInstance, laneRuns, loadInstance } from '../src/instance.js';
import { asUser, defaultAgentPath, projectCommand } from '../src/os/index.js';
import { agentEnv, claudeAuthStatus, claudeAuthStatusJson, cliArgs, CliRunner, runAsEnv } from '../src/runner.js';
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
  // Its project commands never see the instance home or the credentials it names (#713).
  assert.deepEqual(loadInstance('shop', separate.dir).runAs, { user: 'shop-agent', home: '/home/shop-agent', path: defaultAgentPath(), hide: [separate.home, join(separate.home, 'gh')] });
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

test('regression: every claude auth status probe runs with the agent user\'s home, name and XDG dirs, the same as its runs', { skip: process.platform === 'win32' && 'separate users are POSIX-only' }, async () => {
  // A stand-in sudo on PATH records the environment each call passes through env -i, and plays claude.
  const dir = mkdtempSync(join(tmpdir(), 'probe-env-'));
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(
    join(dir, 'sudo'),
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const i = a.indexOf('-i');
const env = {};
let j = i + 1;
for (; j < a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[j]); j++) env[a[j].slice(0, a[j].indexOf('='))] = a[j].slice(a[j].indexOf('=') + 1);
const probe = a[j + 1] === 'auth' && a[j + 2] === 'status';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ probe, env }) + '\\n');
if (probe) console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 0, total_cost_usd: 0 }));
`,
  );
  chmodSync(join(dir, 'sudo'), 0o755);
  const runAs = { user: 'shop-agent', home: '/home/shop-agent' };
  // The coordinator's own environment, as the service hands it to the watchdog: its home, its name, its XDG dirs.
  const coord = { PATH: dir, HOME: '/home/coord', USER: 'coord', LOGNAME: 'coord', XDG_CONFIG_HOME: '/home/coord/.config', XDG_CACHE_HOME: '/home/coord/.cache', CLAUDE_CONFIG_DIR: '/home/coord/.claude' };
  try {
    const run = await new CliRunner('cli', coord, 'claude', runAs).run({ prompt: 'p', model: 'm', cwd: dir, allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, role: 'worker' });
    assert.equal(run.reason, 'succeeded', run.detail);
    assert.deepEqual(claudeAuthStatusJson(coord, runAs), { loggedIn: true }, "the watchdog's probe");
    assert.equal(claudeAuthStatus(coord, runAs).method, 'claude.ai');
    const seen = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { probe: boolean; env: Record<string, string> });
    const runEnv = seen.find((c) => !c.probe)!.env;
    const probes = seen.filter((c) => c.probe);
    assert.equal(probes.length, 3, "the run's own preflight, the watchdog's and claudeAuthStatus");
    const KEYS = ['HOME', 'USER', 'LOGNAME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'];
    const pick = (e: Record<string, string>) => Object.fromEntries(KEYS.map((k) => [k, e[k]]));
    for (const p of probes) assert.deepEqual(pick(p.env), pick(runEnv), 'each probe looks where the run looks, never in the coordinator\'s home');
    const h = '/home/shop-agent';
    assert.deepEqual(pick(runEnv), { HOME: h, USER: 'shop-agent', LOGNAME: 'shop-agent', CLAUDE_CONFIG_DIR: `${h}/.claude`, XDG_CONFIG_HOME: `${h}/.config`, XDG_DATA_HOME: `${h}/.local/share`, XDG_CACHE_HOME: `${h}/.cache`, XDG_STATE_HOME: `${h}/.local/state` }, "the agent user's, all of them");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a resumed session runs as the same agent user, in that user's home, where its session lives; the run record keeps its session", { skip: process.platform === 'win32' && 'separate users are POSIX-only' }, async () => {
  // A stand-in sudo records who each call runs as, its environment and claude's arguments, and plays claude.
  const dir = mkdtempSync(join(tmpdir(), 'resume-as-'));
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(
    join(dir, 'sudo'),
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const user = a[a.indexOf('-u') + 1];
const i = a.indexOf('-i');
const env = {};
let j = i + 1;
for (; j < a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[j]); j++) env[a[j].slice(0, a[j].indexOf('='))] = a[j].slice(a[j].indexOf('=') + 1);
const argv = a.slice(j + 1);
const probe = argv[0] === 'auth' && argv[1] === 'status';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ probe, user, env, argv }) + '\\n');
if (probe) console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
else {
  const r = argv.indexOf('--resume');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, total_cost_usd: 0, session_id: r >= 0 ? argv[r + 1] : 'new-session' }));
}
`,
  );
  chmodSync(join(dir, 'sudo'), 0o755);
  const runAs = { user: 'shop-agent', home: '/home/shop-agent' };
  const coord = { PATH: dir, HOME: '/home/coord', USER: 'coord', LOGNAME: 'coord', CLAUDE_CONFIG_DIR: '/home/coord/.claude' };
  const stateDir = join(dir, 'state');
  const session = '3f1c2a4e-2222-4000-8000-00000000beef';
  try {
    const run = await new CliRunner('cli', coord, 'claude', runAs).run({ prompt: 'p', model: 'm', cwd: dir, allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, role: 'worker', stateDir, resume: session });
    assert.equal(run.reason, 'succeeded', run.detail);
    assert.equal(run.sessionId, session);
    const seen = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { probe: boolean; user: string; env: Record<string, string>; argv: string[] });
    const claude = seen.find((c) => !c.probe)!;
    assert.equal(claude.user, 'shop-agent', 'as the agent user, never the coordinator');
    assert.deepEqual([claude.env.HOME, claude.env.CLAUDE_CONFIG_DIR], ['/home/shop-agent', '/home/shop-agent/.claude'], "the agent user's login, where its sessions are");
    assert.deepEqual(claude.argv.slice(claude.argv.indexOf('--resume'), claude.argv.indexOf('--resume') + 2), ['--resume', session]);
    const records = readdirSync(join(stateDir, 'runs')).filter((f) => f.endsWith('.json'));
    assert.equal(records.length, 1);
    const rec = JSON.parse(readFileSync(join(stateDir, 'runs', records[0]!), 'utf8')) as { sessionId?: string; resumed?: string };
    assert.deepEqual([rec.sessionId, rec.resumed], [session, session]);
    // An id that isn't one never reaches the command line.
    const bad = await new CliRunner('cli', coord, 'claude', runAs).run({ prompt: 'p', model: 'm', cwd: dir, allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, role: 'worker', resume: '--dangerously-skip-permissions' });
    assert.equal(bad.reason, 'failed');
    assert.match(bad.detail, /not a session id/);
    assert.ok(!cliArgs({ prompt: 'p', model: 'm', cwd: '.', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 1, timeoutMs: 1, role: 'worker', resume: '-x' }).includes('--resume'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// A real other user, which passwordless sudo can switch to (CI runners; skipped where sudo asks for a password), and
// that can start a project command's sandbox (#713: bubblewrap, which machine.sh installs; ci-slow's real-users job
// runs a check that runs git there).
const canSudoNobody = process.platform !== 'win32' && spawnSync('sudo', ['-n', '-u', 'nobody', 'true']).status === 0;
const nobodySandbox = canSudoNobody && (process.platform !== 'linux' || spawnSync('sudo', ['-n', '-u', 'nobody', '/usr/bin/bwrap', '--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0);

test('regression: a check that runs git, run as the agent user in the coordinator\'s checkout, gets git\'s answer (not "dubious ownership")', { skip: !nobodySandbox && 'needs passwordless sudo to another user that can start bubblewrap' }, () => {
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
