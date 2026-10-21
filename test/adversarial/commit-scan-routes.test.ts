// The commit secret scan (#971), second round: the checkout a commit lands in is one the model knows exactly or the
// line is refused; a git command it can't read is refused; and the scan reads what the commit records (its content),
// whatever the checkout's own git settings say about how to show it. Scratch checkouts and a test token only; real
// gitleaks, as test/install.test.ts uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import { repoRoot } from '../helpers.js';

const hasGitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const skip = !hasGitleaks && 'gitleaks not installed';

const TOKEN = `${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8`;
const SECRET = `export const token = '${TOKEN}';\n`;
const FOUND = /gitleaks found a secret in this commit/;
const UNMODELLED = /the commit secret scan can't (tell what this command line commits|read this command line)/;

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });

/** A checkout with the project's config, a tracked notes.md, config.js and sub/keep.md. */
function checkout(name: string): string {
  const d = join(mkdtempSync(join(tmpdir(), `${name}-`)), name);
  mkdirSync(join(d, 'sub'), { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, 'notes.md'), 'notes\n');
  writeFileSync(join(d, 'config.js'), 'export const x = 1;\n');
  writeFileSync(join(d, 'sub', 'keep.md'), 'keep\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}

const env = () => ({ HOME: mkdtempSync(join(tmpdir(), 'home-')), [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: mkdtempSync(join(tmpdir(), 'state-')), [`${BRAND.envPrefix}_AGENT`]: '1' });

async function decide(cwd: string, command: string): Promise<{ decision: string; reason: string }> {
  const r = await runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } }, env());
  assert.equal(r.exitCode, 0, r.stderr);
  if (!r.stdout) return { decision: 'allow', reason: '' };
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  return { decision: out.hookSpecificOutput.permissionDecision, reason: out.hookSpecificOutput.permissionDecisionReason };
}

async function refused(cwd: string, command: string, why: RegExp) {
  const d = await decide(cwd, command);
  assert.equal(d.decision, 'deny', `refused: ${JSON.stringify(command)}`);
  assert.match(d.reason, why, JSON.stringify(command));
}

test('attack: a commit from a project folder that is not a checkout is refused, never let through unscanned', { skip }, async () => {
  const outside = mkdtempSync(join(tmpdir(), 'plain-'));
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(outside, BRAND.configDir), { recursive: true });
  const b = checkout('b');
  writeFileSync(join(b, 'config.js'), SECRET);
  symlinkSync(join(b, 'sub'), join(outside, 'l'));
  await refused(outside, 'git commit -am x', UNMODELLED);
  await refused(outside, 'cd l/../sub && git commit -am x', UNMODELLED);
});

test('attack: a directory change the model cannot resolve exactly as the shell would is refused', { skip }, async () => {
  const a = checkout('a');
  const b = checkout('b');
  writeFileSync(join(b, 'sub', 'keep.md'), SECRET);
  writeFileSync(join(a, '.git', 'info', 'exclude'), 'lnk\nl\n');
  symlinkSync(join(b, 'sub'), join(a, 'lnk'));
  await refused(a, 'cd lnk/../sub && git commit -am x', UNMODELLED);
  await refused(a, 'cd -P lnk/.. && cd sub && git commit -am x', UNMODELLED);
  await refused(a, 'cd lnk && git commit -am x', UNMODELLED);
  await refused(a, 'cd - && git commit -am x', UNMODELLED);
  await refused(a, 'cd sub/.. && git commit -am x', UNMODELLED);
  const c = checkout('c');
  writeFileSync(join(b, 'config.js'), SECRET);
  git(b, 'add', 'config.js');
  symlinkSync(b, join(c, 'l'));
  git(c, 'add', 'l');
  git(c, 'commit', '-q', '-m', 'link');
  await refused(c, 'git mv l l2 && cd l2 && git commit -m x', UNMODELLED);
});

test('attack: a git command whose subcommand is not literal, or git run by another program without one, is refused', { skip }, async () => {
  const a = checkout('a');
  writeFileSync(join(a, 'config.js'), SECRET);
  for (const c of [
    'git $(echo commit) -am x', 'S=commit; git $S -am x', 'echo commit -am x | xargs git', 'git "$S" -am x', 'git "$(echo commit)" -am x',
    "git $'commit' -am x", 'git $"commit" -am x', 'git {commit,-a} -m x', 'git commi? -am x',
  ]) await refused(a, c, UNMODELLED);
});

