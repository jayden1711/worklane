export interface GitRun {
    (args: string[]): {
        status: number | null;
        stdout: string;
        stderr: string;
    };
}
export declare const systemGit: (root: string) => GitRun;
/**
 * Why a fast-forward was refused (#468): `dirty` (local changes: once committed or stashed, it can be tried again),
 * `diverged` (commits origin doesn't have: only the person can reconcile), `branch` (another branch checked out), or
 * `git` (git itself failed). `files`: the changed files (at most 10); `ahead`/`behind`: the commits on each side.
 */
export type Refusal = 'dirty' | 'diverged' | 'branch' | 'git';
export type FastForward = {
    ok: true;
    detail: string;
    from: string;
    to: string;
} | {
    ok: false;
    detail: string;
    reason: Refusal;
    files?: string[];
    ahead?: number;
    behind?: number;
    command: string;
};
/**
 * Fetch origin's `branch` and fast-forward this checkout to it. Refused (nothing changed): the checkout isn't on
 * `branch`; it has uncommitted changes to tracked files; or it has commits origin doesn't (diverged).
 */
export declare function fastForwardCheckout(branch: string, git: GitRun): FastForward;
