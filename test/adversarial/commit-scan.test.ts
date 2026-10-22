// The commit secret scan (#971): before an agent's command commits, the guard scans exactly what that commit will
// record, in the checkout it lands in, for every commit form it lets through; a form it can't model is refused.
// Each attack below stages, writes or commits a test token in a scratch checkout and must be refused by the commit
// scan itself (its reason, not another guardrail's). Real gitleaks, as test/install.test.ts uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import { exampleProject } from '../helpers.js';

// WHY (#971, round 6): the host's own git config (system and user) must not change what these tests see.
const GIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gitconfig-'));
writeFileSync(join(GIT_CONFIG_DIR, 'config'), '');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(GIT_CONFIG_DIR, 'config');

const hasGitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const skip = !hasGitleaks && 'gitleaks not installed';

const TOKEN = `${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8`;
const SECRET = `export const token = '${TOKEN}';\n`;
const FOUND = /gitleaks found a secret in this commit/;
const UNMODELLED = /the commit secret scan can't (tell what this command line commits|read this command line)/;

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });

/** A project (the hook's checkout) and a second checkout beside it, both with a committed tracked file. */
function setup(): { dir: string; other: string; env: NodeJS.ProcessEnv } {
  const { dir } = exampleProject();
  const other = mkdtempSync(join(tmpdir(), 'other-'));
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'config', 'user.email', 'ada@example.com');
  git(other, 'config', 'user.name', 'Ada');
  git(other, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(other, 'notes.md'), 'notes\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'init');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'notes.md'), 'notes\n');
  writeFileSync(join(dir, 'notes.md'), 'notes\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'notes');
  const env = { HOME: mkdtempSync(join(tmpdir(), 'home-')), [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: mkdtempSync(join(tmpdir(), 'state-')) };
  return { dir, other, env };
}

async function decide(env: NodeJS.ProcessEnv, cwd: string, command: string, agent = true): Promise<{ decision: string; reason: string }> {
  const r = await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } }, agent ? { ...env, [`${BRAND.envPrefix}_AGENT`]: '1' } : env);
  assert.equal(r.exitCode, 0, r.stderr);
  if (!r.stdout) return { decision: 'allow', reason: '' };
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return { decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason };
}

/** Refused because the scan found the token in what the commit records. */
async function refusedByScan(env: NodeJS.ProcessEnv, cwd: string, command: string) {
  const d = await decide(env, cwd, command);
  assert.equal(d.decision, 'deny', `refused: ${command}`);
  assert.match(d.reason, FOUND, `refused by the commit scan: ${command}`);
}

/** Refused because the commit scan can't model what the command line commits. */
async function refusedUnmodelled(env: NodeJS.ProcessEnv, cwd: string, command: string) {
  const d = await decide(env, cwd, command);
  assert.equal(d.decision, 'deny', `refused: ${command}`);
  assert.match(d.reason, UNMODELLED, `refused by the commit scan as unmodelled: ${command}`);
}

test('attack: a commit aimed at another checkout is scanned there', { skip }, async () => {
  const { dir, other, env } = setup();
  writeFileSync(join(other, 'config.js'), SECRET);
  git(other, 'add', 'config.js');
  await refusedByScan(env, dir, `git -C ${other} commit -m x`);
  await refusedByScan(env, dir, `cd ${other} && git commit -m x`);
});

test('attack: a commit run from a folder inside the checkout covers the whole checkout', { skip }, async () => {
  const { dir, env } = setup();
  writeFileSync(join(dir, 'config.js'), SECRET);
  git(dir, 'add', 'config.js');
  await refusedByScan(env, join(dir, 'docs'), 'git commit -m x');
  await refusedByScan(env, join(dir, 'docs'), `git -C ${dir} commit -m x`);
  await refusedByScan(env, join(dir, 'docs'), 'git -C .. commit -m x');
});

test('attack: a commit that takes working-tree content by path is scanned on that content', { skip }, async () => {
  const { dir, env } = setup();
  writeFileSync(join(dir, 'notes.md'), SECRET);
  for (const c of ['git commit -m x notes.md', 'git commit -o -m x notes.md', 'git commit --only -m x -- notes.md', 'git commit -i -m x notes.md', 'git commit --include -m x notes.md', 'git commit --onl -m x notes.md', 'git commit -F README.md notes.md', 'git commit -qm x notes.md', 'git commit --pathspec-from-file=- -m x']) {
    await refusedByScan(env, dir, c);
  }
});