test('attack: shell evaluation inside a git command\'s words is refused, whatever it would split into', { skip }, async () => {
  const a = checkout('a');
  writeFileSync(join(a, 'notes.md'), 'changed\n');
  writeFileSync(join(a, '.gitignore'), 'secret.env\n');
  writeFileSync(join(a, 'secret.env'), SECRET);
  for (const c of [
    'git commit -m $(echo x -a)', 'git commit -m x$IFS-a', 'git commit --date=now$IFS-a -m y', 'git commit -m ?otes.md',
    'git add notes.md$(echo " -f") secret.env && git commit -m x', 'git add notes.md$IFS-f secret.env && git commit -m x',
  ]) await refused(a, c, UNMODELLED);
});

test('ordinary work around a commit is not refused: read-only git before it, other git commands, quoted bodies', { skip }, async () => {
  const a = checkout('a');
  writeFileSync(join(a, 'ok.js'), 'export const ok = 1;\n');
  git(a, 'add', 'ok.js');
  for (const c of [
    'git diff --cached && git log -1 --oneline && git show --stat HEAD && git commit -m x',
    'git status && git diff && git commit -m "$(cat <<\'EOF\'\nfix: it\'s fine\nEOF\n)"',
    'cd sub && git frobnicate --version',
    'gh pr create --title t --body "$(cat <<EOF\nThis commit adds a check.\nEOF\n)"',
  ]) assert.equal((await decide(a, c)).decision, 'allow', c);
});

test('attack: the checkout\'s git settings for showing changes do not hide what a commit records', { skip }, async () => {
  const shapes: [string, (d: string) => void][] = [
    ['colour', (d) => git(d, 'config', 'color.diff', 'always')],
    ['no prefix', (d) => git(d, 'config', 'diff.noprefix', 'true')],
    ['mnemonic prefix', (d) => git(d, 'config', 'diff.mnemonicPrefix', 'true')],
    ['quoted paths', (d) => git(d, 'config', 'core.quotePath', 'false')],
    ['text conversion', (d) => {
      writeFileSync(join(d, '.git', 'info', 'attributes'), '*.js diff=hide\n');
      git(d, 'config', 'diff.hide.textconv', 'true');
    }],
    ['no diff attribute', (d) => writeFileSync(join(d, '.git', 'info', 'attributes'), '*.js -diff\n')],
    ['binary attribute', (d) => writeFileSync(join(d, '.git', 'info', 'attributes'), '*.js binary\n')],
    ['external diff', (d) => git(d, 'config', 'diff.external', 'true')],
  ];
  for (const [what, set] of shapes) {
    // WHY (round 4): a setting that names a program git runs while reading changes refuses the commit before the scan
    // reads anything; the others are found by the scan.
    const why = what === 'text conversion' || what === 'external diff' ? /commit secret scan could not run/ : FOUND;
    // Staged content, working-tree content, untracked content and the commit being amended: each route the scan has.
    const a = checkout('a');
    set(a);
    writeFileSync(join(a, 'config.js'), SECRET);
    git(a, 'add', 'config.js');
    await refused(a, 'git commit -m x', why);
    const w = checkout('w');
    set(w);
    writeFileSync(join(w, 'config.js'), SECRET);
    await refused(w, 'git commit -am x', why);
    const u = checkout('u');
    set(u);
    writeFileSync(join(u, 'new.js'), SECRET);
    await refused(u, 'git add -A && git commit -m x', why);
    const h = checkout('h');
    set(h);
    writeFileSync(join(h, 'config.js'), SECRET);
    git(h, 'add', 'config.js');
    git(h, 'commit', '-q', '-m', 'unscanned');
    await refused(h, 'git commit --amend --no-edit', why);
    assert.ok(true, what);
  }
});

test('the content scan keeps plain commits as they were: a clean change passes, a secret already committed is not new', { skip }, async () => {
  const a = checkout('a');
  writeFileSync(join(a, 'config.js'), SECRET);
  git(a, 'add', 'config.js');
  git(a, 'commit', '-q', '-m', 'old');
  writeFileSync(join(a, 'config.js'), `${SECRET}export const y = 2;\n`);
  git(a, 'add', 'config.js');
  assert.equal((await decide(a, 'git commit -m x')).decision, 'allow', 'only new lines are judged, as before');
  git(a, 'mv', 'notes.md', 'moved.md');
  assert.equal((await decide(a, 'git commit -m x')).decision, 'allow', 'a rename adds nothing');
});
