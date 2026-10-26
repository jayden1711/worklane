// The commit secret scan (#971) under the standard large-file filter: the cases the scan can't verify refuse (#1011).
// A file over 1024 bytes whose first 1024 bytes the large-file program reads as a pointer (it smudges to the object,
// the rest ignored: measured with git-lfs 3.4.1), and a git-lfs program someone other than root could change, or one
// git would look for on a path that depends on the folder, or none found. Scratch checkouts and a test token only;
// real gitleaks, as test/install.test.ts uses it. No filter program runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
const which = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim();
const LFS = which('git-lfs');
// The tests that need a git-lfs git may run (the scan lets the commit through) need root's own, as installers put it.
const rootsLfs = !!LFS && statSync(LFS).uid === 0 && !(statSync(LFS).mode & 0o022);
const skipLfs = skip || (!rootsLfs && 'no git-lfs of root\'s on PATH');
const skipRoot = skip || (process.getuid?.() === 0 && 'runs as root, whose own files are root\'s');

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

/** A checkout under the standard large-file filter for *.txt, with an object holding the token in its store. */
function lfsCheckout(): { d: string; pointer: string } {
  const d = join(mkdtempSync(join(tmpdir(), 'lfs-')), 'a');
  mkdirSync(d, { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(d, '.gitattributes'), '*.txt filter=lfs diff=lfs merge=lfs -text\n');
  git(d, 'add', '.gitattributes');
  git(d, 'commit', '-q', '-m', 'attributes');
  for (const [k, v] of STANDARD) git(d, 'config', k, v);
  const oid = createHash('sha256').update(SECRET).digest('hex');
  const dir = join(d, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, oid), SECRET);
  // A file that carries the filter, so git would run git-lfs here (untracked: staging it would run the real one).
  writeFileSync(join(d, 'plain.txt'), 'plain data\n');
  return { d, pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(SECRET)}\n` };
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

async function refused(cwd: string, command: string, why: RegExp, what: string) {
  const d = await decide(cwd, command);
  assert.equal(d.decision, 'deny', `refused: ${what}`);
  assert.match(d.reason, why, what);
}

/** Runs `body` with these variables set in this process (where the hook runs), then puts them back. */
async function withEnv(vars: Record<string, string>, body: () => Promise<void>) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A directory holding an executable `git-lfs` script of this user's. */
function ownLfs(): string {
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(bin, 'git-lfs'), '#!/bin/sh\nexec cat\n');
  chmodSync(join(bin, 'git-lfs'), 0o755);
  return bin;
}

test('attack: a file over 1024 bytes that begins as a pointer refuses the commit, staged or from disk', { skip }, async () => {
  const { d, pointer } = lfsCheckout();
  const padded = `${pointer}${'\n'.repeat(1100)}more data\n`;
  stageRaw(d, 'a.txt', padded);
  await refused(d, 'git commit -m x', NOT_RUN, 'staged, a pointer padded with blank lines');
  const other = lfsCheckout();
  writeFileSync(join(other.d, 'n.txt'), `${other.pointer.replace('git-lfs.github.com', 'hawser.github.com')}${'\n'.repeat(2000)}more data\n`);
  await refused(other.d, 'git add n.txt && git commit -m x', NOT_RUN, 'untracked, another version name, padded');
});

test('a file over 1024 bytes is scanned whole, and one that names a pointer version only after its first 1024 bytes commits', { skip: skipLfs }, async () => {
  const a = lfsCheckout();
  stageRaw(a.d, 'a.txt', `${'plain data\n'.repeat(200)}${SECRET}`);
  await refused(a.d, 'git commit -m x', FOUND, 'a large file with a secret past 1024 bytes');
  const b = lfsCheckout();
  stageRaw(b.d, 'b.txt', `${'plain data\n'.repeat(200)}see https://git-lfs.github.com/spec/v1\n`);
  assert.equal((await decide(b.d, 'git commit -m x')).decision, 'allow');
});

