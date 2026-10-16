import { Intake } from './intake.js';
export declare abstract class Recovery extends Intake {
    private readonly closedWatch;
    /**
     * After a crash or restart: a task that was mid-pipeline (claimed, not yet
     * queued for landing or waiting on a decision) has no live run anymore, so
     * it's released and requeued; its history stays in the log. Queued
     * landings and open decisions resume from the log on their own.
     */
    recover(): Promise<number[]>;
    protected reconcile(): Promise<number>;
    protected isTerminal(issue: number): boolean;
    /**
     * Rate-limit and budget blocks whose window has passed: relabelled `ready` (so the next dispatch takes them)
     * up to RETRY_CAP times per issue, then left blocked with a comment. Auth blocks never retry on their own.
     */
    protected retryBlocked(now?: number): Promise<void>;
}
