export type MergeResult = {
    clean: true;
    head: string;
} | {
    clean: false;
    conflicted: Record<string, string>;
    otherFiles: string[];
} | {
    error: string;
};
/**
 * Merge `base` (a commit) into the worktree's current branch with a merge commit. Clean: the new head.
 * Conflicted: each conflicted file's text with markers, and the files the merge did change cleanly (left
 * staged; a resolver commits the result). A clean merge is committed as `identity`: every harness commit
 * carries the harness's identity, and the coordinator rejects any other.
 */
export declare function mergeBaseInto(worktree: string, base: string, message: string, identity: {
    name: string;
    email: string;
}): MergeResult;
/** Undo an unfinished merge (a conflict nobody will resolve here). */
export declare function abortMerge(worktree: string): void;
/** Files changed between two commits (a..b), for "did main touch what this PR touches". */
export declare function changedFiles(repo: string, from: string, to: string): string[];
