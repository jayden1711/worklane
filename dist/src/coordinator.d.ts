import type { Config } from './config/load.js';
import { type Backlog, type DoneWhenList, type Issue } from './backlog/types.js';
import type { EventLog } from './events/log.js';
import type { EventPayload } from './events/types.js';
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
    /** Nightly queuing (tests inject this). */
    nightly?: (root: string, cfg: Config, eventsDb: string, actor: string) => {
        id: string;
    }[];
    /** Machine readings (tests inject these). */
    machine?: {
        load(): number | null;
        disk(path: string): {
            freePct: number;
            totalGb: number;
        };
    };
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
    private lastSeen;
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
    private lastHold;
    /** Actionable ready issues seen on the last dispatch pass (for idle-hours). */
    private readyCount;
    /** Post the report for the latest configured time already passed today, once. */
    maybeReport(now?: Date): Promise<void>;
    /** Once a day: new lessons go to the project's lessons folder on a branch, as a PR for the owner. */
    maybeLessons(now?: Date): Promise<void>;
    private extraCtx;
    /** Write one file on a fresh branch off main and open a PR for it (lessons, release notes). Main is untouched. */
    private openDocPr;
    stage(): number;
    /**
     * Once a day: score the window. A regression demotes one stage on its own
     * (never below the configured start); a healthy streak asks the owner to
     * promote, if review.yaml defines a next stage.
     */
    private maybeTrust;
    /** Queue the nightly runs once a day, after tests.yaml nightly_at. */
    private maybeNightly;
    /** Why no new agent may start right now, or null. Load and disk are machine-wide. */
    governorHold(): {
        reason: string;
        load: number | null;
        freeDiskPct: number | null;
    } | null;
    private noteHold;
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
    /** Queued changes without a final landing result, oldest first. "deferred" isn't final. */
    private landQueue;
    private filesOf;
    /** Seed with the oldest; add later changes whose files don't overlap, at most one L3, up to batch_max. */
    buildBatch(queue: EventPayload<'land.queued'>[]): EventPayload<'land.queued'>[];
    private landNext;
    private gateTiers;
    private tierCommand;
    /** Run the land gates: baseline-aware, a failure retried once (flake), exclusive tiers under the machine-wide lock. */
    private runGates;
    /**
     * Land a batch on the tip in one tested commit. On a red gate: retry once
     * (flake), then split in half and land each half on its own (bors-style
     * bisection); a single change that's still red is ejected with the evidence.
     */
    private landBatch;
    private afterLand;
    /** Trigger a deploy, then confirm the environment serves the exact sha. A skipped deploy is a failure. */
    deploy(env: string, trigger: string, verify: string, sha: string, polls?: number, pollMs?: number): Promise<boolean>;
}
