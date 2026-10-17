import type { CommitCheck } from './backlog/types.js';
export type CheckOutcome = 'pass' | 'fail' | 'pending' | 'cancelled' | 'skipped' | 'missing';
export interface RequiredCheck {
    name: string;
    outcome: CheckOutcome;
    /** The check run's id (its Actions job), for fetching the log of a failure. */
    id?: number;
    url?: string;
}
/** Each required check's outcome on a commit; a check run wins over a status of the same name. */
export declare function requiredOutcomes(required: string[], checks: CommitCheck[]): RequiredCheck[];
export interface Readiness {
    ready: boolean;
    /** Why it isn't ready (empty when it is). */
    reasons: string[];
    checks: RequiredCheck[];
    /** The required checks that failed (not pending, cancelled or skipped): what a CI fix run would look at. */
    failed: RequiredCheck[];
}
export declare function readiness(o: {
    required: string[];
    checks: CommitCheck[];
    head: string;
    evaluated: {
        head: string;
        approved: boolean;
    } | null;
}): Readiness;
