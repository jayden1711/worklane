/** Every comment a pass leaves carries this, so its own comments never count as activity on the PR. */
export declare const HYGIENE_MARKER: string;
export type HygieneOutcome = 'merged_in' | 'conflicting' | 'closed' | 'held' | 'skipped';
export interface HygieneCounts {
    merged_in: number;
    conflicting: number;
    closed: number;
    held: number;
    skipped: number;
}
/** One PR's result in a pass. */
export interface HygieneResult {
    number: number;
    outcome: HygieneOutcome;
    why: string;
}
/** A merge-in the harness pushed: `from` the head before it, `head` the merge commit, `base_sha` the default branch it merged. */
export interface MergeIn {
    number: number;
    from: string;
    head: string;
    base_sha: string;
}
/** A pass is due when none ran yet, or the last one is at least `everyHours` old. */
export declare function hygieneDue(lastPassAt: string | null, nowMs: number, everyHours: number): boolean;
/** Whether a base made at `baseAtMs` is older than `days`. */
export declare const isStale: (baseAtMs: number, nowMs: number, days: number) => boolean;
/** Whole days between two times, for messages. */
export declare const daysBetween: (fromMs: number, toMs: number) => number;
/**
 * Why a PR is left alone because it waits on a person (empty: it doesn't). A hold label on it; the merge policy left
 * this head to an owner; or someone else pushed to it (the harness never pushes over that).
 */
export declare function heldReasons(o: {
    labels: string[];
    holdLabels: string[];
    waitsOwner: boolean;
    head: string;
    ourHead: string | null;
}): string[];
/** A later PR the harness opened for the same task, which supersedes this one; null when there is none. */
export declare function supersededBy(opened: {
    issue: number;
    number: number;
}[], pr: {
    issue: number;
    number: number;
}): number | null;
/**
 * The last activity on a PR: its newest commit (before the harness's own merge-ins), comment (not the pass's own) or
 * review. null when a comment's time is unknown: then nothing proves it abandoned.
 */
export declare function lastActivity(o: {
    commitAtMs: number;
    comments: {
        body: string;
        at?: string;
    }[];
    reviewsAt: string[];
}): number | null;
/**
 * Abandoned: its task is closed or superseded, and nothing happened on it for `abandonDays`. `why` says which, for the
 * closing comment (or, when not abandoned yet, why it is left as is).
 */
export declare function abandoned(o: {
    taskClosed: boolean;
    supersededBy: number | null;
    lastActivityMs: number | null;
    nowMs: number;
    abandonDays: number;
    task: number;
}): {
    abandoned: boolean;
    why: string;
};
/**
 * The head a PR had before the harness's merge-ins on top of it: what the evaluator judged, when nothing else moved it.
 * `number` null: whichever PR the merge-ins were on (a commit is on one PR's branch).
 */
export declare function carriedHead(mergeIns: MergeIn[], number: number | null, head: string): string;
/** The default-branch commit a merge-in at `head` merged: the base the PR's own change is measured from. */
export declare function mergeInBase(mergeIns: MergeIn[], number: number, head: string): string | null;
export declare function countsOf(results: HygieneResult[]): HygieneCounts;
/** One line of counts, as the dashboard and a digest show it. */
export declare function hygieneLine(c: HygieneCounts): string;
/**
 * The digest hook: every pass since `sinceMs`, summed (a weekly digest calls this with a week ago). Events are the
 * log's pr_hygiene.pass events, oldest first.
 */
export declare function hygieneWeek(events: {
    type: string;
    ts: string;
    payload: unknown;
}[], sinceMs: number): HygieneCounts & {
    passes: number;
    line: string;
};
