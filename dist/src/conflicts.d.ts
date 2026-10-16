/** What to do about a PR's merge state. Only a real conflict starts a fix; "still computing" is polled again soon. */
export type ConflictTrigger = {
    act: 'fix';
} | {
    act: 'recheck';
    why: string;
} | {
    act: 'none';
    why: string;
};
/**
 * GitHub reports conflicts as mergeable=false with mergeable_state "dirty" (GraphQL: CONFLICTING). Behind,
 * blocked, unstable, clean, draft and unknown are never conflicts; mergeable=null means GitHub hasn't
 * computed it yet (it starts when asked), so the caller polls again shortly instead of acting.
 */
export declare function conflictTrigger(pr: {
    state: string;
    mergeable: boolean | null;
    mergeableState: string;
}): ConflictTrigger;
/** Fix runs already used on a PR: every one started counts, including runs a restart cut short. */
export declare function conflictFixesUsed(events: {
    type: string;
    payload: unknown;
}[], pr: number): number;
export interface ConflictHunk {
    file: string;
    /** 1-based line of the "<<<<<<<" marker in the conflicted file. */
    line: number;
    ours: string;
    theirs: string;
    /** The common ancestor's text, when the merge used diff3 / zdiff3 markers. */
    base?: string;
}
/**
 * A file's lines with their line endings dropped, LF or CRLF alike (a checkout with core.autocrlf, or a repo
 * that keeps CRLF, writes markers and content with \r\n). Only for reading and comparing: files are never
 * rewritten with other endings.
 */
export declare const linesOf: (text: string) => string[];
/** The conflicted hunks in one file's merged text (merge or diff3 markers; LF or CRLF). */
export declare function parseConflicts(file: string, text: string): ConflictHunk[];
export interface Side {
    /** e.g. "this PR (#12, issue #40)" or "main: #15 Add the orders table" */
    label: string;
    /** What the side was for: its issue and PR description. */
    intent: string;
}
/**
 * The worker's brief for a conflict fix: every conflicted hunk with both sides' text, and what each side was
 * for, so a resolution keeps both behaviors. The worker may change only the conflicted hunks.
 */
export declare function conflictBrief(o: {
    baseRef: string;
    baseSha: string;
    strategy: 'merge' | 'rebase';
    hunks: ConflictHunk[];
    ours: Side;
    theirs: Side[];
}): string;
/**
 * Whether the resolution changed anything outside the conflicted hunks. `conflicted`: each conflicted file's
 * text with markers, as the merge left it. `resolved`: the same files after the fix. `otherChanged`: files
 * the fix changed that the merge had already merged cleanly (any is outside). Returns what was touched outside.
 */
export declare function outsideHunks(conflicted: Record<string, string>, resolved: Record<string, string | null>, otherChanged: string[]): string[];
/** Why a resolved PR waits for the owner instead of auto-merging (empty: the merge policy decides as usual). */
export declare function conflictWaitReasons(o: {
    outside: string[];
    riskCategories: string[];
    evaluator: {
        approved: boolean;
        confidence: string;
        confidenceReason?: string | undefined;
        bothSidesKept: boolean | null;
    };
}): string[];
/**
 * The evaluator's verdict for a conflict fix: the usual verdict plus an explicit answer on whether the
 * resolution keeps both sides' behavior (required, so silence is never a yes).
 */
export declare function conflictVerdictSchema<T extends {
    required: readonly string[];
    properties: object;
}>(base: T): T & {
    required: string[];
    properties: {
        both_sides_kept: {
            type: string;
            description: string;
        };
    };
};
