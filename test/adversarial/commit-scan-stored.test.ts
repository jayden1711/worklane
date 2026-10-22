// The commit secret scan (#971), round 6: under the standard large-file filter the bytes git stores are always scanned
// (a pointer's object as well, never instead), only the exactly named `lfs` driver and no other large-file setting gets
// that allowance, a configured diff or signature program refuses any read that may run it, and a nested checkout the
// line stages is checked like a submodule. Scratch checkouts and a test token only; real gitleaks, as
// test/install.test.ts uses it. Large files are set up by hand, so no filter program runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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

/** Store `content` in the checkout's large-file store; its pointer text. */
function lfsObject(d: string, content: string): string {
  const oid = createHash('sha256').update(content).digest('hex');
  const dir = join(d, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, oid), content);
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(content)}\n`;
}

/** Stage `bytes` at `path` exactly as given (no filter runs), and write them to disk too. */
function stageRaw(d: string, path: string, bytes: string) {
  const blob = gitIn(d, bytes, 'hash-object', '-w', '--stdin');
  git(d, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
  writeFileSync(join(d, path), bytes);
}

const configure = (d: string, config: [string, string][]) => {
  for (const [k, v] of config) git(d, 'config', k, v);
};

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

const program = () => {
  const p = join(mkdtempSync(join(tmpdir(), 'prog-')), 'prog.sh');
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
};

test('attack: stored bytes that only begin like a large-file pointer are scanned as stored', { skip }, async () => {
  // A blob staged before the attribute existed, then the attribute written on disk only.
  const a = checkout();
  configure(a, STANDARD);
  stageRaw(a, 'a.txt', `${lfsObject(a, 'plain data\n')}${SECRET}`);
  writeFileSync(join(a, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  // WHY (round 7): such bytes, small and naming a pointer version, now refuse before the scan; either way, refused.
  const STORED = /gitleaks found a secret in this commit|commit secret scan could not run/;
  await refused(a, 'git commit -m x', STORED, 'attribute on disk only');
  // The attribute committed first, the blob staged by hand with an old file time.
  const c = checkout('c');
  configure(c, STANDARD);
  writeFileSync(join(c, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(c, 'add', '.gitattributes');
  git(c, 'commit', '-q', '-m', 'attributes');
  stageRaw(c, 'a.txt', `${lfsObject(c, 'plain data\n')}${SECRET}`);
  utimesSync(join(c, 'a.txt'), new Date(0), new Date(0));
  await refused(c, 'git commit -m x', STORED, 'attribute committed first');
});

test('attack: a filter whose name matches the large-file one only without case gets no allowance', { skip }, async () => {
  const a = checkout();
  configure(a, STANDARD.map(([k, v]): [string, string] => [k.replace('filter.lfs.', 'filter.LFS.'), v]));
  writeFileSync(join(a, '.gitattributes'), '*.txt filter=LFS -text\n');
  git(a, 'add', '.gitattributes');
  git(a, 'commit', '-q', '-m', 'attributes');
  stageRaw(a, 'data.txt', lfsObject(a, SECRET));
  await refused(a, 'git commit -m x', NOT_RUN);
});

test('attack: a pointer in the working tree, staged in the line, is read with the object it names', { skip }, async () => {
  const a = checkout();
  configure(a, STANDARD);
  writeFileSync(join(a, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(a, 'add', '.gitattributes');
  git(a, 'commit', '-q', '-m', 'attributes');
  writeFileSync(join(a, 'n.txt'), lfsObject(a, SECRET));
  await refused(a, 'git add n.txt && git commit -m x', FOUND);
});

test('attack: any large-file setting outside the short safe list takes the allowance away', { skip }, async () => {
  const a = checkout();
  configure(a, [...STANDARD, ['lfs.extension.x.clean', 'cat %f'], ['lfs.extension.x.smudge', 'cat %f'], ['lfs.extension.x.priority', '0']]);
  writeFileSync(join(a, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(a, 'add', '.gitattributes');
  git(a, 'commit', '-q', '-m', 'attributes');
  stageRaw(a, 'data.txt', lfsObject(a, 'plain data\n'));
  await refused(a, 'git commit -m x', NOT_RUN, 'an extension program');
  const b = checkout('b');
  configure(b, [...STANDARD, ['lfs.url', 'https://example.com/lfs']]);
  writeFileSync(join(b, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(b, 'add', '.gitattributes');
  git(b, 'commit', '-q', '-m', 'attributes');
  stageRaw(b, 'data.txt', lfsObject(b, 'plain data\n'));
  assert.equal((await decide(b, 'git commit -m x')).decision, 'allow', 'a safe setting keeps it');
});

test('attack: with a diff program configured, any read that may show a diff refuses the commit', { skip }, async () => {
  for (const line of ['git log --pretty -p -1 && git commit -m x', 'git status -bv && git commit -m x', 'git status --verb && git commit -m x', 'git status -vb && git commit -m x', 'git log -n 1 && git commit -m x']) {
    const a = checkout();
    git(a, 'config', 'diff.hide.textconv', program());
    writeFileSync(join(a, '.git', 'info', 'attributes'), '*.md diff=hide\n');
    writeFileSync(join(a, 'notes.md'), 'edit\n');
    git(a, 'add', 'notes.md');
    await refused(a, line, NOT_RUN);
  }
  const ok = checkout('ok');
  git(ok, 'config', 'diff.hide.textconv', program());
  writeFileSync(join(ok, 'notes.md'), 'edit\n');
  git(ok, 'add', 'notes.md');
  assert.equal((await decide(ok, 'git status -sb && git log --oneline -3 && git commit -m x')).decision, 'allow');
});

test('attack: with a signature program configured, any log or show before a commit refuses it', { skip }, async () => {
  const setups: [string, (d: string) => void][] = [
    ['a default format that shows signatures', (d) => git(d, 'config', 'format.pretty', 'format:%h %G?')],
    ['a named format that shows them', (d) => git(d, 'config', 'pretty.sig', 'format:%h %G?')],
    ['a show-signature setting git reads as true', (d) => git(d, 'config', 'log.showSignature', '2')],
  ];
  for (const [what, set] of setups) {
    const a = checkout();
    git(a, 'config', 'gpg.program', program());
    set(a);
    writeFileSync(join(a, 'notes.md'), 'edit\n');
    git(a, 'add', 'notes.md');
    await refused(a, what.includes('named') ? 'git log -1 --pretty=sig && git commit -m x' : 'git log -1 && git commit -m x', NOT_RUN, what);
  }
});

test('attack: with a diff filter configured, an interactive staging step before a commit refuses it', { skip }, async () => {
  const a = checkout();
  git(a, 'config', 'interactive.diffFilter', program());
  writeFileSync(join(a, 'notes.md'), 'edit\n');
  // WHY (round 7): interactive staging before a commit is now refused outright, whatever the config.
  await refused(a, 'echo y | git add -p notes.md && git commit -am x', /commit secret scan could not run|the commit secret scan can't tell what this command line commits/);
});

test('attack: a nested checkout the line stages is checked like a submodule', { skip }, async () => {
  const a = checkout();
  const sub = join(a, 'sub');
  mkdirSync(sub);
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'config', 'user.email', 'ada@example.com');
  git(sub, 'config', 'user.name', 'Ada');
  git(sub, 'commit', '-q', '--allow-empty', '-m', 'sub');
  git(sub, 'config', 'core.fsmonitor', program());
  await refused(a, 'git add sub && git commit -am x', NOT_RUN);
});
