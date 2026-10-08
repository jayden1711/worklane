import type { Config } from './config/load.js';
import { type Backlog, type DoneWhenList, type Issue } from './backlog/types.js';
import type { EventLog } from './events/log.js';
import type { AgentRunner } from './runner.js';
export interface CoordinatorDeps {
    cfg: Config;
    log: EventLog;
    backlog: Backlog;
    runner: AgentRunner;
    /** The coordinator's own clone of the project (it fetches, lands and pushes here). */
    repo: string;
    remote?: string;
    instance: string;
    stateDir: string;
    /** Slot directory override (tests). */
    slotsDir?: string;
    maxAttempts?: number;
    leaseMs?: number;
}
export declare class Coordinator {
    private d;
    private readonly remote;
    private readonly wt;
    private active;
    private landing;
    private stopped;
    constructor(d: CoordinatorDeps);
    private get branch();
    private git;
    private emit;
    private events;
    /** USD spent today (UTC) by all runs, from the log. */
    spentToday(): number;
    /** One deterministic pass: reconcile, handle approvals, land, dispatch. */
    tick(): Promise<void>;
    /**
     * After a crash or restart: a task that was mid-pipeline (claimed, not yet
     * queued for landing or waiting on a decision) has no live run anymore, so
     * it's released and requeued; its history stays in the log. Queued
     * landings and open decisions resume from the log on their own.
     */
    recover(): Promise<number[]>;
    /** Wait for in-flight task pipelines (tests and graceful shutdown). */
    idle(): Promise<void>;
    stop(): void;
    private reconcile;
    private isTerminal;
    private dispatch;
    private paths;
    runTask(issue: Issue, doneWhen: DoneWhenList): Promise<void>;
    /** Read-only work: findings with evidence go to the owner; nothing is committed or landed. */
    private investigate;
    private reproduce;
    private build;
    /** Mechanical checks on what the worker produced, before anyone trusts it. */
    private inspect;
    /** The coordinator's own run of the contract: it never trusts the agent's word or its Stop gate alone. */
    private verify;
    private evaluate;
    private cost;
    private ownerOf;
    private ask;
    private block;
    private releaseClaim;
    /** Decisions answered by CLI (decision.answered) or by a writer's `/<cli> <option>` comment. */
    private handleDecisions;
    /** Answers to this issue's earlier questions, for the next worker's brief. */
    private answers;
    private landNext;
    /** Serial landing: rebase onto the tip, pre-land steps, tests, secret scan, fast-forward push. */
    private land;
    private afterLand;
    /** Trigger a deploy, then confirm the environment serves the exact sha. A skipped deploy is a failure. */
    deploy(env: string, trigger: string, verify: string, sha: string, polls?: number, pollMs?: number): Promise<boolean>;
}
