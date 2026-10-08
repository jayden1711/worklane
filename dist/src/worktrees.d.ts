export interface WorktreeOptions {
    repo: string;
    root: string;
    stateDir: string;
    setup: string[];
}
export declare function worktreePath(o: WorktreeOptions, name: string): string;
/** Create a worktree on a new branch at `base`, then run the project's setup steps. */
export declare function createWorktree(o: WorktreeOptions, name: string, branch: string, base: string): {
    path: string;
    setupErrors: string[];
};
/** Remove one of OUR worktrees; refuses anything not in the ownership record. Verified after. */
export declare function removeWorktree(o: WorktreeOptions, name: string): boolean;
/** Our worktrees still on disk (for startup cleanup of terminal tasks). */
export declare function ownedWorktrees(o: WorktreeOptions): string[];
