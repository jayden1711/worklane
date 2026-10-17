import { type EvalRouting, type Verdict } from '../eval-routing.js';
import { type ChangeFile, type Level } from '../review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { RunResult } from '../runner.js';
/** run.cost roles: the evaluator's first run, and its escalation to the stronger model. */
export declare const EVAL_COST_ROLE = "evaluator-verdict";
export declare const ESCALATED_COST_ROLE = "evaluator-escalated";
/**
 * The level a change routes at, before any verdict: its review level from the files and labels (a comment-only
 * change routes as L0), raised to L2 by a tamper flag. A level that can't be computed routes to the strong model.
 */
export declare function evalLevel(o: {
    files: ChangeFile[];
    labels: string[];
    moneyPaths: () => RegExp[];
    review: ReviewConfig;
    tampered: string[];
}): Level;
export interface JudgeRun {
    r: RunResult;
    /** Its run record's id (null when nothing was recorded). */
    runId: string | null;
}
export interface Judged extends JudgeRun {
    model: string;
    /** The cheap model whose verdict went to the stronger one, if it did. */
    escalatedFrom: string | null;
    /** Changed files the deciding run never read, from its record. */
    unread: string[];
}
/** Changed files a run never read, from its record; a run with no record read nothing. */
export declare function unreadByRun(stateDir: string, runId: string | null, changed: string[]): string[];
/**
 * Judge a change: the model for its level first; a verdict from the cheap model that isn't a confident,
 * fully read pass goes once to the stronger model, whose verdict is final. `run` starts one evaluator run
 * with a model and the run.cost role to book it under.
 */
export declare function judge(o: {
    level: Level;
    strongModel: string;
    routing: EvalRouting;
    changed: string[];
    stateDir: string;
    run: (model: string, costRole: string) => Promise<JudgeRun>;
    verdictOf: (r: RunResult) => Verdict | null;
}): Promise<Judged>;
