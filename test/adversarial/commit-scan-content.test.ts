// The commit secret scan (#971), third round: the content it reads is placed as a line diff places added lines, the
// content never decides whether a file is read, a file git stores differently from its working-tree bytes refuses the
// commit, the commit's own files never configure the scanner, and no line runs a program the model can't name.
// Scratch checkouts, a test token and a fake key only; real gitleaks, as test/install.test.ts uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import * as secrets from '../../src/scan/secrets.js';
import { repoRoot } from '../helpers.js';

const hasGitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const skip = !hasGitleaks && 'gitleaks not installed';

const TOKEN = `${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8`;
const SECRET = `export const token = '${TOKEN}';\n`;
const B64 = [
  'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
  'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK',
  'LxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo',
  '9z+40RQzuVaE8AkAFmxZzow3x+VJYKdjykkJ0iT9wCS0DRTXu269V264Vf/3jvre',
  'dZBMpZ0dg3SXqNZAqTVDw9EqmDyTgKgqHLDoUcXaS5kzRZ8FIIKhVm9PXGMTLv',
];
const KEY_BEGIN = `${'-----BEGIN'} RSA PRIVATE KEY-----`;
const KEY_END = `${'-----END'} RSA PRIVATE KEY-----`;
const KEY = `${KEY_BEGIN}\n${B64.join('\n')}\n${KEY_END}\n`;
const FOUND = /gitleaks found a secret in this commit/;
const UNMODELLED = /the commit secret scan can't (tell what this command line commits|read this command line)/;
const NOT_RUN = /commit secret scan could not run/;

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });

