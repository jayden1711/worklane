import { MergeFlow } from './merge-flow.js';
/** How often the harness's PRs are checked for reviews that request changes and for unmerged closes. */
export declare const REVIEW_POLL_MS: number;
/** The corrections run reads, never writes. */
export declare const CORRECTIONS_TOOLS: string[];
export declare const CORRECTIONS_DISALLOWED: string[];
export declare abstract class Corrections extends MergeFlow {
    /** The corrections run in flight (one at a time). */
    protected correctionsRun: Promise<void>;
    private correctionsBusy;
    private reviewsPolledAt;
    /** Closed PRs already looked at by this process. */
    private closedSeen;
    /** Record new corrections, then start the next corrections run if none is running. Returns the run in flight. */
    checkCorrections(): Promise<void>;
    /** Reviews requesting changes on the harness's open PRs, and its PRs a writer closed without merging. */
    private prCorrections;
    /** Corrections recorded and not yet acted on, oldest first. */
    private pendingCorrections;
    /** Agent runs on corrections today (each outcome it produced). */
    private correctionRunsToday;
    private nextCorrection;
    /** A repeat of a correction whose fix was filed: say so on the fix's issue, so the owner sees it came up again. */
    private noteRepeat;
}
