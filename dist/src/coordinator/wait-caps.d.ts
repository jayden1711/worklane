/** Polls of one PR head whose mergeable state stays unknown before it waits for the owner. */
export declare const MERGEABLE_CAP = 10;
/** Polls of one PR head whose combined check says "conflict" while GitHub says it merges, before the owner. */
export declare const LIGHT_PENDING_CAP = 10;
/** How long the checks on an auto-merge's commit may take to report before the wait is given up. */
export declare const MAIN_CHECKS_TIMEOUT_MS: number;
/** At least this many polls of an auto-merge's checks, whatever the poll interval (it is 0 in tests). */
export declare const MAIN_CHECKS_MIN_POLLS = 20;
/** The polls a timeout allows at a poll interval: the timeout over the interval, never fewer than `min`. */
export declare function pollsFor(timeoutMs: number, pollMs: number, min: number): number;
/** Counts consecutive polls of a waiting item (by key); forgotten on restart, which only restarts the count. */
export declare class PollCounter {
    private counts;
    /** One more poll of `key` still waiting: the count so far, this one included. */
    bump(key: string): number;
    clear(key: string): void;
}
/**
 * When one queued land started waiting on the full-run slot: from its land.result outcomes since it was queued
 * (oldest first, each with its time in ms), the time of the first deferral in the trailing run of deferrals for a
 * held slot; null if it isn't in such a run. Another kind of deferral neither starts nor breaks the run.
 */
export declare function slotDeferringSince(results: {
    outcome: string;
    detail: string;
    at: number;
}[]): number | null;
