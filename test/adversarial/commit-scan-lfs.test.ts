// The commit secret scan (#971) and the standard large-file filter (owner's decision, 2026-10-21): a checkout whose
// large-file filter is exactly the standard one may commit, and the scan reads each large file's own bytes; any other
// filter config, or a large-file program that isn't a regular file, still refuses. The large files here are set up
// by hand (object in the store, pointer in the index), so no filter program runs. Real gitleaks, as
// test/install.test.ts uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import { repoRoot } from '../helpers.js';

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
const NOT_RUN = /commit secret scan could not run/;
const STANDARD: [string, string][] = [
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.required', 'true'],
];

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });
const gitOut = (cwd: string, input: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { input, encoding: 'utf8' }).trim();

/**
 * A checkout tracking *.txt as large files under `config`, with data.txt staged as a large file holding `content`.
 * WHY .txt: the scanner's default rules skip some binary-looking names whatever their content, on main too.
 */
function lfsCheckout(config: [string, string][], content: string, object = true): string {
  const d = join(mkdtempSync(join(tmpdir(), 'lfs-')), 'a');
  mkdirSync(d, { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(d, 'add', '.gitattributes');
  git(d, 'commit', '-q', '-m', 'init');
  for (const [k, v] of config) git(d, 'config', k, v);
  const oid = createHash('sha256').update(content).digest('hex');
  if (object) {
    const dir = join(d, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, oid), content);
  }
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(content)}\n`;
  const blob = gitOut(d, pointer, 'hash-object', '-w', '--stdin');
  git(d, 'update-index', '--add', '--cacheinfo', `100644,${blob},data.txt`);
  writeFileSync(join(d, 'data.txt'), content);
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

test('attack: a large file holding a secret, under the standard large-file filter, is found in its own bytes', { skip }, async () => {
  const d = await decide(lfsCheckout(STANDARD, SECRET), 'git commit -m x');
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, FOUND);
});

test('a clean large file under the standard large-file filter commits', { skip }, async () => {
  assert.equal((await decide(lfsCheckout(STANDARD, 'plain data\n'), 'git commit -m x')).decision, 'allow');
});

test('attack: a large-file filter that is not exactly the standard one still refuses', { skip }, async () => {
  const swap = (key: string, value: string) => STANDARD.map(([k, v]): [string, string] => [k, k === key ? value : v]);
  for (const [what, config] of [
    ['an extra argument', swap('filter.lfs.clean', 'git-lfs clean -- %f --extra')],
    ['a different program', swap('filter.lfs.process', 'other-lfs filter-process')],
    ['a custom clean', swap('filter.lfs.clean', 'cat')],
    ['not required', swap('filter.lfs.required', 'false')],
  ] as const) {
    const d = await decide(lfsCheckout(config, 'plain data\n'), 'git commit -m x');
    assert.equal(d.decision, 'deny', what);
    assert.match(d.reason, NOT_RUN, what);
  }
});

test('attack: a large-file pointer whose object is missing refuses, never scanned as the pointer', { skip }, async () => {
  const d = await decide(lfsCheckout(STANDARD, SECRET, false), 'git commit -m x');
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, NOT_RUN);
});

test('attack: a git-lfs on the path that is not a regular file refuses', { skip }, async () => {
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  mkdirSync(join(bin, 'git-lfs'));
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  try {
    const d = await decide(lfsCheckout(STANDARD, 'plain data\n'), 'git commit -m x');
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, NOT_RUN);
  } finally {
    process.env.PATH = path;
  }
});
