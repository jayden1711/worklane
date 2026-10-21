// The commit secret scan (#971), fourth round: added lines are scanned wherever a diff could place them, the commit's
// files can never be read as the scanner's own files, a working-tree file git stores as other bytes refuses the commit,
// a checkout whose config names a program git runs while reading changes refuses it too, and ordinary test commands and
// xargs runs are not mistaken for unreadable ones. Scratch checkouts, a test token and fake keys only; real gitleaks,
// as test/install.test.ts uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const ROWS = [
  'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
  'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK',
  'LxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo',
  '9z+40RQzuVaE8AkAFmxZzow3x+VJYKdjykkJ0iT9wCS0DRTXu269V264Vf/3jvre',
  'dZBMpZ0dg3SXqNZAqTVDw9EqmDyTgKgqHLDoUcXaS5kzRZ8FIIKhVm9PXGMTLv',
];
const BEGIN = `${'-----BEGIN'} RSA PRIVATE KEY-----`;
const END = `${'-----END'} RSA PRIVATE KEY-----`;
const key = (...rows: number[]) => `${BEGIN}\n${rows.map((r) => ROWS[r]).join('\n')}\n${END}\n`;
const KEY_A = key(0, 1);
const KEY_B = key(2, 3);
const KEY_C = key(4, 1);
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

test('every placement a diff could give a run of added lines is scanned', () => {
  const widen = (secrets as Record<string, unknown>).slideWidened as ((b: string[], added: boolean[]) => boolean[]) | undefined;
  assert.equal(typeof widen, 'function', 'the scan widens each run of added lines');
  const b = ['B', 'p1', 'p2', 'E', 'B', 'r1', 'r2', 'E', 'B', 'q1', 'q2', 'E'];
  const one = [false, false, false, false, false, true, true, true, true, false, false, false];
  assert.deepEqual(widen!(b, one), [false, false, false, true, true, true, true, true, true, false, false, false]);
  assert.deepEqual(widen!(['x', 'a', 'x'], [false, true, false]), [false, true, false], 'a run that cannot slide stays as it is');
  assert.deepEqual(widen!(['a', 'a', 'a'], [false, false, true]), [true, true, true], 'it slides as far as the lines repeat');
});

test('attack: a multi-line secret is found whichever placement a diff gives its lines', { skip }, async () => {
  const shapes: [string, string, string][] = [
    ['a key added between two others, with blank lines', `${KEY_A}\n${KEY_B}`, `${KEY_A}\n${KEY_C}\n${KEY_B}`],
    ['a key added between two adjacent ones', `${KEY_A}${KEY_B}`, `${KEY_A}${KEY_C}${KEY_B}`],
    ['a key added before an empty pair', `${BEGIN}\n${END}\n`, `${KEY_C}${BEGIN}\n${END}\n`],
  ];
  for (const [what, before, after] of shapes) {
    const a = checkout();
    writeFileSync(join(a, 'keys.md'), before);
    git(a, 'add', 'keys.md');
    git(a, 'commit', '-q', '-m', 'before');
    writeFileSync(join(a, 'keys.md'), after);
    git(a, 'add', 'keys.md');
    await refused(a, 'git commit -m x', FOUND, `${what}, staged`);
    const w = checkout('w');
    writeFileSync(join(w, 'keys.md'), before);
    git(w, 'add', 'keys.md');
    git(w, 'commit', '-q', '-m', 'before');
    writeFileSync(join(w, 'keys.md'), after);
    await refused(w, 'git commit -am x', FOUND, `${what}, working tree`);
  }
});

test('attack: no file of the commit can stand in for a file the scanner reads at its root', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, '.gitleaksignore'), SECRET);
  writeFileSync(join(a, '.gitleaksignore.content'), 'nothing\n');
  git(a, 'add', '.gitleaksignore', '.gitleaksignore.content');
  await refused(a, 'git commit -m x', FOUND, 'an ignore-list name and a near name, both staged');
  const g = checkout('g');
  writeFileSync(join(g, 'config.js'), SECRET);
  writeFileSync(join(g, 'commit'), 'a file named like the scan folder\n');
  git(g, 'add', 'config.js', 'commit');
  await refused(g, 'git commit -m x', FOUND, 'files named like the scan folder');
});

