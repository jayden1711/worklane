/** What a refusal from GitHub's merge API means for the train. */
export type MergeRefusal = 
/** Strict protection: the branch must be up to date with its base first. Retried later (backoff). */
'behind'
/** The base moved while GitHub merged (another merge of this pass landed first). Retried later (backoff). */
 | 'base_moved'
/** The head is no longer the one asked for (`sha` pinned to it): nothing merged; the new head is decided afresh. */
 | 'head_moved'
/** Anything else: a merge failure, counted (three at one head and it goes to the owner). */
 | 'other';
/** GitHub's merge API's words for each refusal (405 / 409). */
export declare function mergeRefusal(why: string): MergeRefusal;
/** Retried later rather than counted as a failure. */
export declare const deferrable: (r: MergeRefusal) => r is "behind" | "base_moved";
/** A PR GitHub reports as behind its base: it waits (strict protection), it isn't a human's call and isn't merged. */
export declare const isBehind: (pr: {
    mergeable: boolean | null;
    mergeableState: string;
}) => boolean;
export declare const DEFER_FIRST_MS: number;
export declare const DEFER_MAX_MS: number;
/**
 * When a PR whose merge was deferred `times` times already (at this head) is tried again: 2 min, doubling, at most
 * 30 min. Never sooner, whatever the poll interval, so a refusal is never retried in a loop.
 */
export declare function deferDelay(times: number): number;
/** A deferral recorded in the log (merge.deferred). */
export interface Deferral {
    number: number;
    head: string;
    retry_at: string;
}
/** Whether PR `number` at `head` is still deferred at `now` (its latest deferral's retry time not reached), and how many it had. */
export declare function mergeDeferral(deferrals: Deferral[], number: number, head: string, now: number): {
    waiting: boolean;
    times: number;
    retryAt: number | null;
};
/**
 * The merges of one pass of the PR watch, up to the instance's cap (tests.yaml land.parallel_merges). A PR over the
 * cap isn't merged this pass; it is the first looked at on the next one.
 */
export declare class MergePass {
    private readonly cap;
    private merged;
    constructor(cap: () => number);
    start(): void;
    room(): boolean;
    took(): void;
    get count(): number;
}
/**
 * The merge commit's subject and body. GitHub's own default subject ("Merge pull request #n from <owner>/<branch>")
 * names a handle, which the push gate refuses on the default branch; so the train always sets both, and takes any
 * @handle and e-mail address out of the PR's title. The body is fixed text: no PR body, no names.
 */
export declare function mergeMessage(o: {
    title: string;
    number: number;
    head: string;
    product: string;
}): {
    subject: string;
    body: string;
};
