import type { DoneWhenList } from './backlog/types.js';
import type { AgentRunner, RunRequest } from './runner.js';
/** In pipeline order: the plan, the build, its checks, the evaluator's review; the harness last. */
export declare const STAGES: readonly ["plan", "wrong files", "right files, wrong place", "wrong or incomplete change", "verification", "review", "environment/harness"];
export type Stage = (typeof STAGES)[number];
/** The labels the judge picks from. environment/harness, plan and review are code's alone; verification is the judge's only for a run that ran its checks. */
export declare const JUDGE_STAGES: readonly ["wrong files", "right files, wrong place", "wrong or incomplete change", "verification"];
export declare const STAGE_HINTS: Record<Stage, string>;
/** Events that mean the harness or the machine, not the change, ended the run. */
export declare const HARNESS_EVENTS: readonly ["run.startup_failed", "run.transient_retry", "run.stuck", "console.run_stopped"];
export declare const STAGE_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["stage", "reason"];
    readonly properties: {
        readonly stage: {
            readonly enum: readonly ["wrong files", "right files, wrong place", "wrong or incomplete change", "verification"];
        };
        readonly reason: {
            readonly type: "string";
            readonly maxLength: 300;
        };
    };
};
export interface StageLabel {
    run: string;
    stage: Stage;
    reason: string;
    /** Who set it: code (from events and the run record) or the judge. */
    by: 'code' | 'judge';
    costUsd: number;
}
/** What the labeller sees: the run's redacted record, already summarized by the caller. */
export interface FailedRun {
    run: string;
    issue: number | null;
    role: string;
    /** The run's outcome as failure-modes classified it. */
    ended: string;
    /** Why the coordinator called it a failure: rejected change, failing checks, evaluator verdict, the block reason. */
    why: string;
    /** The event types recorded for this run. */
    events: string[];
    /** The issue's done_when commands; empty when it has none (then nothing is inferred from them). */
    doneWhen: string[];
    /** The shell commands in the run record, as run. */
    commands: string[];
    /** The run's steps as recorded (commands with status, files written), redacted and capped. */
    steps: string;
    final: string;
    /** The issue's done_when test files (a subset of doneWhen's lines); absent or empty: none. */
    doneWhenTests?: string[];
    /** The run's trace, from the event log; absent (an eval fixture, an older caller): no plan or review label. */
    trace?: RunTrace;
}
/** One of the issue's events, as recorded. */
export interface TraceEvent {
    type: string;
    payload: Record<string, unknown>;
}
/** The issue's events around one run, oldest first. */
export interface RunTrace {
    /** Before the run started: the plan it was built from is here. */
    before: TraceEvent[];
    /** From the run's start up to the next run of the same role on the issue (what happened to this run's work). */
    during: TraceEvent[];
}
/** The command lines that run an issue's done_when checks, as a run would type them: its commands, its test files (any command naming one), the project's suite. */
export declare function doneWhenCommands(list: DoneWhenList, runner: {
    changed: string;
    full: string;
}): string[];
/** Whether any line of any done_when command appears in a command the run ran. */
export declare function ranDoneWhen(doneWhen: string[], commands: string[]): boolean;
/** The label code sets without a judge call, or null when the judge has to decide. */
export declare function codeStage(f: FailedRun): {
    stage: Exclude<Stage, 'plan' | 'review'>;
    reason: string;
} | null;
/**
 * plan or review, set by code from the run's trace, or null when the trace doesn't show it (then the label is
 * whatever it would have been). plan: a planner run whose plan the plan gate turned down (plannerEvidence), or a
 * worker run whose failing checks are all done_when tests its plan never names (omittedTest). review: a worker run
 * whose evaluator passed a head that then failed the PR's checks, or rejected a head that then merged green
 * (reviewEvidence). Evidence for both is ambiguous: null.
 */
export declare function traceStage(f: FailedRun): {
    stage: 'plan' | 'review';
    reason: string;
} | null;
/** A run only a trace label can label (a planner run, or a worker run whose change was proposed): never the judge's. */
export declare function traceOnly(f: Pick<FailedRun, 'role' | 'ended'>): boolean;
export declare function stagePrompt(f: FailedRun): string;
export interface LabelOptions {
    runner: AgentRunner;
    model?: string;
    route?: RunRequest['route'];
    cwd: string;
    /** Called before each judge call: false means the day's cap is reached and no call is made. */
    allowed: () => boolean;
    /** Each call's estimated cost, to count against the cap. */
    onCost?: (usd: number) => void;
}
/** A code label when the facts give one; otherwise one judge call. Null when the cap stops it or the answer isn't a valid label. */
export declare function labelFailedRun(f: FailedRun, o: LabelOptions): Promise<StageLabel | null>;
/** Label a batch, oldest first. Once the cap is reached, runs that need the judge are left unlabelled; code labels still apply. */
export declare function labelFailedRuns(runs: FailedRun[], o: LabelOptions): Promise<StageLabel[]>;
