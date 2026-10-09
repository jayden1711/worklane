import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { doctor } from '../src/doctor.js';
import { HOOK_MARKER, install } from '../src/install.js';
import { engineCli, exampleProject, repoRoot } from './helpers.js';
import { childEnv, which } from '../src/os/index.js';

const isWindows = process.platform === 'win32';
/**
 * Claude Code runs shell-form hooks with sh on macOS/Linux and Git Bash on
 * Windows (https://code.claude.com/docs/en/hooks), so the tests do too.
 * PATH's bash.exe on Windows may be the WSL launcher, so use Git's directly.
 */
const hookShell = isWindows ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'sh';

interface Settings {
  hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  permissions: { allow: string[]; deny?: string[] };
}
const settingsOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as Settings;

/** Run a hook command exactly as Claude Code would: through the shell, JSON on stdin. */
function runHookCommand(command: string, dir: string, stateDir: string, input: object, env: Record<string, string> = {}) {
  return spawnSync(hookShell, ['-c', command], {
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
  for (const event of ['PreToolUse', 'SessionStart', 'SessionEnd']) {
    const ours = s.hooks[event]!.filter((e) => e.hooks.some((h) => h.command.includes(HOOK_MARKER)));
    assert.equal(ours.length, 1, `${event} installed once`);
    assert.match(ours[0]!.hooks[0]!.command, /\|\| exit 2;/);
  }
  assert.ok(s.permissions.allow.includes('Bash(make:*)'));
  assert.ok(s.permissions.allow.includes('Bash(npm test:*)'));
  assert.ok(s.permissions.allow.includes('WebFetch(domain:docs.github.com)'));
  const deny = s.permissions.deny ?? [];
  assert.ok(deny.includes('Read(~/.ssh/**)') && deny.includes('Read(~/.railway/**)'));
  assert.ok(!deny.includes('Read(./.env)'), 'humans may still read .env; agents are stopped by the hook');
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
    for (const name of ['config', 'guardrails', 'hook PreToolUse', 'hook SessionStart', 'hook SessionEnd', 'fingerprints prod-db']) {
      assert.equal(checks.find((c) => c.name === name)?.level, 'ok', name);
    }
  } finally {
    delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
  }
});

const hookCmd = (dir: string, event: string) => settingsOf(dir).hooks[event]!.find((e) => e.hooks[0]!.command.includes(HOOK_MARKER))!.hooks[0]!.command;

function readdirOne(dir: string): string {
  return readdirSync(dir)[0]!;
}

