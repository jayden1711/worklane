// The commit secret scan's second layer (#983): the engine's pre-commit hook scans the index git is committing, by
// content, whatever the command line was and whatever ran before it in the commit; and the tool guard refuses each way
// an agent's line could skip that hook. Scratch checkouts and a test token only; real gitleaks and git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import { childEnv } from '../../src/os/index.js';
import { GIT_GUARD_VAR } from '../../src/os/git.js';
import { commitHookSkipped } from '../../src/scan/secrets.js';
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

/**
 * A checkout with the project's config and a tracked config.js; `before` is a pre-commit hook it had before install,
 * `env` the environment install runs in.
 */
function checkout(before?: string, env: NodeJS.ProcessEnv = childEnv()): string {
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
  const r = spawnSync(process.execPath, [cli, 'install', '--root', d, '--git-hooks-only'], { encoding: 'utf8', env });
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

test('the skip forms the tool guard models are refused: the skip flags, hooks-path config, includes and hook-file changes', { skip }, async () => {
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
    'git config include.path /tmp/other',
    'git config --global includeIf.onbranch:main.path /tmp/other',
    'echo exit 0 > .git/hooks/pre-commit',
    'chmod -x .git/hooks/pre-commit',
    'chmod 644 .git/hooks/pre-commit',
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

test('a commit or push in a command string a runner or shell runs is judged as a command line, and refused when unread', { skip }, async () => {
  const d = checkout();
  for (const command of [
    "setsid bash -c 'git commit -q -n -m x'",
    "flock /tmp/l -c 'git commit -q --no-verify -m x'",
    "flock -w 5 /tmp/l --command 'git commit -n -m x'",
    "find . -maxdepth 0 -exec sh -c 'git commit -n -m x' \\;",
    "runuser -u nobody -- bash -c 'git commit -n -m x'",
    "nice -n 5 setsid sh -c 'git commit -n -m x'",
    'setsid bash -c "$X"',
    "watch -n1 'git commit -n -m x'",
    "su -c 'git commit -n -m x'",
    "git rebase -x 'git commit --amend -n --no-edit' HEAD~1",
    "setsid bash -c 'git push --no-verify'",
  ]) assert.equal(await decide(d, 'Bash', { command }), 'deny', command);
  // WHY: the controls: a runner's ordinary command, and git named only in a message, stay allowed.
  for (const command of [
    'setsid true',
    "flock /tmp/l -c 'npm test'",
    "setsid bash -c 'git status'",
    "find . -name '*.ts' -exec sh -c 'wc -l \"$1\"' _ {} \\;",
    'git commit -m "fix: git commit -n handling"',
    "gh pr create --title t --body 'never run git commit -n'",
  ]) assert.notEqual(await decide(d, 'Bash', { command }), 'deny', command);
});

test('a commit git would make without the engine\'s pre-commit hook is refused: an include that moves the hooks, or a hook not executable', { skip }, async () => {
  const d = checkout();
  writeFileSync(join(d, 'ok.js'), 'export const y = 2;\n');
  git(d, 'add', 'ok.js');
  assert.notEqual(await decide(d, 'Bash', { command: 'git commit -m x' }), 'deny', 'control: the engine hook is the one git runs');
  const included = join(mkdtempSync(join(tmpdir(), 'include-')), 'hooks.inc');
  writeFileSync(included, `[core]\n\thooksPath = ${mkdtempSync(join(tmpdir(), 'no-hooks-'))}\n`);
  for (const key of ['include.path', 'includeIf.onbranch:main.path']) {
    git(d, 'config', key, included);
    assert.equal(await decide(d, 'Bash', { command: 'git commit -m x' }), 'deny', key);
    git(d, 'config', '--unset', key);
  }
  const hook = join(d, '.git', 'hooks', 'pre-commit');
  chmodSync(hook, 0o644);
  assert.equal(await decide(d, 'Bash', { command: 'git commit -m x' }), 'deny', 'a hook git would skip');
  chmodSync(hook, 0o755);
  assert.notEqual(await decide(d, 'Bash', { command: 'git commit -m x' }), 'deny', 'control: executable again');
});

test('the hook fails the commit when its scan can\'t run, when the hook it chains fails, and outside a checkout', { skip }, () => {
  // A scan that can't run: no gitleaks on the commit's PATH nor in the engine's tools dir.
  const prefix = mkdtempSync(join(tmpdir(), 'prefix-'));
  const d = checkout(undefined, { ...childEnv(), [`${BRAND.envPrefix}_PREFIX`]: prefix });
  writeFileSync(join(d, 'ok.js'), 'export const y = 2;\n');
  git(d, 'add', 'ok.js');
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  symlinkSync(gitBin, join(bin, 'git'));
  const was = head(d);
  const r = spawnSync(gitBin, ['-C', d, 'commit', '-q', '-m', 'unscanned'], { encoding: 'utf8', env: { ...process.env, ...agentEnv(), PATH: bin, [`${BRAND.envPrefix}_PREFIX`]: prefix } });
  assert.notEqual(r.status, 0, 'a commit whose scan could not run is refused');
  assert.match(r.stderr, /could not run/);
  assert.equal(head(d), was, 'nothing was committed');

  // A chained hook that fails fails the commit, though the scan would pass.
  const c = checkout('#!/bin/sh\nexit 3\n');
  writeFileSync(join(c, 'ok.js'), 'export const y = 2;\n');
  git(c, 'add', 'ok.js');
  const before = head(c);
  assert.notEqual(commit(c, '-m', 'chained fails').status, 0, 'the chained hook\'s failure fails the commit');
  assert.equal(head(c), before, 'nothing was committed');

  // No checkout where the hook runs: refused, never passed.
  const outside = mkdtempSync(join(tmpdir(), 'no-checkout-'));
  const h = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'hook-main.js'), 'pre-commit'], { cwd: outside, input: '', encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(h.status, 1, h.stderr);
  assert.match(h.stderr, /no checkout found/);
});

test("R124d: in a process marked as an instance's, whose git reads no global config, which hook a commit runs can't be said, so it is refused", { skip: process.platform === 'win32' && 'POSIX hooks' }, () => {
  const d = checkout();
  assert.equal(commitHookSkipped(d), null, 'unmarked: the engine hook is the one git runs');
  const before = process.env[GIT_GUARD_VAR];
  process.env[GIT_GUARD_VAR] = d;
  try {
    assert.match(commitHookSkipped(d) ?? '', /reads no global config \(it runs for an instance\), so it can't say which pre-commit hook a commit here would run/);
  } finally {
    if (before === undefined) delete process.env[GIT_GUARD_VAR];
    else process.env[GIT_GUARD_VAR] = before;
  }
});

test('R1124f D1: index entries whose names land on one file when written out (not UTF-8, a case pair) are each scanned: the secret is refused', { skip }, () => {
  // Staged by plumbing, as the index holds them (names a macOS file system can't hold need no working-tree file).
  const stage = (d: string, entries: [Buffer, string][]) => {
    const lines = entries.map(([name, body]) => {
      const blob = execFileSync('git', ['-C', d, 'hash-object', '-w', '--stdin'], { input: body, encoding: 'utf8' }).trim();
      return Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.from([0])]);
    });
    execFileSync('git', ['-C', d, 'update-index', '-z', '--index-info'], { input: Buffer.concat(lines) });
  };
  for (const [what, entries] of [
    // Both decode to "�.js"; git lists \xfe first, so the secret is the one a second write would overwrite.
    ['two names that are not UTF-8', [[Buffer.from([0xfe, 0x2e, 0x6a, 0x73]), SECRET], [Buffer.from([0xff, 0x2e, 0x6a, 0x73]), 'export const y = 2;\n']]],
    // One file on a case-insensitive file system (macOS); two on Linux, where this case passes either way.
    ['a case pair', [[Buffer.from('Key.js'), SECRET], [Buffer.from('key.js'), 'export const y = 2;\n']]],
  ] as [string, [Buffer, string][]][]) {
    const d = checkout();
    stage(d, entries);
    const was = head(d);
    const r = commit(d, '-m', 'wip');
    assert.notEqual(r.status, 0, `${what}: the commit is refused`);
    assert.match(r.stderr, /secret/i, what);
    assert.equal(head(d), was, `${what}: nothing was committed`);
  }
});

test("R1124f D2: an alias for commit is read as git reads it, quotes and global options first, so `git <alias> -n` is refused", { skip }, async () => {
  for (const value of ['-p commit', '"commit"', "'commit'", '--no-pager "commit"', '-c user.name=x commit', 'com"mit"']) {
    const d = checkout();
    // Set as a person sets it (an agent's own alias write is refused already).
    git(d, 'config', 'alias.ci', value);
    assert.equal(await decide(d, 'Bash', { command: 'git ci -n -m x' }), 'deny', value);
  }
  // An option the guard doesn't step over, or an unbalanced quote: refused too (fail closed).
  for (const value of ['--weird commit', '"commit']) {
    const d = checkout();
    git(d, 'config', 'alias.ci', value);
    assert.equal(await decide(d, 'Bash', { command: 'git ci -m x' }), 'deny', value);
  }
  // The control: an alias for another command is no commit.
  const d = checkout();
  git(d, 'config', 'alias.lg', '-p log --oneline');
  assert.notEqual(await decide(d, 'Bash', { command: 'git lg -n 3' }), 'deny', 'an alias for log');
});

test('R1124f D3: with help.autocorrect on, a misspelt command git corrects to commit is refused; with it off, it is no commit', { skip }, async () => {
  for (const value of ['1', '10', 'immediate', 'prompt']) {
    const d = checkout();
    git(d, 'config', 'help.autocorrect', value);
    assert.equal(await decide(d, 'Bash', { command: 'git comit -n -m x' }), 'deny', `help.autocorrect ${value}`);
  }
  // Given on the command line: refused as an alias given there is.
  assert.equal(await decide(checkout(), 'Bash', { command: 'git -c help.autocorrect=1 comit -n -m x' }), 'deny', 'on the command line');
  // The controls: autocorrect off runs nothing (git says it isn't a command), and a real commit isn't refused for it.
  for (const value of ['0', 'never', 'show']) {
    const d = checkout();
    git(d, 'config', 'help.autocorrect', value);
    assert.notEqual(await decide(d, 'Bash', { command: 'git comit -m x' }), 'deny', `help.autocorrect ${value}`);
    assert.notEqual(await decide(d, 'Bash', { command: 'git commit -m x' }), 'deny', `a real commit, help.autocorrect ${value}`);
  }
});

// R1124g, R1124h: what the file system makes one file, and what git reads as config or an alias, beyond D1-D3.
// Folding and case-insensitive names collide only where the scan's temp dir is on such a file system (macOS APFS);
// CI runs Linux only, so these two run on macOS.
const skipFold = skip || (process.platform !== 'darwin' && 'needs a case-insensitive, normalisation-insensitive tmpdir (macOS APFS)');
const stageIndex = (d: string, entries: [Buffer, string][]) => {
  const lines = entries.map(([name, body]) => {
    const blob = execFileSync('git', ['-C', d, 'hash-object', '-w', '--stdin'], { input: body, encoding: 'utf8' }).trim();
    return Buffer.concat([Buffer.from(`100644 ${blob}\t`), name, Buffer.from([0])]);
  });
  execFileSync('git', ['-C', d, 'update-index', '-z', '--index-info'], { input: Buffer.concat(lines) });
};

test('R1124g/R1124h 1: names APFS folds alike that no lower-casing pairs (long s, sharp s, micro sign, final sigma, beta symbol) are each scanned', { skip: skipFold }, () => {
  const got: Record<string, string> = {};
  for (const [a, b] of [['s', 'ſ'], ['ss', 'ß'], ['μ', 'µ'], ['σ', 'ς'], ['β', 'ϐ']] as const) {
    // git lists entries by bytes: the first is the one a second write would overwrite, so it holds the secret.
    const [first, second] = Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
    const d = checkout();
    stageIndex(d, [[Buffer.from(`${first}.js`), SECRET], [Buffer.from(`${second}.js`), 'export const y = 2;\n']]);
    const was = head(d);
    const r = commit(d, '-m', 'wip');
    got[`${first}.js / ${second}.js`] = r.status !== 0 && head(d) === was ? 'refused' : 'committed';
  }
  assert.deepEqual(Object.values(got), Object.values(got).map(() => 'refused'), JSON.stringify(got));
});

test("R1124h 2: a case variant of the scanner's ignore file goes a folder lower, as the exact name does, so it ignores nothing", { skip: skipFold }, async () => {
  const d = checkout();
  writeFileSync(join(d, 'k.js'), SECRET);
  // The scan prefixes 65 536 newlines, so the secret is on line 65 537; gitleaks dir fingerprints are file:rule:line.
  writeFileSync(join(d, '.GITLEAKSIGNORE'), 'k.js:github-pat:65537\n');
  git(d, 'add', 'k.js', '.GITLEAKSIGNORE');
  assert.equal(await decide(d, 'Bash', { command: 'git commit -m wip' }), 'deny', 'the first layer');
  const was = head(d);
  assert.notEqual(commit(d, '-m', 'wip').status, 0, 'the hook');
  assert.equal(head(d), was, 'nothing committed');
});

test('R1124h 3: a name with a dot, which git may run as an alias in a subsection ([alias "Ci"] x = commit), is refused', { skip }, async () => {
  const d = checkout();
  writeFileSync(join(d, '.git', 'config'), `${readFileSync(join(d, '.git', 'config'), 'utf8')}[alias "Ci"]\n\tx = commit\n`);
  assert.equal(await decide(d, 'Bash', { command: 'git ci.x -n -m x' }), 'deny', 'git ci.x -n');
  assert.equal(await decide(d, 'Bash', { command: 'git CI.x -n -m x' }), 'deny', 'git CI.x -n');
});

test("R1124h 4 (as R124d): in a process marked as an instance's, a name that isn't git's own is refused, as its alias or correction can't be read", { skip }, async () => {
  const d = checkout();
  const was = process.env[GIT_GUARD_VAR];
  process.env[GIT_GUARD_VAR] = d;
  try {
    for (const line of ['git comit -n -m x', 'git ci -n -m x']) assert.equal(await decide(d, 'Bash', { command: line }), 'deny', line);
    // The control: git's own commands aren't looked up (a commit here is refused anyway, by R124d's check).
    for (const line of ['git status', 'git log -n 3']) assert.notEqual(await decide(d, 'Bash', { command: line }), 'deny', `the control: ${line}`);
  } finally {
    if (was === undefined) delete process.env[GIT_GUARD_VAR];
    else process.env[GIT_GUARD_VAR] = was;
  }
});

test('R1124h 5: a folder moved, copied or linked into a place git reads config from is a config write, and so is a file moved into one', { skip }, async () => {
  const d = checkout();
  const h = process.env.HOME!;
  for (const line of [
    `mv ${h}/.config/gx ${h}/.config/git`,
    `cp -r /tmp/x ${h}/.config/git`,
    `ln -s /tmp/x ${h}/.config/git`,
    `mv /tmp/x ${h}/.config`,
    `mv /tmp/.gitconfig ${h}`,
    `cp /tmp/config ${h}/.config/git/`,
    `mv -t ${h} /tmp/.gitconfig`,
    'mv /tmp/g .git',
    'cp -r /tmp/h .git/hooks',
    `(sleep 20; mv ${h}/.config/gx ${h}/.config/git) > /dev/null 2>&1 &`,
  ]) assert.equal(await decide(d, 'Bash', { command: line }), 'deny', line);
  // The controls: moving into an ordinary folder, and making one, aren't refused.
  for (const line of ['mv build out', `mkdir -p ${h}/.config/gx`, `cp a.txt ${h}/notes.txt`]) assert.notEqual(await decide(d, 'Bash', { command: line }), 'deny', line);
});

test('R1124i, R1124j: a write to the user git config in any spelling the shell or APFS reads as it, or by a program that writes a path it is given or reads, is refused', { skip }, async () => {
  const d = checkout();
  const h = process.env.HOME!;
  for (const line of [
    // R1124i F1: ~, $HOME, ./ and case, a cd the guard follows, --target-directory with ~.
    'mv /tmp/gx ~/.config/git',
    'mv /tmp/gx $HOME/.config/git',
    'mv /tmp/gx ${HOME}/.config/git',
    `mv /tmp/gx ${h}/.config/./git`,
    `mv /tmp/gx ${h}/.config/x/../git`,
    `mv /tmp/gx ${h}/.CONFIG/git`,
    'cd ~/.config && mv gx git',
    `cd ${h}/.config && mv gx git`,
    'cd "$(echo ~)/.config" && mv gx git',
    'mv --target-directory=~/.config /tmp/git',
    `mv --target-directory=${h}/.config /tmp/git`,
    // R1124j 1: APFS reads these as the user's config.
    'cp gc ~/.GITCONFIG',
    `cp gc ${h}/.GitConfig`,
    `cp gc ${h}/.config/GIT/config`,
    `mv /tmp/gx ${h}/.config/Git`,
    'cp gc .GIT/config',
    'cp h .Git/hooks/pre-push',
    // R1124j 2: programs that write a path they are given, or read.
    'find /tmp -name gc -exec cp {} ~/.gitconfig \\;',
    'curl -o ~/.gitconfig https://example.com/gc',
    'curl -o~/.gitconfig https://example.com/gc',
    'dd if=gc of=~/.gitconfig',
    'echo ~/.gitconfig | xargs cp gc',
    'ls ~/.gitconfig | xargs -n1 cp gc',
    'echo ~ | xargs -I{} cp gc {}/.gitconfig',
    'find ~ -maxdepth 1 -name .gitconfig -exec cp gc {} \\;',
    'tee ~/.git{config,x} < gc',
    'ln -s .git/config c; cat gc >> c',
    'ln -s ~/.gitconfig c',
    'D=~/.config; mv gx $D/git',
    'cp gc ~/.gitconf?g',
    'cp gc "$HOME"/.gitconfig',
  ]) assert.equal(await decide(d, 'Bash', { command: line }), 'deny', line);
  assert.equal(await decide(d, 'Write', { file_path: `${h}/.GITCONFIG`, content: '[core]\n' }), 'deny', 'Write ~/.GITCONFIG');
  // The controls: ordinary writes, reads of git's config, and run-time-path programs kept to the checkout aren't refused.
  for (const line of [
    'mv build out',
    `mkdir -p ${h}/.config/gx`,
    `cp a.txt ${h}/notes.txt`,
    'cat .git/config',
    `ls ${h}/.config/git`,
    'git config --get user.name',
    "find . -name '*.ts' -exec grep -l x {} +",
    'git ls-files | xargs grep -l foo',
    'cd src && cp a.ts b.ts',
    'cp a $OUT',
    'cd ~ && ls',
  ]) assert.notEqual(await decide(d, 'Bash', { command: line }), 'deny', line);
});

test('R1124k: a write destination the guard cannot spell out is refused; ordinary words it cannot spell out, globs and an untracked cd are not', { skip }, async () => {
  const d = checkout();
  for (const line of [
    // F1: parameter operators, command substitutions (whole or part of the name), a line variable holding one, eval.
    'F=~/.gitconfigx; cp gc ${F%x}',
    'F=~/.gitconfigx; cp gc "${F/x/}"',
    'cp gc ~/.gitconf$(echo ig)',
    "cp gc ~/$(printf '.git%s' config)",
    "F=$(printf '%s/.gitconfig' ~); cp gc $F",
    'cp gc ~/.gitconf`echo ig`',
    'tee ~/.gitconf$(echo ig) < gc',
    'curl -o ~/$(echo .gitconfig) https://example.com/x',
    'dd if=gc of=~/.gitconf${X:-ig}',
    'ln -s ~/.gitconf$(echo ig) c',
    'eval "cp gc ~/.gitconfig"',
    // Globs that can match a config name, as bash expands them.
    'cp gc ~/.gitconf[i]g',
    'cp gc ~/.git*',
    // A destination after a cd the guard can't follow is judged in the config folders too.
    'cd "$(echo ~)/.config" && cp gx config',
  ]) assert.equal(await decide(d, 'Bash', { command: line }), 'deny', line);
  // F2: ordinary work. A glob never matches a leading dot; a word with many variables or a substitution that isn't a
  // write destination is left alone; an ordinary argument after an untracked cd isn't read as a config folder; an
  // unbalanced bracket is a plain character.
  for (const line of [
    'rm -rf *',
    'tar czf out.tgz *',
    'npx prettier --write *',
    'echo "$A $B $C $D"',
    'curl "https://x/$A/$B/$C/$D?e=$E"',
    'make VERSION=$A.$B.$C.$D',
    'gh pr create --title t --body "$(cat body.md)"',
    'cd "$D" && make config',
    'grep -n "[" file.txt',
    'echo [ > out.txt',
  ]) assert.notEqual(await decide(d, 'Bash', { command: line }), 'deny', line);
});
