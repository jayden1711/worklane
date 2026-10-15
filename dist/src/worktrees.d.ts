export interface WorktreeOptions {
    repo: string;
    root: string;
    stateDir: string;
    setup: string[];
    /** Setup steps (e.g. npm ci) run the project's own scripts, so they run as the agent user when there is one. */
    runAs?: {
        user: string;
        home: string;
    };
    /** The project's own variables (tests.yaml env). */
    env?: Record<string, string>;
    /** The instance's dependency-cache variables (dep-cache.ts), set for setup steps after the project's own. */
    cacheEnv?: Record<string, string>;
    /** Directories left out of the worktree (tests.yaml checkout.sparse_exclude, src/checkout.ts). */
    sparseExclude?: readonly string[];
}
/**
 * What Claude Code's sandbox leaves in a worktree. It protects some paths
 * from writes inside the working directory; on Linux it does that by
 * mounting over them, so a protected path that doesn't exist yet is first
 * created, empty, as the mount point, and stays after the run.
 *
 * Two kinds:
 * - Files and folders at the worktree root, from the sandbox's own list
 *   (in Claude Code 2.1.282: .gitconfig, .gitmodules, shell startup files,
 *   .ripgreprc, .mcp.json, .vscode, .idea), plus the other shell files.
 * - Anything under .claude/. Claude Code protects more of it with each
 *   version (commands, agents, launch.json, loop.md, output-styles,
 *   routines, scheduled_tasks.json, ...), so it is covered as a whole
 *   rather than by name. .claude/ is harness config: agents edit tracked
 *   files there through review, and never add new ones.
 */
export declare const SANDBOX_ROOT_PLACEHOLDERS: string[];
/**
 * Keep the sandbox's placeholders out of anything an agent can commit: an
 * exclude block in the repo's shared info/exclude (it covers every
 * worktree), rewritten each time so it follows this list. Exclusion only
 * affects untracked files: changes to tracked ones still show.
 */
export declare function excludeSandboxPlaceholders(repo: string): void;
/** After a run, remove the sandbox's leftover mount points: only empty, untracked ones. */
export declare function removeSandboxPlaceholders(worktree: string): string[];
export declare function worktreePath(o: WorktreeOptions, name: string): string;
/**
 * createWorktree without blocking: the setup steps run as child processes the event loop waits on, for work
 * done in the background (a worktree pool refilling while the coordinator keeps going).
 */
export declare function createWorktreeAsync(o: WorktreeOptions, name: string, branch: string, base: string): Promise<{
    path: string;
    setupErrors: string[];
}>;
/** Create a worktree on a new branch at `base`, then run the project's setup steps. */
export declare function createWorktree(o: WorktreeOptions, name: string, branch: string, base: string): {
    path: string;
    setupErrors: string[];
};
/** Remove one of OUR worktrees; refuses anything not in the ownership record. Verified after. */
export declare function removeWorktree(o: WorktreeOptions, name: string): boolean;
/** Our worktrees still on disk (for startup cleanup of terminal tasks). */
export declare function ownedWorktrees(o: WorktreeOptions): string[];
