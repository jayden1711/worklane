// A small pool of worktrees already checked out on main with the project's setup done (dependencies
// installed), so a task can start in one instead of waiting for a fresh setup. Off unless tests.yaml asks
// for it (worktree.pool), refilled after each merge, and bounded by free disk.
//
// A pooled worktree is used where it is, never moved: setup steps such as a Python virtualenv or an
// editable install record absolute paths, which a move would break. Taking one only switches its branch.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { diskFree, groupOnlyDir, writeGroupOnly } from './os/index.js';
import { createWorktreeAsync, removeWorktree, worktreePath, type WorktreeOptions } from './worktrees.js';

export interface PoolEntry {
  name: string;
  path: string;
  base: string;
  createdAt: string;
}

/** Disk always left free after the pool: the larger of this and twice one worktree. */
export const POOL_MIN_FREE_GB = 10;

const poolFile = (o: WorktreeOptions) => join(o.stateDir, 'worktree-pool.json');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function readPool(o: WorktreeOptions): PoolEntry[] {
  try {
    return (JSON.parse(readFileSync(poolFile(o), 'utf8')) as PoolEntry[]).filter((e) => typeof e?.name === 'string' && typeof e.base === 'string');
  } catch {
    return [];
  }
}
function writePool(o: WorktreeOptions, entries: PoolEntry[]) {
  groupOnlyDir(o.stateDir);
  writeGroupOnly(poolFile(o), JSON.stringify(entries, null, 2));
}

/** How many pooled worktrees fit: at most `want`, and only as many as leave the free-disk floor. */
export function poolFits(want: number, estSizeGb: number, freeGb: number): number {
  const floor = Math.max(POOL_MIN_FREE_GB, 2 * estSizeGb);
  return Math.max(0, Math.min(Math.floor(want), Math.floor((freeGb - floor) / Math.max(estSizeGb, 0.01))));
}

/**
 * Bring the pool to `size` worktrees on `base` (main's tip): stale ones (an older base, gone from disk) are
 * removed first; new ones are created with the project's setup, and one whose setup fails is removed again.
 */
export async function refillPool(
  o: WorktreeOptions,
  p: { size: number; base: string; estSizeGb: number; freeGb?: () => number },
): Promise<{ created: string[]; removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];
  const keep: PoolEntry[] = [];
  for (const e of readPool(o)) {
    if (e.base === p.base && existsSync(e.path)) {
      keep.push(e);
      continue;
    }
    try {
      removeWorktree(o, e.name);
    } catch {
      // not ours any more or already gone: drop it from the pool either way
    }
    removed.push(e.name);
  }
  writePool(o, keep);
  const free = p.freeGb ?? (() => diskFree(o.repo).freeGb);
  const created: string[] = [];
  // Free disk already counts the worktrees made so far, so each new one needs room for just itself.
  while (keep.length < Math.floor(p.size) && poolFits(1, p.estSizeGb, free()) === 1) {
    const name = `pool-${Date.now().toString(36)}-${keep.length}`;
    const branch = `${BRAND.cli}/${name}`;
    const { path, setupErrors } = await createWorktreeAsync(o, name, branch, p.base);
    if (setupErrors.length) {
      errors.push(`${name}: ${setupErrors.join('; ')}`);
      try {
        removeWorktree(o, name);
      } catch {
        // already gone
      }
      break; // the same setup would fail again for the next one
    }
    keep.push({ name, path, base: p.base, createdAt: new Date().toISOString() });
    writePool(o, keep);
    created.push(name);
  }
  return { created, removed, errors };
}

/**
 * A ready worktree for a task starting at `base`, switched to the task's `branch` where it stands; null when
 * the pool has none at that base (then the caller creates one as usual). One that isn't exactly as it was
 * left (a stray change, a different commit) is removed, never handed out.
 */
export function takeFromPool(o: WorktreeOptions, base: string, branch: string): { name: string; path: string } | null {
  const entries = readPool(o);
  const i = entries.findIndex((e) => e.base === base && existsSync(e.path));
  if (i < 0) return null;
  const e = entries[i]!;
  writePool(o, entries.filter((_, j) => j !== i));
  try {
    const clean = git(e.path, 'status', '--porcelain', '--untracked-files=no') === '' && git(e.path, 'rev-parse', 'HEAD') === base;
    if (!clean) throw new Error('changed since it was pooled');
    const poolBranch = git(e.path, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(e.path, 'checkout', '-q', '-B', branch, base);
    if (poolBranch !== branch && poolBranch !== 'HEAD') git(o.repo, 'branch', '-q', '-D', poolBranch);
    return { name: e.name, path: e.path };
  } catch {
    try {
      removeWorktree(o, e.name);
    } catch {
      // already gone
    }
    return null;
  }
}

/** The path a pooled worktree named `name` lives at (for callers that keep only the name). */
export function pooledPath(o: WorktreeOptions, name: string): string {
  return worktreePath(o, name);
}