test('spellings of committing all tracked changes stay scanned on them', { skip }, async () => {
  const { dir, env } = setup();
  writeFileSync(join(dir, 'notes.md'), SECRET);
  for (const c of ['git commit -a -m x', 'git commit --no-edit --all -m x', 'git commit -sam x', 'git commit -m x -a']) await refusedByScan(env, dir, c);
});

test('attack: an amend is scanned on the commit it rewrites', { skip }, async () => {
  const { dir, env } = setup();
  writeFileSync(join(dir, 'config.js'), SECRET);
  git(dir, 'add', 'config.js');
  git(dir, 'commit', '-q', '-m', 'unscanned');
  await refusedByScan(env, dir, 'git commit --amend --no-edit');
  await refusedByScan(env, dir, 'git commit --am -C HEAD');
});

test('attack: content staged earlier in the same line is scanned', { skip }, async () => {
  const { dir, env } = setup();
  writeFileSync(join(dir, 'config.js'), SECRET);
  await refusedByScan(env, dir, 'git add -A && git commit -m x');
  await refusedByScan(env, dir, 'git add config.js; git commit -m x');
});

test('attack: content written earlier in the same line is refused, as the scan runs before it exists', { skip }, async () => {
  const { dir, env } = setup();
  await refusedUnmodelled(env, dir, `echo "${TOKEN}" >> notes.md && git commit -a -m x`);
  await refusedUnmodelled(env, dir, `cp notes.md n2.md && git add -A && git commit -m x`);
  await refusedUnmodelled(env, dir, `x=$(cat <<'E'\nit's\nE\n); git commit -a -m y`);
  await refusedUnmodelled(env, dir, `git commit -a -m "$(echo "${TOKEN}" >> notes.md)"`);
});

test('attack: a commit run where the model cannot follow it is refused', { skip }, async () => {
  const { dir, other, env } = setup();
  writeFileSync(join(other, 'config.js'), SECRET);
  git(other, 'add', 'config.js');
  for (const c of [
    `bash -c 'cd ${other} && git commit -m x'`,
    `GIT_DIR=${other}/.git GIT_WORK_TREE=${other} git commit -m x`,
    `git --git-dir=${other}/.git --work-tree=${other} commit -m x`,
    `env -C ${other} git commit -m x`,
    `D=${other}; cd $D && git commit -m x`,
    `(cd ${other} && git commit -m x)`,
  ]) await refusedUnmodelled(env, dir, c);
});

test('attack: a git alias for commit is followed', { skip }, async () => {
  const { dir, env } = setup();
  git(dir, 'config', 'alias.ci', 'commit');
  writeFileSync(join(dir, 'config.js'), SECRET);
  git(dir, 'add', 'config.js');
  await refusedUnmodelled(env, dir, 'git ci -m x');
});

test('plain commits keep their behaviour: clean ones pass, a staged secret is refused, people are not scanned', { skip }, async () => {
  const { dir, env } = setup();
  writeFileSync(join(dir, 'ok.js'), 'export const x = 1;\n');
  git(dir, 'add', 'ok.js');
  // WHY: an unstaged secret is not part of a plain commit, so it must not refuse one.
  writeFileSync(join(dir, 'notes.md'), SECRET);
  for (const c of [
    'git commit -m wip',
    `git commit -m "$(cat <<'EOF'\nfix: don't (really) break\n\ngit commit -a was not used here\nEOF\n)"`,
    `git commit -m "$(cat <<'EOF'\nfeat: thing\nEOF\n)" && git push && gh pr create --title t --body "$(cat <<'EOF'\nRun \`git commit -a\` then push.\nEOF\n)"`,
    'git commit -s -m wip 2>&1 | tail -3',
    `cd ${join(dir, 'docs')} && git commit -m wip`,
  ]) assert.equal((await decide(env, dir, c)).decision, 'allow', c);
  writeFileSync(join(dir, 'config.js'), SECRET);
  git(dir, 'add', 'config.js');
  await refusedByScan(env, dir, 'git commit -m wip');
  assert.equal((await decide(env, dir, 'git commit -m wip', false)).decision, 'allow', 'people opt in with a git hook instead');
});
