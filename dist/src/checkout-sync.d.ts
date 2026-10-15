export interface GitRun {
    (args: string[]): {
        status: number | null;
        stdout: string;
        stderr: string;
    };
}
export declare const systemGit: (root: string) => GitRun;
export type FastForward = {
    ok: true;
    detail: string;
    from: string;
    to: string;
} | {
    ok: false;
    detail: string;
};
/**
 * Fetch origin's `branch` and fast-forward this checkout to it. Refused (nothing changed): the checkout isn't on
 * `branch`; it has uncommitted changes to tracked files; or it has commits origin doesn't (diverged).
 */
export declare function fastForwardCheckout(branch: string, git: GitRun): FastForward;