test('installed PreToolUse hook: agents get full guardrails, humans only the dangerous-action rules', () => {
  const { dir, stateDir } = exampleProject();
  install({ root: dir, engineCli });
  spawnSync(process.execPath, [engineCli, 'guardrails', 'refresh', '--root', dir], { env: { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir } });
  const cmd = hookCmd(dir, 'PreToolUse');
  const call = (tool: string, toolInput: object, agent: boolean) =>
    runHookCommand(cmd, dir, stateDir, { hook_event_name: 'PreToolUse', cwd: dir, tool_name: tool, tool_input: toolInput }, agent ? { [`${BRAND.envPrefix}_AGENT`]: '1' } : {});
  const decision = (r: ReturnType<typeof call>) => (r.stdout ? (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision : 'none');

  const prodSql = { command: "psql postgres://app:example-prod-password@db.internal:5432/app -c 'delete from orders'" };
  for (const agent of [true, false]) {
    const r = call('Bash', prodSql, agent);
    assert.equal(r.status, 0);
    assert.equal(decision(r), 'deny', `prod DB blocked (agent=${agent})`);
    assert.match(r.stdout, /prod-db-connection/);
  }
  assert.equal(decision(call('Bash', { command: 'npm test' }, true)), 'none', 'no decision: the normal permission flow continues');
  const harnessEdit = { file_path: join(dir, '.worklane', 'guardrails.yaml') };
  assert.equal(decision(call('Edit', harnessEdit, true)), 'deny');
  assert.equal(decision(call('Edit', harnessEdit, false)), 'none', 'humans may edit harness config');
  assert.equal(decision(call('WebFetch', { url: 'https://unlisted.example/' }, true)), 'deny');
  assert.equal(decision(call('WebFetch', { url: 'https://unlisted.example/' }, false)), 'none', 'no domain allowlist for humans');
});

test('missing engine: agent sessions block; human sessions get a one-line warning and continue', () => {
  const { dir, stateDir } = exampleProject();
  install({ root: dir, engineCli: join(dir, 'node_modules', 'gone', 'cli.js') });
  const agent = { [`${BRAND.envPrefix}_AGENT`]: '1' };
  for (const event of ['PreToolUse', 'SessionStart']) {
    const cmd = hookCmd(dir, event);
    assert.match(cmd, /\$CLAUDE_PROJECT_DIR\/node_modules\/gone\/cli\.js/);
    const input = { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } };
    assert.equal(runHookCommand(cmd, dir, stateDir, input, agent).status, 2, `${event} blocks agents`);
    const human = runHookCommand(cmd, dir, stateDir, input);
    assert.equal(human.status, 0, `${event} lets humans continue`);
    if (event === 'SessionStart') {
      const out = JSON.parse(human.stdout) as { systemMessage: string };
      assert.match(out.systemMessage, /run npm install to enable/);
    } else assert.equal(human.stdout, '');
  }
  assert.ok(doctor(dir).some((c) => c.name === 'hook PreToolUse' && c.level === 'fail'));
});

test('agent commits are secret-scanned before they happen', { skip: !which('gitleaks') && 'gitleaks not installed' }, () => {
  const { dir, stateDir } = exampleProject();
  install({ root: dir, engineCli });
  const cmd = hookCmd(dir, 'PreToolUse');
  const commit = (agent: boolean) =>
    runHookCommand(cmd, dir, stateDir, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'git commit -m wip' } }, agent ? { [`${BRAND.envPrefix}_AGENT`]: '1' } : {});
  writeFileSync(join(dir, 'src', 'ok.js'), 'export const x = 1;\n');
  spawnSync('git', ['add', 'src/ok.js'], { cwd: dir });
  assert.equal(commit(true).stdout, '', 'clean commit proceeds');
  writeFileSync(join(dir, 'src', 'config.js'), `export const token = '${'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}';\n`);
  spawnSync('git', ['add', 'src/config.js'], { cwd: dir });
  const r = commit(true);
  assert.match(r.stdout, /"permissionDecision":"deny"/);
  assert.match(r.stdout, /gitleaks found a secret/);
  assert.equal(commit(false).stdout, '', 'humans opt in to commit scanning with a git hook instead');
});

test('install references the project-local engine even when it is a symlink', { skip: isWindows && 'symlinks need privileges on Windows' }, () => {
  const { dir } = exampleProject();
  mkdirSync(join(dir, 'node_modules', '@worklane'), { recursive: true });
  symlinkSync(join(engineCli, '..', '..', '..'), join(dir, 'node_modules', '@worklane', 'cli'));
  install({ root: dir });
  const cmd = hookCmd(dir, 'PreToolUse');
  assert.match(cmd, /"\$CLAUDE_PROJECT_DIR\/node_modules\/@worklane\/cli\/dist\/src\/cli\.js"/);
});

test('install --engine points the hooks at a machine-wide engine path', () => {
  const { dir } = exampleProject();
  const r = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), 'install', '--root', dir, '--engine', '/opt/engine/current/dist/src/cli.js'], { encoding: 'utf8', env: childEnv() });
  assert.equal(r.status, 0, r.stderr);
  const settings = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8');
  assert.match(settings, /\/opt\/engine\/current\/dist\/src\/cli\.js/);
});
