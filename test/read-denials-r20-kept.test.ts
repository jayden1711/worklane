// #890 round 20, the second review's FU1 (measured, head against main): removing an old `<cli>-*` worktree of ours
// that git no longer lists emptied it, files and all, where main's `git worktree remove` refused and kept the data.
// Now only a directory git still lists, or one already empty, is emptied; anything else is kept, as on main.
import { exampleProject } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ownedWorktrees, removeWorktree, worktreeOptions } from '../src/worktrees.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Root ".": an old worktree of ours directly in the main checkout, in the ownership record, that git no longer lists. */
function unlisted() {
  const { dir } = exampleProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'wt-state-'));
  const o = worktreeOptions({ repo: dir, root: '.', stateDir, setup: [], taskDir: null });
  const old = join(o.root, `${BRAND.cli}-issue-5`);
  git(dir, 'worktree', 'add', '-q', '-b', 'b5', old, 'HEAD');
  writeFileSync(join(stateDir, 'worktrees.json'), JSON.stringify([old]));
  // git's record dropped some other way: its `.git` file gone, then pruned.
  rmSync(join(old, '.git'));
  git(dir, 'worktree', 'prune');
  assert.ok(!git(dir, 'worktree', 'list', '--porcelain').includes(`worktree ${old}\n`), 'git no longer lists it');
  return { dir, o, old };
}

test('#890 r20 (FU1): an old worktree git no longer lists, with a file in it, is kept with its file, as on main', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const { o, old } = unlisted();
  writeFileSync(join(old, 'keep.txt'), 'work not committed\n');
  let removed: boolean | undefined;
  try {
    removed = removeWorktree(o, 'issue-5');
  } catch {
    removed = false;
  }
  assert.equal(removed, false, 'reported as not removed');
  assert.ok(existsSync(join(old, 'keep.txt')), 'the file is kept');
  assert.ok(lstatSync(old).isDirectory());
  assert.ok(ownedWorktrees(o).includes(old), 'still in the ownership record');
});

test('#890 r20 (FU1): an old worktree git no longer lists that is already empty stays an empty directory and leaves the record', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const { o, old } = unlisted();
  for (const n of readdirSync(old)) rmSync(join(old, n), { recursive: true, force: true });
  assert.equal(removeWorktree(o, 'issue-5'), true);
  assert.ok(lstatSync(old).isDirectory() && !lstatSync(old).isSymbolicLink(), 'the name stays taken');
  assert.equal(ownedWorktrees(o).includes(old), false);
});