test('attack: a git-lfs on the path that is this user\'s own file refuses', { skip: skipRoot }, async () => {
  await withEnv({ PATH: `${ownLfs()}${delimiter}${process.env.PATH ?? ''}` }, async () => {
    await refused(lfsCheckout().d, 'git commit -m x', /git-lfs git would run .* belongs to uid \d+, not root/, 'a script of this user\'s');
  });
});

test('attack: root\'s git-lfs reached through a link someone else can change refuses', { skip: skipRoot || skipLfs }, async () => {
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  symlinkSync(LFS, join(bin, 'git-lfs'));
  await withEnv({ PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }, async () => {
    await refused(lfsCheckout().d, 'git commit -m x', /is on a path someone other than root can change/, 'a link of this user\'s');
  });
});

test('attack: a git-lfs on git\'s own exec path, which git looks on first, is checked too', { skip: skipRoot }, async () => {
  await withEnv({ GIT_EXEC_PATH: ownLfs() }, async () => {
    await refused(lfsCheckout().d, 'git commit -m x', /belongs to uid \d+, not root/, 'a script of this user\'s on the exec path');
  });
});

test('a checkout with no file under the large-file filter commits whatever git-lfs is on the path (the filter set up globally)', { skip: skipRoot }, async () => {
  const d = join(mkdtempSync(join(tmpdir(), 'nolfs-')), 'a');
  mkdirSync(d, { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  writeFileSync(join(d, 'b.js'), 'export const b = 1;\n');
  writeFileSync(join(d, 'c.js'), 'export const c = 1;\n');
  mkdirSync(join(d, 'docs'));
  writeFileSync(join(d, 'docs', 'gitattributes-notes.md'), 'notes\n');
  git(d, 'add', 'c.js', 'docs');
  git(d, 'commit', '-q', '-m', 'c');
  const global = join(mkdtempSync(join(tmpdir(), 'gitconfig-')), 'config');
  writeFileSync(global, STANDARD.map(([k, v]) => `[filter "lfs"]\n\t${k.split('.')[2]} = ${v}\n`).join(''));
  await withEnv({ GIT_CONFIG_GLOBAL: global, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'xdg-')), PATH: `${ownLfs()}${delimiter}${process.env.PATH ?? ''}` }, async () => {
    for (const line of ['git add b.js && git commit -m x', 'git mv c.js d.js && git commit -m x', 'git rm -q c.js && git commit -m x', 'git add -A && git commit -m x', 'git mv docs/gitattributes-notes.md docs/notes.md && git commit -m x']) {
      const r = await decide(d, line);
      assert.equal(r.decision, 'allow', `${line}: ${r.reason}`);
    }
  });
});

