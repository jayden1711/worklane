import type { StoredEvent } from './events/types.js';
export interface Scorecard {
    from: string;
    to: string;
    tasksDone: number;
    /** Share of evaluator verdicts that approved the patch. */
    evaluatorPassRate: number | null;
    /** Worker runs that said "done" but whose change then failed inspection, checks or the evaluator. */
    unverifiedClaimRate: number | null;
    /** Landed commits later reverted on main (from the caller's git history). */
    reverts: number;
    /** Land gates that caught a new red, and baseline failures added since the window began. */
    redCaught: number;
    baselineGrowth: number;
    costPerDoneUsd: number | null;
    /** Median hours from first actionable to done (deployed, or landed when no deploy target). */
    readyToDoneHours: number | null;
    /** Decisions answered plus blocks, per finished task. */
    interventionsPerTask: number | null;
    /** Hours the crew sat idle while ready work waited (capacity left unused). */
    idleHours: number;
    /** Hours decisions waited on their owner, and hours tasks sat blocked. */
    decisionWaitHours: number;
    blockedHours: number;
    spendUsd: number;
}
export declare function scorecard(events: StoredEvent[], opts: {
    from: Date;
    to?: Date;
    revertedShas?: Set<string>;
}): Scorecard;