test('attack: a working-tree file with an ident attribute refuses the commit', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, '.git', 'info', 'attributes'), '*.sh ident\n');
  writeFileSync(join(a, 'run.sh'), 'echo one\n');
  git(a, 'add', 'run.sh');
  git(a, 'commit', '-q', '-m', 'run');
  writeFileSync(join(a, 'run.sh'), 'echo $Id: two $\n');
  await refused(a, 'git commit -am x', NOT_RUN, 'tracked');
  const u = checkout('u');
  writeFileSync(join(u, '.git', 'info', 'attributes'), '*.sh ident\n');
  writeFileSync(join(u, 'run.sh'), 'echo $Id: two $\n');
  await refused(u, 'git add -A && git commit -m x', NOT_RUN, 'untracked');
});

test('attack: a checkout whose config names a program git runs while reading changes refuses the commit', { skip }, async () => {
  const program = (d: string) => {
    const p = join(d, '..', 'prog.sh');
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
    return p;
  };
  const cases: [string, (d: string) => void, string][] = [
    ['a file-system monitor, working-tree commit', (d) => git(d, 'config', 'core.fsmonitor', program(d)), 'git commit -am x'],
    ['a file-system monitor, read before a staged commit', (d) => git(d, 'config', 'core.fsmonitor', program(d)), 'git status && git commit -m x'],
    ['a file-system monitor, read before a working-tree commit', (d) => git(d, 'config', 'core.fsmonitor', program(d)), 'git status && git commit -am x'],
    ['an external diff program', (d) => git(d, 'config', 'diff.external', program(d)), 'git diff && git commit -am x'],
    ['a text conversion driver', (d) => {
      git(d, 'config', 'diff.hide.textconv', program(d));
      writeFileSync(join(d, '.git', 'info', 'attributes'), '*.md diff=hide\n');
    }, 'git diff && git commit -am x'],
    ['a filter a file uses', (d) => {
      git(d, 'config', 'filter.f.clean', program(d));
      writeFileSync(join(d, '.git', 'info', 'attributes'), '*.md filter=f\n');
    }, 'git status && git commit -m x'],
  ];
  for (const [what, set, line] of cases) {
    const a = checkout();
    writeFileSync(join(a, 'notes.md'), 'edit\n');
    git(a, 'add', 'notes.md');
    set(a);
    await refused(a, line, NOT_RUN, what);
  }
  const off = checkout('off');
  git(off, 'config', 'core.fsmonitor', 'false');
  writeFileSync(join(off, 'ok.js'), 'export const ok = 1;\n');
  git(off, 'add', 'ok.js');
  assert.equal((await decide(off, 'git status && git commit -m x')).decision, 'allow', 'a monitor turned off names no program');
});

test('ordinary test commands and xargs runs are not mistaken for programs the model can\'t name', { skip }, async () => {
  const a = checkout();
  for (const c of [
    '[ -f package.json ] && echo yes',
    '[[ -f package.json ]] && echo yes',
    '[ -d node_modules ] || echo no',
    'if [ -n "$X" ]; then echo yes; fi',
    'i=0; while [ "$i" -lt 3 ]; do i=$((i+1)); done',
    'grep -rl foo . | xargs grep -il todo',
    'ls | xargs grep -i todo',
    'grep -rl foo . | xargs -0 sed -n 1p',
  ]) assert.equal((await decide(a, c)).decision, 'allow', c);
  for (const c of ['ls | xargs -I{} cp {} out/', 'ls | xargs -n 1 -I % cp % out/']) await refused(a, c, UNMODELLED);
});