/** A checkout under the standard filter (no files under it yet) holding `files`, committed without running a filter. */
function plainCheckout(files: Record<string, string>): string {
  const d = join(mkdtempSync(join(tmpdir(), 'mv-')), 'a');
  mkdirSync(d, { recursive: true });
  cpSync(join(repoRoot, 'examples', 'basic', '.worklane'), join(d, BRAND.configDir), { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 'ada@example.com');
  git(d, 'config', 'user.name', 'Ada');
  git(d, 'config', 'commit.gpgsign', 'false');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(d, path, '..'), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  for (const [k, v] of STANDARD) git(d, 'config', k, v);
  return d;
}

const NOT_ROOT = /git-lfs git would run .* belongs to uid \d+, not root/;
const MOVES: [string, () => string, string][] = [
  ['A1: a file moved into the pattern', () => plainCheckout({ '.gitattributes': '*.bin filter=lfs\n', 'a.txt': 'plain\n' }), 'git mv a.txt a.bin && git commit -m x'],
  ['A2: an attributes file moved into place', () => {
    const d = plainCheckout({ 'attrs.txt': '*.txt filter=lfs\n', 'b.txt': 'plain\n' });
    writeFileSync(join(d, 'b.txt'), 'edited\n');
    return d;
  }, 'git mv attrs.txt .gitattributes && git commit -a -m x'],
  ['A3: a negating attributes file removed', () => {
    const d = plainCheckout({ '.gitattributes': '*.bin filter=lfs\n', 'sub/.gitattributes': '*.bin -filter\n', 'sub/x.bin': 'plain\n' });
    writeFileSync(join(d, 'sub', 'x.bin'), 'edited\n');
    return d;
  }, 'git rm -q sub/.gitattributes && git commit -a -m x'],
];
/** A3's checkout with the negating attributes file already deleted on disk, and the file under it edited (R97f). */
const deletedNegation = () => {
  const d = MOVES[2]![1]();
  rmSync(join(d, 'sub', '.gitattributes'));
  return d;
};
MOVES.push(
  ['D2: a deleted negating attributes file staged', deletedNegation, 'git add sub/.gitattributes && git commit -a -m x'],
  ['D5: a deleted negating attributes file staged with its folder', deletedNegation, 'git add --all sub && git commit -m x'],
  ['D7: a deleted negating attributes file committed with -a', deletedNegation, 'git commit -a -m x'],
);
for (const [what, make, line] of MOVES) {
  test(`attack: staging earlier in the line brings a file under the filter, and git-lfs is checked (${what})`, { skip: skipRoot }, async () => {
    const d = make();
    await withEnv({ PATH: `${ownLfs()}${delimiter}${process.env.PATH ?? ''}` }, async () => {
      await refused(d, line, NOT_ROOT, what);
    });
  });
}

test('attack: a file under the filter only by the index\'s attributes checks git-lfs too', { skip: skipRoot }, async () => {
  const d = plainCheckout({ 'a.js': 'plain\n' });
  writeFileSync(join(d, '.gitattributes'), '*.dat filter=lfs\n');
  git(d, 'add', '.gitattributes');
  writeFileSync(join(d, '.gitattributes'), '# none\n');
  writeFileSync(join(d, 'c.dat'), 'plain\n');
  await withEnv({ PATH: `${ownLfs()}${delimiter}${process.env.PATH ?? ''}` }, async () => {
    await refused(d, 'git commit -m x', NOT_ROOT, 'the index\'s attributes only (not in HEAD, not on disk)');
  });
});

test('attack: an attributes file only in the working tree, tracked by nothing, checks git-lfs too', { skip: skipRoot }, async () => {
  const d = plainCheckout({ 'a.js': 'plain\n' });
  writeFileSync(join(d, '.gitattributes'), '*.dat filter=lfs\n');
  await withEnv({ PATH: `${ownLfs()}${delimiter}${process.env.PATH ?? ''}` }, () => refused(d, 'git commit -m x', NOT_ROOT, 'an untracked attributes file'));
});

const IGNORED: [string, () => string, string][] = [
  ['H1: an attributes file .gitignore ignores', () => {
    const d = plainCheckout({ '.gitignore': 'sub/.gitattributes\n', 'sub/x.bin': 'plain\n' });
    writeFileSync(join(d, 'sub', '.gitattributes'), '*.bin filter=lfs\n');
    writeFileSync(join(d, 'sub', 'x.bin'), 'edited\n');
    return d;
  }, 'git commit -a -m x'],
  ['H2: an attributes file info/exclude ignores', () => {
    const d = plainCheckout({ 'a.js': 'plain\n' });
    writeFileSync(join(d, '.git', 'info', 'exclude'), '.gitattributes\n');
    writeFileSync(join(d, '.gitattributes'), '*.bin filter=lfs\n');
    writeFileSync(join(d, 'x.bin'), 'plain\n');
    return d;
  }, 'git add x.bin && git commit -m x'],
  ['H3: a relative core.attributesFile, which git reads from the checkout\'s top', () => {
    const d = plainCheckout({ 'a.js': 'plain\n' });
    writeFileSync(join(d, 'attrs-rel'), '*.bin filter=lfs\n');
    git(d, 'config', 'core.attributesFile', 'attrs-rel');
    return d;
  }, 'git commit -m x'],
  ['attr.tree in the config', () => {
    const d = plainCheckout({ 'a.js': 'plain\n' });
    git(d, 'config', 'attr.tree', 'side');
    return d;
  }, 'git commit -m x'],
];
for (const [name, make, line] of IGNORED) {
  test(`attack: ${name} checks git-lfs too`, { skip: skipRoot }, async () => {
    const d = make();
    await withEnv({ PATH: `${ownLfs()}${delimiter}${process.env.PATH ?? ''}` }, () => refused(d, line, NOT_ROOT, name));
  });
}

test('attack: GIT_ATTR_SOURCE in the hook\'s environment checks git-lfs too', { skip: skipRoot }, async () => {
  const d = plainCheckout({ 'a.js': 'plain\n' });
  await withEnv({ PATH: `${ownLfs()}${delimiter}${process.env.PATH ?? ''}`, GIT_ATTR_SOURCE: 'HEAD' }, () => refused(d, 'git commit -m x', NOT_ROOT, 'GIT_ATTR_SOURCE'));
});

test('attack: an attributes source no file matches yet, in any place git reads one, checks git-lfs too', { skip: skipRoot }, async () => {
  const info = plainCheckout({ 'a.js': 'plain\n' });
  writeFileSync(join(info, '.git', 'info', 'attributes'), '*.bin filter=lfs\n');
  const user = plainCheckout({ 'a.js': 'plain\n' });
  const xdg = mkdtempSync(join(tmpdir(), 'xdg-'));
  mkdirSync(join(xdg, 'git'));
  writeFileSync(join(xdg, 'git', 'attributes'), '[attr]big filter=lfs\n');
  const head = plainCheckout({ 'a.js': 'plain\n', 'sub/.gitattributes': '*.bin filter=lfs\n' });
  rmSync(join(head, 'sub', '.gitattributes'));
  git(head, 'rm', '-q', '--cached', 'sub/.gitattributes');
  await withEnv({ PATH: `${ownLfs()}${delimiter}${process.env.PATH ?? ''}` }, async () => {
    await refused(info, 'git commit -m x', NOT_ROOT, 'the repository\'s own attributes file');
    await refused(head, 'git commit -m x', NOT_ROOT, 'an attributes file only in HEAD');
    await withEnv({ XDG_CONFIG_HOME: xdg }, () => refused(user, 'git commit -m x', NOT_ROOT, 'the user\'s attributes file, through a macro'));
  });
});

test('a side before that begins like a pointer, not in its exact form, doesn\'t refuse the commit', { skip: skipLfs }, async () => {
  const { d } = lfsCheckout();
  const raw = `version https://hawser.github.com/spec/v1\n${'old data\n'.repeat(200)}`;
  stageRaw(d, 'old.txt', raw);
  git(d, 'commit', '-q', '-m', 'raw, as committed without git-lfs');
  stageRaw(d, 'old.txt', 'plain data\n');
  const r = await decide(d, 'git commit -m x');
  assert.equal(r.decision, 'allow', r.reason);
});

test('attack: a path entry that depends on the folder, or no git-lfs at all, refuses', { skip }, async () => {
  await withEnv({ PATH: `${delimiter}${process.env.PATH ?? ''}` }, async () => {
    await refused(lfsCheckout().d, 'git commit -m x', /not an absolute directory/, 'an empty entry (the folder)');
  });
  await withEnv({ PATH: `.${delimiter}${process.env.PATH ?? ''}` }, async () => {
    await refused(lfsCheckout().d, 'git commit -m x', /not an absolute directory/, 'a relative entry');
  });
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  for (const tool of ['git', 'gitleaks']) symlinkSync(which(tool), join(bin, tool));
  const d = lfsCheckout().d;
  await withEnv({ PATH: bin, GIT_EXEC_PATH: mkdtempSync(join(tmpdir(), 'exec-')) }, async () => {
    await refused(d, 'git commit -m x', /no git-lfs is on the path the scan can check/, 'no git-lfs');
  });
});
