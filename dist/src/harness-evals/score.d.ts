import type { EventPayload, StoredEvent } from '../events/types.js';
export interface TaskScore {
    success: boolean;
    /** The coordinator's own done_when checks on the final change passed (null: they never ran). */
    doneWhen: boolean | null;
    /** The evaluator approved the final change (patch and test correct; null: no verdict). */
    verdict: boolean | null;
    outcome: EventPayload<'harness_eval.task'>['outcome'];
    costUsd: number;
    /** Decisions asked of the owner, and every time the task waited for the owner (blocked, held from merging). */
    interventions: number;
    detail: string;
}
/**
 * Score one replay from its scratch instance's event log. Success: the last verify of the issue passed every
 * done_when check and the last evaluator verdict on it approved the patch and the test. Cost: every run.cost.
 */
export declare function scoreReplay(events: StoredEvent[], issue: number, o?: {
    budgetHit?: boolean;
    error?: string;
}): TaskScore;
export declare const round: (x: number) => number;
export interface RunTotals {
    runs: number;
    passed: number;
    costUsd: number;
    wallMs: number;
    interventions: number;
}
export declare function totals(scores: {
    success: boolean;
    cost_usd: number;
    wall_ms: number;
    interventions: number;
}[]): RunTotals;
/** A run as the dashboard and the PR comment read it: its summary and its tasks' replays. */
export interface EvalRun {
    run: EventPayload<'harness_eval.run'>;
    at: string;
    tasks: EventPayload<'harness_eval.task'>[];
}
/** Every finished harness eval run in the log, oldest first, with its tasks. */
export declare function evalRuns(events: StoredEvent[]): EvalRun[];
/** The baseline a run is compared with: the latest earlier run that finished (not stopped by its budget, no error). */
export declare function baselineFor(runs: EvalRun[], id: string): EvalRun | null;
/**
 * The PR comment: this run's scores beside the baseline's, with the change in each. Held-out tasks are counted, never
 * named: their repositories and texts are private.
 */
export declare function commentMarkdown(cur: EvalRun, base: EvalRun | null, brand: string): string;
/** One run as the dashboard shows it: its scores per replay, and the change from its baseline. */
export interface EvalRunRow {
    id: string;
    at: string;
    trigger: EventPayload<'harness_eval.run'>['trigger'];
    engine: string | null;
    pr: number | null;
    runs: number;
    passed: number;
    successRate: number | null;
    costPerRun: number | null;
    wallMsPerRun: number | null;
    interventionsPerRun: number | null;
    costUsd: number;
    budgetUsd: number;
    stopped: boolean;
    error: string | null;
    /** This run's success rate minus its baseline's (the last earlier finished run); null: no baseline. */
    successDelta: number | null;
    costDelta: number | null;
}
export interface EvalTaskRow {
    task: string;
    heldOut: boolean;
    passed: number;
    samples: number;
    costUsd: number;
    outcomes: string[];
}
/** The dashboard's panel (GET /api/harness-evals): the latest runs, newest first, and the latest run's tasks. */
export declare function harnessEvalView(events: StoredEvent[], limit?: number): {
    runs: EvalRunRow[];
    latest: EvalTaskRow[];
};