function checkout(name = 'a'): string {
  const d = join(mkdtempSync(join(tmpdir(), `${name}-`)), name);
  mkdirSync(d, { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, 'notes.md'), 'notes\n');
  writeFileSync(join(d, 'config.js'), 'export const x = 1;\n');
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

async function refused(cwd: string, command: string, why: RegExp, what = command) {
  const d = await decide(cwd, command);
  assert.equal(d.decision, 'deny', `refused: ${JSON.stringify(what)}`);
  assert.match(d.reason, why, JSON.stringify(what));
}

test('the line diff marks the lines a shortest edit inserts, wherever else they appear', () => {
  const addedLines = (secrets as Record<string, unknown>).addedLines as ((a: string[], b: string[]) => boolean[]) | undefined;
  assert.equal(typeof addedLines, 'function', 'the scan computes its own line diff');
  const f = addedLines!;
  assert.deepEqual(f(['a', 'b', 'c'], ['a', 'b', 'c']), [false, false, false]);
  assert.deepEqual(f(['a', 'c'], ['a', 'b', 'c']), [false, true, false]);
  assert.deepEqual(f(['B', 'p', 'E'], ['B', 'p', 'E', 'B', 'k', 'E']), [false, false, false, true, true, true]);
  assert.deepEqual(f(['x', 's'], ['x', 's', 's']), [false, false, true]);
  assert.deepEqual(f([], ['a']), [true]);
  assert.deepEqual(f(['a', 'b'], ['b']), [false]);
});

test('attack: lines a secret needs as context are scanned where they are added, even if the file had them before', { skip }, async () => {
  const placeholder = `${KEY_BEGIN}\nplaceholder\n${KEY_END}\n`;
  const a = checkout();
  writeFileSync(join(a, 'keys.md'), placeholder);
  git(a, 'add', 'keys.md');
  git(a, 'commit', '-q', '-m', 'placeholder');
  appendFileSync(join(a, 'keys.md'), KEY);
  git(a, 'add', 'keys.md');
  await refused(a, 'git commit -m x', FOUND, 'staged key block');
  const w = checkout('w');
  writeFileSync(join(w, 'keys.md'), placeholder);
  git(w, 'add', 'keys.md');
  git(w, 'commit', '-q', '-m', 'placeholder');
  appendFileSync(join(w, 'keys.md'), KEY);
  await refused(w, 'git commit -am x', FOUND, 'working-tree key block');
  const s = checkout('s');
  writeFileSync(join(s, 'config.js'), SECRET);
  git(s, 'add', 'config.js');
  git(s, 'commit', '-q', '-m', 'old');
  appendFileSync(join(s, 'config.js'), SECRET);
  git(s, 'add', 'config.js');
  await refused(s, 'git commit -m x', FOUND, 'a secret line added again');
});

test('attack: no content decides whether the scanner reads a file', { skip }, async () => {
  const pad = (n: number) => Buffer.alloc(n, 0x41);
  const heads: [string, Buffer][] = [
    ['pdf', Buffer.from('%PDF-1.4\n')], ['zip', Buffer.from('PK\x03\x04\n', 'latin1')], ['elf', Buffer.from('\x7fELF\n', 'latin1')],
    ['gzip', Buffer.from('\x1f\x8b\x08\n', 'latin1')], ['exe', Buffer.from('MZ\n')], ['class', Buffer.from('\xca\xfe\xba\xbe\n', 'latin1')],
    ['sqlite', Buffer.from('SQLite format 3\x00\n', 'latin1')], ['xz', Buffer.from('\xfd7zXZ\x00\n', 'latin1')], ['bz2', Buffer.from('BZh\n')],
    ['rar', Buffer.from('Rar!\x1a\x07\x00\n', 'latin1')], ['tar', Buffer.concat([pad(257), Buffer.from('ustar\n')])],
    ['iso', Buffer.concat([pad(32769), Buffer.from('CD001\n')])],
  ];
  for (const [what, head] of heads) {
    const a = checkout();
    writeFileSync(join(a, 'data.js'), Buffer.concat([head, Buffer.from(SECRET)]));
    git(a, 'add', 'data.js');
    await refused(a, 'git commit -m x', FOUND, `new file, ${what}`);
  }
  const m = checkout('m');
  appendFileSync(join(m, 'config.js'), `%PDF-1.4\n${SECRET}`);
  git(m, 'add', 'config.js');
  await refused(m, 'git commit -m x', FOUND, 'a changed file whose first new line is a signature, staged');
  const w = checkout('w');
  appendFileSync(join(w, 'config.js'), `%PDF-1.4\n${SECRET}`);
  await refused(w, 'git commit -am x', FOUND, 'the same, in the working tree');
  const u = checkout('u');
  writeFileSync(join(u, 'new.js'), `%PDF-1.4\n${SECRET}`);
  await refused(u, 'git add -A && git commit -m x', FOUND, 'the same, untracked');
});

test('attack: a working-tree file git would store as other bytes refuses the commit', { skip }, async () => {
  for (const attr of ['*.js working-tree-encoding=IBM037', '*.js filter=conv']) {
    const a = checkout();
    writeFileSync(join(a, '.git', 'info', 'attributes'), `${attr}\n`);
    git(a, 'config', 'filter.conv.clean', 'cat');
    writeFileSync(join(a, 'config.js'), 'export const y = 2;\n');
    await refused(a, 'git commit -am x', NOT_RUN, `${attr}, tracked`);
    const u = checkout('u');
    writeFileSync(join(u, '.git', 'info', 'attributes'), `${attr}\n`);
    git(u, 'config', 'filter.conv.clean', 'cat');
    writeFileSync(join(u, 'new.js'), 'export const y = 2;\n');
    await refused(u, 'git add -A && git commit -m x', NOT_RUN, `${attr}, untracked`);
    const s = checkout('s');
    writeFileSync(join(s, '.git', 'info', 'attributes'), `${attr}\n`);
    git(s, 'config', 'filter.conv.clean', 'cat');
    writeFileSync(join(s, 'ok.js'), 'export const ok = 1;\n');
    execFileSync('git', ['-C', s, '-c', 'filter.conv.clean=cat', 'add', 'ok.js'], { stdio: 'ignore' });
    // WHY (round 4): a filter the config names is a program git may run while reading changes, so it refuses even a
    // staged change; an encoding attribute alone doesn't, and a staged change is read from the index, as stored.
    if (attr.includes('filter')) await refused(s, 'git commit -m x', NOT_RUN, `${attr}, staged`);
    else assert.equal((await decide(s, 'git commit -m x')).decision, 'allow', `${attr}: a staged change is read from the index, as stored`);
  }
});

test('attack: the commit\'s own files never configure the scanner', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, 'config.js'), SECRET);
  const ignores = ['config.js:github-pat:1', 'config.js:github-pat:65537', 'config.js:github-pat:65538'].join('\n');
  writeFileSync(join(a, '.gitleaksignore'), `${ignores}\n`);
  git(a, 'add', 'config.js', '.gitleaksignore');
  await refused(a, 'git commit -m x', FOUND, 'an ignore list staged with the secret');
});

test('attack: a line that runs a program the model can\'t name, or feeds a shell text, is refused', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, 'config.js'), SECRET);
  for (const c of [
    '$(echo g)it commit -am x', '/usr/bin/g?t commit -am x', 'x=it; g$x commit -am x', '( $(echo g)it commit -am x )',
    'if true; then $(echo g)it commit -am x; fi', 'echo commit | xargs -I% git % -am x', 'printf commit | xargs -I@ git @ -am x',
    "env -S 'git commit -am x'", 'echo git commit -am x | sh', 'gh ex git commit -am x', "man -P 'git commit -am x' git",
    'timeout 5 $X commit -am x', 'echo git commit -am x | sudo bash', "bash <<'EOF'\ngit commit -am x\nEOF", 'bash -c "$S"',
    "find . -name config.js -exec git '{}' \\;", 'if true; then git commit -am x; fi',
  ]) await refused(a, c, UNMODELLED);
});

test('ordinary work with literal program names is not refused', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, 'ok.js'), 'export const ok = 1;\n');
  git(a, 'add', 'ok.js');
  for (const c of [
    'ls -la && cat notes.md | head -3',
    'bash -c \'echo hi\'',
    'bash scripts/x.sh > out.log 2>&1',
    'echo hi | grep h',
    'git log --oneline | head -5 && git commit -m x',
    "python3 - <<'EOF'\nprint(*[1, 2])\nEOF",
    'timeout 60 git status',
  ]) assert.equal((await decide(a, c)).decision, 'allow', c);
});
