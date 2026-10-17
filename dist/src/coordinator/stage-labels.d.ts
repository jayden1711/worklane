import type { EventPayload, StoredEvent } from '../events/types.js';
import { type ClassifiedRun } from '../failure-modes.js';
import type { RunRecord } from '../run-record.js';
import type { AgentRunner, RunRequest } from '../runner.js';
import { type FailedRun, type RunTrace } from '../stage-label.js';
/** Judge calls per report at most, whatever the budget left: the weekly section needs a sample, not every run. */
export declare const STAGE_JUDGE_MAX = 20;
/** What one judge call may cost (its maxBudgetUsd): the daily budget must still have this much left to start one. */
export declare const STAGE_JUDGE_USD = 0.5;
/**
 * The week's failed worker runs that have a record and no label yet, oldest first; with them, the planner runs and
 * proposed worker runs whose trace alone gives a label (traceStage).
 */
export declare function unlabelledFailures(events: StoredEvent[], records: RunRecord[], since: Date, until: Date): {
    run: ClassifiedRun;
    record: RunRecord;
}[];
/**
 * The issue's events around a run, in log order: before its start, and from its start up to the next run of the
 * same role on the issue.
 */
export declare function runTrace(c: ClassifiedRun, events: StoredEvent[]): RunTrace;
/** What the labeller sees of one run: its outcome, the events recorded for it, its commands and steps, its done_when, its trace. */
export declare function asFailedRun(c: ClassifiedRun, rec: RunRecord, events: StoredEvent[], doneWhen: string[], doneWhenTests?: string[]): FailedRun;
export interface StageLabelDeps {
    events: StoredEvent[];
    records: RunRecord[];
    since: Date;
    until: Date;
    instance: string;
    runner: AgentRunner;
    cwd: string;
    model?: string;
    /** The judge's route, for a model that names an open-model provider (src/providers.ts). */
    route?: RunRequest['route'];
    /** The issue's done_when command lines ([] when it has none or can't be read), and with them its test files. */
    doneWhenOf: (issue: number) => Promise<string[] | {
        commands: string[];
        tests: string[];
    }>;
    spentToday: () => number;
    dailyBudgetUsd: number;
    emit: <T extends 'run.stage_labeled' | 'run.cost'>(type: T, payload: EventPayload<T>) => void;
}
/** Label the week's unlabelled failed runs; how many were labelled. */
export declare function labelWeek(d: StageLabelDeps): Promise<number>;
