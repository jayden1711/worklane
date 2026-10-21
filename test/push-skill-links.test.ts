// The push limits' SKILL.md lint reads only a regular file of at most 1 MB (#724, round 3). A symlink's blob is its
// target's path, not the file a checkout opens: a SKILL.md symlink whose target path is itself text that passes the
// lint, pointing at a file that fails it, was pushed (0 problems, measured by #928's round-2 check). It is now a
// problem, never linted as its target text. A SKILL.md over 1 MB is refused before it is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PUSH_LIMITS, pushProblems } from '../src/push-check.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const GOOD = '## When to use\nx\n## Inputs and access\nx\n## Steps\nx\n## Validate\nx\n## Return\nx\n## Approval\nx\n';
const BAD = '## When to use\nx\n';
const posix = { skip: process.platform === 'win32' && 'symlinks and a newline in a link target' };
const LIMITS = { ...DEFAULT_PUSH_LIMITS, max_changed_lines: 1_000_000, max_file_mb: 100 };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'push-skill-links-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false'], ['core.symlinks', 'true']]) git(dir, 'config', k!, v!);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  mkdirSync(join(dir, '.claude', 'skills', 's'), { recursive: true });
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

const commit = (dir: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
  return git(dir, 'rev-parse', 'HEAD');
};
const skillProblems = (p: string[]) => p.filter((x) => x.includes('skill lint'));

test('a SKILL.md symlink whose target path is text that passes the lint is refused, not linted as that text', posix, () => {
  const r = repo();
  // The target path is a passing skill's text, then a way back out to a failing file the change adds.
  mkdirSync(join(r.dir, 'docs'));
  writeFileSync(join(r.dir, 'docs', 'evil.md'), BAD);
  symlinkSync(`${GOOD}/../../../../docs/evil.md`, join(r.dir, '.claude', 'skills', 's', 'SKILL.md'));
  const head = commit(r.dir);
  assert.equal(git(r.dir, 'ls-tree', head, '.claude/skills/s/SKILL.md').split(' ')[0], '120000');
  const p = skillProblems(pushProblems(r.dir, r.base, head, LIMITS));
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /\.claude\/skills\/s\/SKILL\.md \(can't be read at the head: a symbolic link, not a file\)/);
});

test('a SKILL.md symlink to a passing skill is refused as a link, not judged by its target', posix, () => {
  const r = repo();
  mkdirSync(join(r.dir, '.claude', 'skills', 'good'));
  writeFileSync(join(r.dir, '.claude', 'skills', 'good', 'SKILL.md'), GOOD);
  symlinkSync('../good/SKILL.md', join(r.dir, '.claude', 'skills', 's', 'SKILL.md'));
  const p = skillProblems(pushProblems(r.dir, r.base, commit(r.dir), LIMITS));
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /\.claude\/skills\/s\/SKILL\.md \(can't be read at the head: a symbolic link, not a file\)/);
  assert.doesNotMatch(p[0]!, /good\/SKILL\.md/);
});

test('a SKILL.md over 1 MB is refused before it is read, even one whose text passes', () => {
  const r = repo();
  writeFileSync(join(r.dir, '.claude', 'skills', 's', 'SKILL.md'), GOOD + 'y'.repeat(2 * 1024 * 1024) + '\n');
  const p = skillProblems(pushProblems(r.dir, r.base, commit(r.dir), LIMITS));
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /can't be read at the head: \d+ bytes, over the 1048576-byte limit for it/);
});

test('a regular SKILL.md, executable or not, at most 1 MB, is linted as before', posix, () => {
  const r = repo();
  writeFileSync(join(r.dir, '.claude', 'skills', 's', 'SKILL.md'), GOOD);
  mkdirSync(join(r.dir, '.claude', 'skills', 'x'));
  writeFileSync(join(r.dir, '.claude', 'skills', 'x', 'SKILL.md'), GOOD);
  chmodSync(join(r.dir, '.claude', 'skills', 'x', 'SKILL.md'), 0o755);
  const head = commit(r.dir);
  assert.deepEqual(pushProblems(r.dir, r.base, head, LIMITS), []);
  writeFileSync(join(r.dir, '.claude', 'skills', 'x', 'SKILL.md'), BAD);
  assert.match(skillProblems(pushProblems(r.dir, r.base, commit(r.dir), LIMITS)).join('\n'), /x\/SKILL\.md \(missing the "Inputs and access" section/);
});
