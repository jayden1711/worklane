// #890 round 13 (second review's availability note on round 12's locking): a worktree the coordinator owns whose
// directory was deleted some other way keeps a locked record, and git then refuses a new worktree at the same path
// ("missing but locked"). Before locking, any prune cleared it. Now the coordinator unlocks and prunes that record of
// its own before adding there again; a locked record of another worktree is kept.
import { exampleProject } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, worktreeOptions, type WorktreeOptions } from '../src/worktrees.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('#890 r13: a worktree of ours deleted outside its removal can be made again at the same path, locked; another stays', () => {
  const { dir } = exampleProject();
  const o: WorktreeOptions = worktreeOptions({ repo: dir, root: '.claude/worktrees', stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [], taskDir: null });
  const gone = createWorktree(o, 'issue-1', 'b1', 'HEAD').path;
  const kept = createWorktree(o, 'issue-2', 'b2', 'HEAD').path;
  rmSync(gone, { recursive: true, force: true });
  rmSync(kept, { recursive: true, force: true });
  const again = createWorktree(o, 'issue-1', 'b1', 'HEAD').path;
  assert.equal(again, gone);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: again }).status, 0, 'a working checkout');
  const list = git(dir, 'worktree', 'list', '--porcelain');
  assert.match(list, new RegExp(`worktree ${again}\\nHEAD [0-9a-f]+\\nbranch refs/heads/b1\\nlocked`));
  // The other deleted one is not this add's: its record stays, locked.
  assert.match(list, new RegExp(`worktree ${kept}\\n[\\s\\S]*?locked`));
});
