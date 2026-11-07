// The commit secret scan (#971), round 7: under the standard large-file filter, a small large file that names a pointer
// version in any spelling but isn't the exact pointer form refuses the commit; an object that isn't a regular file
// refuses with its reason; and interactive staging or committing in the line is refused whatever the config. Scratch
// checkouts and a test token only; real gitleaks, as test/install.test.ts uses it. No filter program runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { runHook } from '../../src/hook.js';
import { repoRoot } from '../helpers.js';

// WHY: the host's own git config (system and user) must not change what these tests see.
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
const UNMODELLED = /the commit secret scan can't (tell what this command line commits|read this command line)/;
const STANDARD: [string, string][] = [
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.required', 'true'],
];

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });
const gitIn = (cwd: string, input: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { input, encoding: 'utf8' }).trim();

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

/** A checkout under the standard large-file filter for *.txt, with an object holding the token in its store. */
function lfsCheckout(): { d: string; oid: string; size: number } {
  const d = checkout();
  for (const [k, v] of STANDARD) git(d, 'config', k, v);
  writeFileSync(join(d, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(d, 'add', '.gitattributes');
  git(d, 'commit', '-q', '-m', 'attributes');
  const oid = createHash('sha256').update(SECRET).digest('hex');
  const dir = join(d, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, oid), SECRET);
  return { d, oid, size: Buffer.byteLength(SECRET) };
}

/** Stage `bytes` at `path` exactly as given (no filter runs), and write them to disk too. */
function stageRaw(d: string, path: string, bytes: string) {
  const blob = gitIn(d, bytes, 'hash-object', '-w', '--stdin');
  git(d, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
  writeFileSync(join(d, path), bytes);
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

test('attack: a large file in any pointer spelling but the exact one refuses the commit', { skip }, async () => {
  const spellings: [string, (oid: string, size: number) => string][] = [
    ['another version name', (o, n) => `version https://hawser.github.com/spec/v1\noid sha256:${o}\nsize ${n}\n`],
    ['an older version name', (o, n) => `version http://git-media.io/v/2\noid sha256:${o}\nsize ${n}\n`],
    ['carriage returns', (o, n) => `version https://git-lfs.github.com/spec/v1\r\noid sha256:${o}\r\nsize ${n}\r\n`],
    ['a leading blank line', (o, n) => `\nversion https://git-lfs.github.com/spec/v1\noid sha256:${o}\nsize ${n}\n`],
    ['a trailing blank line', (o, n) => `version https://git-lfs.github.com/spec/v1\noid sha256:${o}\nsize ${n}\n\n`],
    ['a size with a leading zero', (o, n) => `version https://git-lfs.github.com/spec/v1\noid sha256:${o}\nsize 0${n}\n`],
    ['an extension line', (o, n) => `version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${'0'.repeat(64)}\noid sha256:${o}\nsize ${n}\n`],
    ['no final newline', (o, n) => `version https://git-lfs.github.com/spec/v1\noid sha256:${o}\nsize ${n}`],
  ];
  for (const [what, spell] of spellings) {
    const { d, oid, size } = lfsCheckout();
    stageRaw(d, 'a.txt', spell(oid, size));
    await refused(d, 'git commit -m x', NOT_RUN, `staged, ${what}`);
  }
  const { d, oid, size } = lfsCheckout();
  writeFileSync(join(d, 'n.txt'), `version https://hawser.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`);
  await refused(d, 'git add n.txt && git commit -m x', NOT_RUN, 'untracked, another version name');
  const exact = lfsCheckout();
  stageRaw(exact.d, 'a.txt', `version https://git-lfs.github.com/spec/v1\noid sha256:${exact.oid}\nsize ${exact.size}\n`);
  await refused(exact.d, 'git commit -m x', FOUND, 'the exact form, read with its object');
});

test('attack: a large-file object that is not a regular file refuses the commit with its reason', { skip }, async () => {
  const d = checkout();
  for (const [k, v] of STANDARD) git(d, 'config', k, v);
  writeFileSync(join(d, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(d, 'add', '.gitattributes');
  git(d, 'commit', '-q', '-m', 'attributes');
  const oid = 'a'.repeat(64);
  mkdirSync(join(d, '.git', 'lfs', 'objects', 'aa', 'aa', oid), { recursive: true });
  stageRaw(d, 'a.txt', `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 5\n`);
  await refused(d, 'git commit -m x', /not a regular file/);
});

test('attack: interactive staging or committing in the line is refused, whatever the config', { skip }, async () => {
  const a = checkout();
  writeFileSync(join(a, 'notes.md'), 'edit\n');
  assert.equal((await decide(a, 'git add notes.md && git commit -am x')).decision, 'allow', 'plain staging');
  for (const c of [
    'git add -e notes.md && git commit -am x', 'git add --edit notes.md && git commit -am x',
    'echo e | git add -p notes.md && git commit -am x', 'echo q | git add -i && git commit -m x',
    'echo y | git add --patch notes.md && git commit -m x', 'echo y | git commit -p -m x', 'echo q | git commit --interactive -m x',
  ]) await refused(a, c, UNMODELLED);
});
