import { type WorktreeOptions } from './worktrees.js';
export interface PoolEntry {
    name: string;
    path: string;
    base: string;
    createdAt: string;
    /** What its setup produced depends on (setupKey): the same key at a new main means it can move there as it is. */
    key?: string | null;
}
/** Disk always left free after the pool: the larger of this and twice one worktree. */
export declare const POOL_MIN_FREE_GB = 10;
export declare function readPool(o: WorktreeOptions): PoolEntry[];
/** How many pooled worktrees fit: at most `want`, and only as many as leave the free-disk floor. */
export declare function poolFits(want: number, estSizeGb: number, freeGb: number): number;
/**
 * What a worktree's setup produces depends on, at `base`: the setup steps, the project's variables, what the checkout
 * leaves out, and the contents of the `files` that pin the install (tests.yaml worktree.setup_key, read at `base`).
 * null without key files: nothing says a set-up worktree stays right on another commit.
 */
export declare function setupKey(o: WorktreeOptions, base: string, files: readonly string[]): string | null;
/**
 * Bring the pool to `size` worktrees on `base` (main's tip). A stale one (an older base) whose setup key is the same
 * at `base` (`key`: none of the files that pin its install changed) is moved there and kept; any other stale one, or
 * one gone from disk, is removed. New ones are created with the project's setup, and one whose setup fails is
 * removed again.
 */
export declare function refillPool(o: WorktreeOptions, p: {
    size: number;
    base: string;
    estSizeGb: number;
    freeGb?: () => number;
    key?: (base: string) => string | null;
}): Promise<{
    created: string[];
    moved: string[];
    removed: string[];
    errors: string[];
}>;
/**
 * A ready worktree for a task starting at `base`, switched to the task's `branch` where it stands; null when
 * the pool has none at that base (then the caller creates one as usual). One that isn't exactly as it was
 * left (a stray change, a different commit) is removed, never handed out.
 */
export declare function takeFromPool(o: WorktreeOptions, base: string, branch: string): {
    name: string;
    path: string;
} | null;
/** The path a pooled worktree named `name` lives at (for callers that keep only the name). */
export declare function pooledPath(o: WorktreeOptions, name: string): string;
