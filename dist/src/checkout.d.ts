import { z } from 'zod';
/**
 * A directory left out, relative to the repo root: plain path characters only (no glob, no quote, no space), not
 * starting with "-", no "." or ".." or empty segment, so it goes into a sparse pattern and the test-run helper's
 * arguments as written. The sandbox helper checks each with the same rule (scripts/machine/<cli>-testrun.sh
 * valid_dir; a test keeps the two alike).
 */
export declare const SPARSE_DIR: RegExp;
/** The most directories a project may leave out (each is one argument to the helper, which takes at most this). */
export declare const SPARSE_MAX = 32;
/** `docs/design/` and `docs/design` are the same directory: no trailing slash. */
export declare const normalizeSparseDir: (p: string) => string;
/** Why `p` can't be left out of a checkout; null when it can. */
export declare function sparseDirProblem(p: string): string | null;
export declare const SparseExclude: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>>;
/** The sparse-checkout file for leaving `dirs` out: everything ("/*"), then "!/<dir>/" for each. */
export declare function sparsePatterns(dirs: readonly string[]): string;
/**
 * Make the linked worktree at `path` (added with --no-checkout) sparse, leaving `dirs` out, and check its HEAD out.
 * The setting is the worktree's own (extensions.worktreeConfig, its config.worktree): the checkout it was added
 * from and every other worktree stay as they are.
 */
export declare function checkoutSparse(repo: string, path: string, dirs: readonly string[]): void;
