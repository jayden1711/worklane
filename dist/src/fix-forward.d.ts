import type { EventPayload, StoredEvent } from './events/types.js';
import type { RequiredCheck } from './pr-watch.js';
export declare const FIX_FORWARD_EVENTS: readonly ["fix_forward.started", "fix_forward.tested", "fix_forward.culprit", "fix_forward.attempt", "fix_forward.attempt_failed", "fix_forward.finished", "fix_forward.green"];
/** At most this many first-parent commits since the last green are bisected (as CI's batch bisect). */
export declare const MAX_CANDIDATES = 50;
/** The review categories (review.yaml, src/review.ts) whose culprit is reverted at once: the owner's protected paths. */
export declare const REVERT_FIRST_CATEGORIES: readonly ["money-path", "auth", "secrets"];
/** The label on a fix task's issue. */
export declare const FIX_FORWARD_LABEL = "fix-forward";
type P<T extends (typeof FIX_FORWARD_EVENTS)[number]> = EventPayload<T>;
export interface Attempt {
    id: number;
    at: string;
    attempt: P<'fix_forward.attempt'>;
    failed: P<'fix_forward.attempt_failed'> | null;
}
export interface Episode {
    /** The started event's id and time. */
    id: number;
    at: string;
    started: P<'fix_forward.started'>;
    /** Each candidate's latest test, by sha. */
    tested: Map<string, P<'fix_forward.tested'> & {
        at: string;
    }>;
    culprit: P<'fix_forward.culprit'> | null;
    attempts: Attempt[];
    finished: P<'fix_forward.finished'> | null;
    green: P<'fix_forward.green'> | null;
}
/** Every red default branch fix-forward took on, oldest first, as the log has it. */
export declare function episodes(events: readonly StoredEvent[]): Episode[];
/** The red default branch fix-forward is on now (not green again yet), or null. */
export declare const openEpisode: (events: readonly StoredEvent[]) => Episode | null;
/**
 * A candidate's verdict from the checks on its own commit, for the checks that failed on the red one: bad when one
 * failed, good when all passed, pending while one runs, untested otherwise (cancelled, skipped, missing: a run that
 * CI cancelled for a newer commit, or never had).
 */
export declare function candidateVerdict(outcomes: RequiredCheck[]): 'good' | 'bad' | 'pending' | 'untested';
/**
 * Why a culprit is reverted at once, one line per reason (empty: fix it forward): its files in
 * fix_forward.revert_first_paths, or in the money-path list or the auth or secrets categories (`categories`: what
 * computeLevel found in its files).
 */
export declare function revertFirstReasons(o: {
    files: string[];
    globs: string[];
    categories: Record<string, string[]>;
}): string[];
/** How the culprit is named in a post or a comment. */
export declare function culpritLabel(c: P<'fix_forward.culprit'> | null): string;
/** The ops post when the default branch goes red: its failing checks and the culprit, and what happens next. */
export declare function redText(ep: Episode, o: {
    branch: string;
    next: string;
}): string;
/** The ops post when it is green again: by which fix PR, or the revert of which PR. */
export declare function greenText(ep: Episode, g: P<'fix_forward.green'>, o: {
    branch: string;
}): string;
/** The merged PRs since the last green, as listed in a fix task and a revert. */
export declare function mergedList(ep: Episode, repo: string): string[];
/** A fix task's issue: the failure, the culprit and its diff, the merged PRs, earlier attempts, and its contract. */
export declare function fixIssue(ep: Episode, o: {
    branch: string;
    repo: string;
    attempt: number;
    logs: string[];
    diff: string;
    product: string;
}): {
    title: string;
    body: string;
};
/** The evidence in a revert PR's body: why reverting, the culprit, the bisect, and the fix attempts. */
export declare function revertEvidence(ep: Episode, o: {
    repo: string;
    why: string;
}): string;
export {};
