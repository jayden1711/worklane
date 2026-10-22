// #890 round 20, the second review's N1 (measured): on an install whose repository path goes through a link, the
// ownership record spells an old worktree through the link, but `git worktree list` prints real paths. Compared as
// text, a listed old worktree looked unlisted: it was kept, "git no longer lists" was logged falsely, and the task's
// next worktree failed ("already used by worktree"). Main and a1573bd7 handled it. Paths are compared as real paths now.
import { exampleProject } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { createWorktree, ownedWorktrees, worktreeOptions } from '../src/worktrees.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('#890 r20 (N1): under a repository path through a link, a listed old worktree is emptied and its task made again', { skip: process.platform === 'win32' && 'POSIX links' }, () => {
  const { dir } = exampleProject();
  const linked = join(dirname(dir), 'repo-link');
  symlinkSync(dir, linked);
  const stateDir = mkdtempSync(join(tmpdir(), 'wt-state-'));
  const o = worktreeOptions({ repo: linked, root: '.', stateDir, setup: [], taskDir: null });
  // An old worktree from before round 17, directly in the main checkout, recorded through the link as on such installs.
  const old = join(linked, `${BRAND.cli}-issue-5`);
  git(linked, 'worktree', 'add', '-q', '-b', 'b5', old, 'HEAD');
  git(linked, 'worktree', 'lock', old);
  writeFileSync(join(stateDir, 'worktrees.json'), JSON.stringify([old]));
  assert.ok(git(dir, 'worktree', 'list', '--porcelain').includes(`worktree ${join(dir, `${BRAND.cli}-issue-5`)}\n`), 'git lists it by its real path');
  const { path } = createWorktree(o, 'issue-5', 'b5', 'HEAD');
  assert.ok(path.startsWith(join(dir, `${BRAND.cli}-worktrees`)), path);
  const oldReal = join(dir, `${BRAND.cli}-issue-5`);
  assert.ok(lstatSync(oldReal).isDirectory() && !lstatSync(oldReal).isSymbolicLink(), 'the old name stays taken');
  assert.deepEqual(readdirSync(oldReal), [], 'the old worktree was emptied');
  assert.equal(ownedWorktrees(o).includes(old), false, 'its record dropped');
});
