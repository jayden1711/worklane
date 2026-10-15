import { Readable } from 'node:stream';
import type { RunDatabase, RunHost } from './host.js';
/** The default branch's name and commit in the coordinator's clone: origin/HEAD, else origin/main, else main. */
export declare function defaultBranch(repo: string): {
    name: string;
    sha: string;
} | null;
/** Of the store's commits, the ones `repo` has too: a bundle can leave out everything they reach. */
export declare function sharedTips(repo: string, tips: readonly string[]): string[];
export interface TreeBundle {
    /** The bundle, or nothing at all when the store already has both commits. */
    stream: Readable;
    branch: string;
    /** The commit to test and the default branch's tip, in full. */
    headSha: string;
    baseSha: string;
    /** How many of the two the bundle carries (0: an empty stream). */
    refs: number;
    done: Promise<void>;
}
/**
 * A bundle of `sha` and the default branch, as a stream, carrying only what the store lacks: every object they reach
 * that none of `have` (the store's commits this repo also has) reaches. Under temporary refs in the coordinator's
 * clone, private to this run (removed once the bundle is written). Empty when the store has both.
 */
export declare function treeBundle(repo: string, sha: string, id: string, have?: readonly string[]): TreeBundle;
/**
 * The commands that make a run's workspace, run as the test user (the sandbox helper runs the same ones, checked by a
 * test): $1 the bundle (empty when the store has everything), $2 the workspace, $3 the default branch's name, $4 and
 * $5 the bundle's refs for the commit and the default branch, $6 and $7 the two commits, $8 the store; any more
 * arguments are directories left out of the checkout. No single quote in it: the helper holds it in one.
 */
export declare function cloneScript(): string;
/**
 * Make run `id`'s workspace at `sha`: the commit checked out, the default branch beside it, its objects from the
 * instance's store (sent only what the store lacks), leaving `exclude` (directories) out of the checkout.
 */
export declare function createWorkspace(host: RunHost, repo: string, sha: string, id: string, exclude?: readonly string[]): Promise<{
    workdir: string;
    bundleRefs: number;
}>;
/**
 * Everything a run's commands get, and nothing else: the project's own variables (the same rules as tests.yaml
 * env: no secret-like or harness names), the caches' directories, and the run's DATABASE_URL. Never this
 * process's environment, so no credential the coordinator holds can reach a run.
 */
export declare function runEnv(projectEnv: Record<string, string>, caches: Record<string, string>, db: RunDatabase | null): Record<string, string>;
/** Wipe run `id`; a wipe that leaves anything behind throws, naming what is left. */
export declare function wipeWorkspace(host: RunHost, id: string): Promise<void>;
