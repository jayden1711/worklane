// A small pool of worktrees already checked out on main with the project's setup done (dependencies
// installed), so a task can start in one instead of waiting for a fresh setup. Off unless tests.yaml asks
// for it (worktree.pool), refilled after each merge, and bounded by free disk.
//
// A pooled worktree is used where it is, never moved to another path: setup steps such as a Python virtualenv
// or an editable install record absolute paths, which a move would break. Taking one only switches its branch.
// When main moves and the files that pin the install (worktree.setup_key) didn't change, a pooled worktree
// follows main by a checkout in place, keeping what its setup installed, so a merge doesn't empty the pool. It is
// still set up on main only and handed to one task, never back: no task's change reaches another's dependencies.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { diskFree, groupOnlyDir, writeGroupOnly } from './os/index.js';
import { cacheKey } from './testrun/cache.js';
import { createWorktreeAsync, removeWorktree, worktreePath } from './worktrees.js';
/** Disk always left free after the pool: the larger of this and twice one worktree. */
export const POOL_MIN_FREE_GB = 10;
const poolFile = (o) => join(o.stateDir, 'worktree-pool.json');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function readPool(o) {
    try {
        return JSON.parse(readFileSync(poolFile(o), 'utf8')).filter((e) => typeof e?.name === 'string' && typeof e.base === 'string');
    }
    catch {
        return [];
    }
}
function writePool(o, entries) {
    groupOnlyDir(o.stateDir);
    writeGroupOnly(poolFile(o), JSON.stringify(entries, null, 2));
}
/** How many pooled worktrees fit: at most `want`, and only as many as leave the free-disk floor. */
export function poolFits(want, estSizeGb, freeGb) {
    const floor = Math.max(POOL_MIN_FREE_GB, 2 * estSizeGb);
    return Math.max(0, Math.min(Math.floor(want), Math.floor((freeGb - floor) / Math.max(estSizeGb, 0.01))));
}
/**
 * What a worktree's setup produces depends on, at `base`: the setup steps, the project's variables, what the checkout
 * leaves out, and the contents of the `files` that pin the install (tests.yaml worktree.setup_key, read at `base`).
 * null without key files: nothing says a set-up worktree stays right on another commit.
 */
export function setupKey(o, base, files) {
    if (!files.length)
        return null;
    return createHash('sha256')
        .update(JSON.stringify({ setup: o.setup, env: o.env ?? {}, sparse: o.sparseExclude ?? [] }))
        .update(cacheKey(o.repo, base, files))
        .digest('hex')
        .slice(0, 32);
}
/**
 * A pooled worktree, still exactly as it was set up (clean, at its base), moved to `base` on its own pool branch: the
 * tracked files follow main, and what setup installed (untracked, ignored) stays. False when it isn't clean or the
 * checkout fails; the caller removes it then.
 */
function movePooled(e, base) {
    try {
        if (git(e.path, 'status', '--porcelain', '--untracked-files=no') !== '' || git(e.path, 'rev-parse', 'HEAD') !== e.base)
            return false;
        git(e.path, 'checkout', '-q', '-B', git(e.path, 'rev-parse', '--abbrev-ref', 'HEAD'), base);
        return git(e.path, 'rev-parse', 'HEAD') === base;
    }
    catch {
        return false;
    }
}
/**
 * Bring the pool to `size` worktrees on `base` (main's tip). A stale one (an older base) whose setup key is the same
 * at `base` (`key`: none of the files that pin its install changed) is moved there and kept; any other stale one, or
 * one gone from disk, is removed. New ones are created with the project's setup, and one whose setup fails is
 * removed again.
 */
export async function refillPool(o, p) {
    const removed = [];
    const moved = [];
    const errors = [];
    const keep = [];
    let key;
    const keyAt = () => (key === undefined ? (key = p.key?.(p.base) ?? null) : key);
    for (const e of readPool(o)) {
        if (e.base === p.base && existsSync(e.path)) {
            keep.push(e);
            continue;
        }
        if (existsSync(e.path) && e.key && e.key === keyAt() && movePooled(e, p.base)) {
            keep.push({ ...e, base: p.base });
            moved.push(e.name);
            continue;
        }
        try {
            removeWorktree(o, e.name);
        }
        catch {
            // not ours any more or already gone: drop it from the pool either way
        }
        removed.push(e.name);
    }
    writePool(o, keep);
    const free = p.freeGb ?? (() => diskFree(o.repo).freeGb);
    const created = [];
    // Free disk already counts the worktrees made so far, so each new one needs room for just itself.
    while (keep.length < Math.floor(p.size) && poolFits(1, p.estSizeGb, free()) === 1) {
        const name = `pool-${Date.now().toString(36)}-${keep.length}`;
        const branch = `${BRAND.cli}/${name}`;
        const { path, setupErrors } = await createWorktreeAsync(o, name, branch, p.base);
        if (setupErrors.length) {
            errors.push(`${name}: ${setupErrors.join('; ')}`);
            try {
                removeWorktree(o, name);
            }
            catch {
                // already gone
            }
            break; // the same setup would fail again for the next one
        }
        keep.push({ name, path, base: p.base, createdAt: new Date().toISOString(), key: keyAt() });
        writePool(o, keep);
        created.push(name);
    }
    return { created, moved, removed, errors };
}
/**
 * A ready worktree for a task starting at `base`, switched to the task's `branch` where it stands; null when
 * the pool has none at that base (then the caller creates one as usual). One that isn't exactly as it was
 * left (a stray change, a different commit) is removed, never handed out.
 */
export function takeFromPool(o, base, branch) {
    const entries = readPool(o);
    const i = entries.findIndex((e) => e.base === base && existsSync(e.path));
    if (i < 0)
        return null;
    const e = entries[i];
    writePool(o, entries.filter((_, j) => j !== i));
    try {
        const clean = git(e.path, 'status', '--porcelain', '--untracked-files=no') === '' && git(e.path, 'rev-parse', 'HEAD') === base;
        if (!clean)
            throw new Error('changed since it was pooled');
        const poolBranch = git(e.path, 'rev-parse', '--abbrev-ref', 'HEAD');
        git(e.path, 'checkout', '-q', '-B', branch, base);
        if (poolBranch !== branch && poolBranch !== 'HEAD')
            git(o.repo, 'branch', '-q', '-D', poolBranch);
        return { name: e.name, path: e.path };
    }
    catch {
        try {
            removeWorktree(o, e.name);
        }
        catch {
            // already gone
        }
        return null;
    }
}
/** The path a pooled worktree named `name` lives at (for callers that keep only the name). */
export function pooledPath(o, name) {
    return worktreePath(o, name);
}
//# sourceMappingURL=worktree-pool.js.map