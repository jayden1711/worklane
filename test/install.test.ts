import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { doctor } from '../src/doctor.js';
import { HOOK_MARKER, install } from '../src/install.js';
import { engineCli, exampleProject } from './helpers.js';

const unixShell = process.platform !== 'win32';

interface Settings {
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  permissions: { allow: string[]; deny?: string[] };
}
const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as Settings;

/** Run a hook command exactly as Claude Code would: through the shell, JSON on stdin. */
function runHookCommand(command: string, dir: string, stateDir: string, input: object, env: Record<string, string> = {}) {
  return spawnSync('sh', ['-c', command], {
    cwd: dir,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir, ...env },
  });
}

test('install merges hooks into existing settings, keeps the project entries, and is idempotent', () => {
  const { dir } = exampleProject();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(make:*)'] }, hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] } }),
  );
  install({ root: dir, engineCli });
  install({ root: dir, engineCli });
  const s = settingsOf(dir) as Settings & { model: string };
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.PostToolUse![0]!.hooks[0]!.command, 'prettier --write');
  for (const event of ['PreToolUse', 'Stop', 'SessionEnd']) {
    const ours = s.hooks[event]!.filter((e) => e.hooks.some((h) => h.command.includes(HOOK_MARKER)));
    assert.equal(ours.length, 1, `${event} installed once`);
    assert.match(ours[0]!.hooks[0]!.command, /\|\| exit 2$/);
  }
  assert.ok(s.permissions.allow.includes('Bash(make:*)'));
  assert.ok(s.permissions.allow.includes('Bash(npm test:*)'));
  assert.ok(s.permissions.allow.includes('WebFetch(domain:docs.github.com)'));
  const deny = s.permissions.deny ?? [];
  assert.ok(deny.includes('Read(~/.ssh/**)') && deny.includes('Read(./.env)'));
  assert.equal(new Set(deny).size, deny.length, 'no duplicates after re-install');
});

test('install scaffolds config from templates when none exists, then refuses to proceed until it is valid', () => {
  const { dir } = exampleProject();
  rmSync(join(dir, BRAND.configDir), { recursive: true });
  const r = install({ root: dir, engineCli });
  assert.equal(r.scaffolded, true);
  assert.ok(existsSync(join(dir, BRAND.configDir, 'guardrails.yaml')));
  // Template placeholders are valid but flagged by doctor.
  assert.ok(doctor(dir).some((c) => c.name === 'owners' && c.level === 'warn'));
});

test('doctor passes on a fresh install of the example, after a fingerprint refresh', () => {
  const { dir, stateDir } = exampleProject();
  process.env[`${BRAND.envPrefix}_STATE_DIR`] = stateDir;
  try {
    install({ root: dir, engineCli });
    const refresh = spawnSync(process.execPath, [engineCli, 'guardrails', 'refresh', '--root', dir], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(refresh.status, 0, refresh.stdout + refresh.stderr);
    assert.doesNotMatch(readFileSync(join(stateDir, 'projects', readdirOne(join(stateDir, 'projects')), 'fingerprints.json'), 'utf8'), /example-prod-password/);
    const checks = doctor(dir);
    const fails = checks.filter((c) => c.level === 'fail' && !['gitleaks', 'claude'].includes(c.name));
    assert.deepEqual(fails, []);
    for (const name of ['config', 'guardrails', 'hook PreToolUse', 'hook Stop', 'hook SessionEnd', 'fingerprints prod-db']) {
      assert.equal(checks.find((c) => c.name === name)?.level, 'ok', name);
    }
  } finally {
    delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
  }
});

function readdirOne(dir: string): string {
  return readdirSync(dir)[0]!;
}

test('installed PreToolUse hook denies agent prod access and stays silent for safe calls', { skip: !unixShell && 'hook commands run under sh' }, () => {
  const { dir, stateDir } = exampleProject();
  install({ root: dir, engineCli });
  spawnSync(process.execPath, [engineCli, 'guardrails', 'refresh', '--root', dir], { env: { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir } });
  const cmd = settingsOf(dir).hooks.PreToolUse!.find((e) => e.hooks[0]!.command.includes(HOOK_MARKER))!.hooks[0]!.command;
  const call = (command: string, agent: boolean) =>
    runHookCommand(cmd, dir, stateDir, { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command } }, agent ? { [`${BRAND.envPrefix}_AGENT`]: '1' } : {});

  const prod = call("psql postgres://app:example-prod-password@db.internal:5432/app -c 'delete from orders'", true);
  assert.equal(prod.status, 0);
  const out = JSON.parse(prod.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /prod-db-connection/);

  const safe = call('npm test', true);
  assert.equal(safe.status, 0);
  assert.equal(safe.stdout, '', 'no decision: the normal permission flow continues');

  const edit = runHookCommand(cmd, dir, stateDir, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, '.worklane', 'guardrails.yaml') } });
  assert.equal((JSON.parse(edit.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'ask', 'humans are asked');
});

test('hooks fail closed: a missing engine blocks (exit 2) instead of allowing', { skip: !unixShell && 'hook commands run under sh' }, () => {
  const { dir, stateDir } = exampleProject();
  install({ root: dir, engineCli: join(dir, 'node_modules', 'gone', 'cli.js') });
  for (const event of ['PreToolUse', 'Stop']) {
    const cmd = settingsOf(dir).hooks[event]!.find((e) => e.hooks[0]!.command.includes(HOOK_MARKER))!.hooks[0]!.command;
    assert.match(cmd, /\$CLAUDE_PROJECT_DIR\/node_modules\/gone\/cli\.js/);
    const r = runHookCommand(cmd, dir, stateDir, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(r.status, 2, event);
  }
  assert.ok(doctor(dir).some((c) => c.name === 'hook PreToolUse' && c.level === 'fail'));
});

test('installed Stop hook blocks an agent until done_when passes', { skip: !unixShell && 'hook commands run under sh' }, () => {
  const { dir, stateDir } = exampleProject();
  install({ root: dir, engineCli });
  const cmd = settingsOf(dir).hooks.Stop![0]!.hooks[0]!.command;
  const task = join(stateDir, 'task.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(task, JSON.stringify({ id: 'issue-1', done_when: [{ test: 'test/price.test.js' }] }));
  const pass = runHookCommand(cmd, dir, stateDir, { cwd: dir, stop_hook_active: false }, { [`${BRAND.envPrefix}_TASK_FILE`]: task });
  assert.equal(pass.status, 0);
  assert.equal(pass.stdout, '');

  writeFileSync(join(dir, 'src', 'price.js'), readFileSync(join(dir, 'src', 'price.js'), 'utf8').replace('cents * qty', 'cents + qty'));
  const fail = runHookCommand(cmd, dir, stateDir, { cwd: dir }, { [`${BRAND.envPrefix}_TASK_FILE`]: task });
  assert.equal(fail.status, 0);
  const out = JSON.parse(fail.stdout) as { decision: string; reason: string };
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /done_when not met/);
});
