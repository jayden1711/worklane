import type { StoredEvent } from '../events/types.js';
/** Identical failures in a row that stop the attempts: the first time the task is reassigned, the second it is blocked. */
export declare const IDENTICAL_FAILURES = 3;
/** The share of a budget at which the incident is raised. */
export declare const BUDGET_WARN = 0.85;
/** The incident a task near its budget raises, keyed by instance and issue. */
export declare const TASK_BUDGET_INCIDENT = "task_budget";
/** The default attempt cap, when agents.yaml sets none. */
export declare const DEFAULT_MAX_ATTEMPTS = 8;
/** How an attempt failed, for its fingerprint. */
export type FailureKind = 'stuck' | 'rejected' | 'checks' | 'evaluator';
/** An attempt's failure, reduced so the same failure reads the same each time (ids, numbers, paths and quotes out). */
export declare function failureFingerprint(kind: FailureKind, text: string): string;
/** The fingerprint of failed checks: each failing check and the start of its output. */
export declare function checksFingerprint(failing: {
    check: string;
    tail?: string;
}[]): string;
/**
 * The issue's events since its attempt budget last reset: its last block or decision asked, after which the owner
 * relabels or answers and the task starts afresh (as the coordinator's attempt count resets).
 */
export declare function sinceReset(events: StoredEvent[]): StoredEvent[];
/** Whether the task was already reassigned since its last reset. */
export declare function reassigned(events: StoredEvent[]): boolean;
/**
 * The run of identical failures the task's attempts end on (since the reset and the last reassign): its fingerprint
 * and how many in a row.
 */
export declare function identicalStreak(events: StoredEvent[]): {
    fingerprint: string | null;
    count: number;
};
export interface TaskBudget {
    /** Agent run time for one issue, in minutes. */
    task_minutes?: number | undefined;
    /** Tokens in and out for one issue, all its runs together. */
    task_tokens?: number | undefined;
}
export interface TaskUsage {
    tokens: number;
    minutes: number;
}
/** What the issue's runs used since its reset: tokens in and out, and run time, from their run.cost events. */
export declare function taskUsage(events: StoredEvent[]): TaskUsage;
export interface BudgetState {
    level: 'ok' | 'warn' | 'over';
    /** The larger share of the two budgets used (0 with no budget). */
    share: number;
    /** What was used of what, for the incident and the block. */
    detail: string;
}
/** Where the usage stands against the budget: over at 100% of either, warn at BUDGET_WARN. */
export declare function budgetState(u: TaskUsage, b: TaskBudget | undefined): BudgetState;
/** How long the next run may take before the time budget runs out (ms), or null with no time budget. */
export declare function timeLeftMs(u: TaskUsage, b: TaskBudget | undefined): number | null;
/** The prompt for a reflection run: the issue brief, why the last attempt failed, the earlier failures, the change. */
export declare function reflectionBrief(brief: string, feedback: string[], earlier: string[], changed: string): string;
/** What the next attempt is told from a reflection. */
export declare function reflectionFeedback(s: {
    what_failed?: unknown;
    what_to_change?: unknown;
} | undefined): string[];
