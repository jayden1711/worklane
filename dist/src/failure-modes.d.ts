import type { StoredEvent } from './events/types.js';
import type { MergeMetrics } from './merge-metrics.js';
import type { RunRecord } from './run-record.js';
import { type StageLabel } from './stage-label.js';
export type Outcome = 'startup failure' | 'no change' | 'change rejected' | 'checks failed' | 'evaluator rejected' | 'push refused' | 'timed out' | 'stuck' | 'rate limited' | 'budget reached' | 'auth problem' | 'canceled' | 'failed' | 'proposed' | 'succeeded';
/** A failed run under this long that committed nothing never got to work (matches the coordinator's rule). */
export declare const STARTUP_SECS = 90;
/** A cause seen this many times in the window gets a proposed fix. */
export declare const REPEATED = 3;
export interface ClassifiedRun {
    issue: number;
    role: string;
    attempt: number | null;
    startedAt: string;
    endedAt: string;
    seconds: number;
    outcome: Outcome;
    /** Normalized: the same failure gives the same cause. */
    cause: string;
    /** The run record's id, when one matched (dashboard: /runs/<id>). */
    runId: string | null;
    /** What the coordinator did about the issue afterwards, when it gave up (the block reason). */
    blocked: string | null;
}
export interface CauseCount {
    outcome: Outcome;
    cause: string;
    count: number;
    issues: number[];
    examples: ClassifiedRun[];
}
/** A decision's options are answered by name (buttons, `decide <id> <option>`), so they're short; what each does is in the receipts. */
export declare const FIX_OPTIONS: readonly ["make it impossible", "test or lint", "written rule", "leave it"];
export interface FailureProposal {
    /** Stable for a cause, so the same proposal isn't asked twice. */
    key: string;
    question: string;
    /** Ranked by the repo's rule: make the wrong thing impossible > a test or lint > a written rule; then leave it. */
    options: string[];
    recommendation: string;
    /** What each option would do, then the evidence: counts, example runs, what the coordinator reported. */
    receipts: string[];
}
export interface FailureModes {
    since: string;
    until: string;
    runs: ClassifiedRun[];
    byOutcome: {
        outcome: Outcome;
        count: number;
    }[];
    top: CauseCount[];
    proposals: FailureProposal[];
}
/** Error text to a cause: ids, hashes, numbers, paths, quotes and durations out, whitespace folded. */
export declare function normalizeCause(text: string): string;
/** Every run that ended in [since, until), in one outcome each. */
export declare function classifyRuns(events: StoredEvent[], since: Date, until: Date, records?: RunRecord[]): ClassifiedRun[];
export declare function failureModes(events: StoredEvent[], opts: {
    since: Date;
    until: Date;
    records?: RunRecord[];
}): FailureModes;
/** The report section: how runs ended, the most common causes with example runs, and fixes waiting for a decision. */
export declare function failureModesMarkdown(f: FailureModes): string[];
/** What conflict fixes, combined-state checks and hotspot holds cost this week, with tuning suggestions (never applied). */
export declare function mergeCostMarkdown(m: MergeMetrics): string[];
/**
 * The weekly section for the earliest failed stage: per stage, how many failed runs each instance had there, and
 * example reasons. plan and review are code's, from the run's trace: every one of them shows its evidence line.
 */
export declare function stageLabelsMarkdown(labels: (StageLabel & {
    instance: string;
})[], opts?: {
    examples?: number;
}): string[];
