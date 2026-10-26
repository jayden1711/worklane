// The commit secret scan's second layer (#983): the engine's pre-commit hook scans the index git is committing, by
// content, whatever the command line was and whatever ran before it in the commit; and the tool guard refuses each way
// an agent's line could skip that hook. Scratch checkouts and a test token only; real gitleaks and git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import { childEnv } from '../../src/os/index.js';
import { repoRoot } from '../helpers.js';

// WHY: the host's own git config (system and user) must not change what these tests see.
const GIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gitconfig-'));
writeFileSync(join(GIT_CONFIG_DIR, 'config'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(GIT_CONFIG_DIR, 'config');

const hasGitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const skip = (process.platform === 'win32' && 'sh hooks (macOS and Linux)') || (!hasGitleaks && 'gitleaks not installed');

const TOKEN = `${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8`;
const SECRET = `export const token = '${TOKEN}';\n`;
const cli = join(repoRoot, 'dist', 'src', 'cli.js');

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const head = (d: string) => git(d, 'rev-parse', 'HEAD').trim();

const agentEnv = () => ({ HOME: mkdtempSync(join(tmpdir(), 'home-')), [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: mkdtempSync(join(tmpdir(), 'state-')), [`${BRAND.envPrefix}_AGENT`]: '1' });

/** A checkout with the project's config and a tracked config.js; `before` is a pre-commit hook it had before install. */
function checkout(before?: string): string {
  const d = join(mkdtempSync(join(tmpdir(), 'index-scan-')), 'w');
  mkdirSync(d, { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, 'config.js'), 'export const x = 1;\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  if (before) {
    writeFileSync(join(d, '.git', 'hooks', 'pre-commit'), before);
    chmodSync(join(d, '.git', 'hooks', 'pre-commit'), 0o755);
  }
  const r = spawnSync(process.execPath, [cli, 'install', '--root', d, '--git-hooks-only'], { encoding: 'utf8', env: childEnv() });
  assert.equal(r.status, 0, r.stderr);
  return d;
}

/** `git commit` as an agent's shell runs it, hooks and all. */
const commit = (d: string, ...a: string[]) => spawnSync('git', ['-C', d, 'commit', '-q', ...a], { encoding: 'utf8', env: { ...process.env, ...agentEnv() } });

async function decide(cwd: string, tool: string, input: Record<string, unknown>): Promise<string> {
  const r = await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd, tool_name: tool, tool_input: input }, agentEnv());
  assert.equal(r.exitCode, 0, r.stderr);
  if (!r.stdout) return 'allow';
  return (JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}

test('content a hook the commit chains stages after the guard has scanned is refused by the commit itself', { skip }, async () => {
  const d = checkout('#!/bin/sh\ngit add late.js\n');
  writeFileSync(join(d, 'late.js'), SECRET);
  writeFileSync(join(d, 'ok.js'), 'export const y = 2;\n');
  git(d, 'add', 'ok.js');
  assert.equal(await decide(d, 'Bash', { command: 'git commit -m wip' }), 'allow', 'the first layer sees a clean index');
  const was = head(d);
  const r = commit(d, '-m', 'wip');
  assert.notEqual(r.status, 0, 'the commit is refused');
  assert.match(r.stderr, /secret/i);
  assert.match(r.stderr, /late\.js/);
  assert.equal(head(d), was, 'nothing was committed');
});

test('a commit is scanned by what it stores, not by a diff the checkout\'s config renders', { skip }, () => {
  const d = checkout();
  writeFileSync(join(d, '.gitattributes'), 'k.js diff=hide\n');
  git(d, 'config', 'diff.hide.textconv', 'sed s/./x/g');
  git(d, 'add', '.gitattributes');
  git(d, 'commit', '-q', '-m', 'attributes');
  writeFileSync(join(d, 'k.js'), SECRET);
  git(d, 'add', 'k.js');
  const was = head(d);
  const r = commit(d, '-m', 'add k');
  assert.notEqual(r.status, 0, 'the commit is refused');
  assert.match(r.stderr, /k\.js/);
  assert.equal(head(d), was, 'nothing was committed');
});

test('a commit of named paths is scanned in the index git builds for it, not the staged one', { skip }, () => {
  const d = checkout();
  writeFileSync(join(d, 'config.js'), SECRET);
  const was = head(d);
  const r = commit(d, '-m', 'only', '--', 'config.js');
  assert.notEqual(r.status, 0, 'the commit is refused');
  assert.match(r.stderr, /config\.js/);
  assert.equal(head(d), was, 'nothing was committed');
  assert.equal(git(d, 'diff', '--cached', '--name-only'), '', 'the staged index is as it was');
});

test('a clean commit goes through the hook, and a hook it chains still runs', { skip }, () => {
  const d = checkout('#!/bin/sh\necho chained > chained.txt\n');
  writeFileSync(join(d, 'ok.js'), 'export const y = 2;\n');
  git(d, 'add', 'ok.js');
  const r = commit(d, '-m', 'clean');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(d, 'log', '-1', '--format=%s').trim(), 'clean');
  assert.equal(readFileSync(join(d, 'chained.txt'), 'utf8'), 'chained\n');
});

test('an existing secret already in HEAD is not refused again when an unrelated file is committed', { skip }, () => {
  const d = checkout();
  writeFileSync(join(d, 'config.js'), SECRET);
  git(d, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-am', 'a person commits it');
  writeFileSync(join(d, 'ok.js'), 'export const y = 2;\n');
  git(d, 'add', 'ok.js');
  const r = commit(d, '-m', 'unrelated');
  assert.equal(r.status, 0, r.stderr);
});

test('each way a line could skip the pre-commit hook is refused by the tool guard', { skip }, async () => {
  const d = checkout();
  for (const command of [
    'git commit -n -m x',
    'git commit --no-verify -m x',
    'git commit -m x --no-verify',
    'git commit --no-veri -m x',
    'git commit --no-v -m x',
    'git commit -anm x',
    'git commit -qn -m x',
    'git commit -sn -m x',
    'git commit --verify --no-verify -m x',
    'git commit --amend --no-edit -n',
    'git add -A && git commit -n -m x',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git -c core.hookspath= commit -m x',
    'git --config-env=core.hooksPath=H commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    `GIT_CONFIG_PARAMETERS="'core.hookspath'='/dev/null'" git commit -m x`,
    `export GIT_CONFIG_PARAMETERS="'core.hookspath'='/dev/null'"; git commit -m x`,
    'GIT_CONFIG_GLOBAL=/tmp/other git commit -m x',
    'git config core.hooksPath /dev/null',
    'git config --worktree core.hooksPath /tmp/h',
    'git config --local core.hooksPath /tmp/h',
    'echo exit 0 > .git/hooks/pre-commit',
    'printf x >> .git/hooks/pre-commit.before-' + BRAND.cli,
  ]) assert.equal(await decide(d, 'Bash', { command }), 'deny', command);
  for (const file_path of [join(d, '.git', 'hooks', 'pre-commit'), join(d, '.git', 'config')]) {
    assert.equal(await decide(d, 'Write', { file_path, content: '#!/bin/sh\nexit 0\n' }), 'deny', file_path);
  }
  // WHY: the controls: the hook asked for, or named only as text, is no skip.
  for (const command of ['git commit -m x', 'git commit --verify -m x', 'git commit -m "use --no-verify never"', 'git commit -s -m x']) {
    assert.notEqual(await decide(d, 'Bash', { command }), 'deny', command);
  }
});
