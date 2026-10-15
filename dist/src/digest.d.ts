import { type UpdateEntry } from './updates.js';
import { type BatchSummary } from './coordinator/pr-batch.js';
interface Ev {
    type: string;
    ts: string;
    payload: unknown;
}
/** The owner-held states, in the order the digest lists them. */
export declare const WAIT_KINDS: readonly ["emergency_halt", "merge_stopped", "main_checks_timed_out", "awaiting_decision", "plan_held", "needs_owner", "ci_fix_gave_up", "blocked", "landing_failed", "deploy_failed", "check_held", "hotspot_held", "update_held"];
export type WaitKind = (typeof WAIT_KINDS)[number];
export declare const WAIT_LABEL: Record<WaitKind, string>;
export interface WaitItem {
    kind: WaitKind;
    /** When the wait began (ISO). */
    since: string;
    issue: number | null;
    pr: number | null;
    title: string | null;
    /** Why it waits, in a line. */
    detail: string;
    /** For a failed deploy: the commit. */
    sha?: string;
    /** For a PR left to the owner as high-risk: each category it touches, plainly, with its first file (merge-policy.ts whyHighRisk). */
    why?: {
        category: string;
        text: string;
    }[];
}
/** A PR the harness merged on its own, for the owner's morning sampling. */
export interface MergedItem {
    pr: number;
    issue: number;
    title: string;
    url: string;
    at: string;
    /** The review level of the merged head (review.level_set), or null if none was recorded. */
    level: string | null;
    /** The evaluator's confidence in its verdict on the merged head (eval.verdict), or null. */
    confidence: string | null;
}
export interface Digest {
    at: string;
    items: WaitItem[];
    /** Since when `merged` reaches: the last digest, or 24 hours back. */
    mergedSince: string;
    merged: MergedItem[];
    /** PR batches (PR mode with batching) running now or active since `mergedSince`, oldest first. */
    batches: Pick<BatchSummary, 'id' | 'status' | 'prs' | 'detail' | 'at' | 'last'>[];
}
/** The PR batches running at `now` or with a step after `since`. */
export declare function batchesSince(events: Ev[], since: Date, now: Date): Digest['batches'];
/**
 * The PRs auto-merged after `since` (merge.done is the auto-merge path's), each with the review level and the
 * evaluator's confidence for the head it merged (or the issue's latest, where none matches the head).
 */
export declare function mergedSince(events: Ev[], since: Date, now: Date): MergedItem[];
/**
 * Every owner-held state open at `now`. Each one starts at the event that opened it and stays until the event
 * that ends it: an answer, a merge or close, a resume, a later verified deploy, a release, a new head.
 * And the PRs merged on their own since the last digest (`since`; 24 hours back by default), for sampling.
 */
export declare function waitingOnYou(events: Ev[], now?: Date, o?: {
    since?: Date; /** The machine's engine update log (updates.ts); read from its file when not given. */
    updates?: UpdateEntry[];
}): Digest;
/** How long, in words: minutes, hours, or days. */
export declare function waited(since: string, now: Date): string;
/**
 * The digest as Markdown for a GitHub issue comment: a heading with the count, a section per kind, a line per
 * wait with how long it has waited and its issue or PR (`#n`, which GitHub links). Pure: same input, same text.
 */
export declare function digestMarkdown(d: Digest, o?: {
    project?: string;
}): string;
export {};
