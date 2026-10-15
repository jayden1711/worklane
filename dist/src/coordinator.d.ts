import { type DoneWhenList, type Issue, type PullRequest } from './backlog/types.js';
import type { EventPayload } from './events/types.js';
import { type ChangeFile } from './review.js';
import { TaskGraph } from './coordinator/task-graph.js';
import { HarnessEvals } from './coordinator/harness-evals.js';
export type { CoordinatorDeps } from './coordinator/shared.js';
export { logTail } from './coordinator/shared.js';
/** A failed worker run shorter than this that committed nothing never got to work. */
export declare const STARTUP_FAILURE_SECS = 90;
export declare class Coordinator extends HarnessEvals {
    /** One deterministic pass: reconcile, handle approvals, land, dispatch. */
    tick(): Promise<void>;
    /** Wait for in-flight task pipelines (tests and graceful shutdown). */
    idle(): Promise<void>;
    private ciMeter;
    /** CI timings for the metrics (src/ci-metrics.ts): with GitHub, at most one read-only call per CI_METRICS_CALL_MS. */
    protected measureCi(): Promise<void>;
    private mergePoster;
    /**
     * Every merge to the default branch, posted once in the ops channel (src/merge-posts.ts): with GitHub, a Discord
     * source, discord.ops_channel and discord.post_merges (on by default). Off, its place is forgotten.
     */
    protected postMerges(): Promise<void>;
    /**
     * Honor the machine-wide emergency stop: abort every running agent (their
     * tasks release their claims and requeue) and start nothing new until it
     * is lifted. Called every tick and on a short timer by the service.
     */
    checkEmergency(): void;
    /**
     * Shut down (SIGTERM, SIGINT): nothing new starts, and everything in flight is aborted rather than waited for.
     * Agent runs and project commands are aborted; their tasks requeue (runTask) and start again after the restart.
     */
    stop(): void;
    /** What a shutdown still waits on: the tick step, tasks and live runs (named in the log when it runs out of time). */
    pending(): string[];
    /**
     * Worker attempts already used on an issue, from the log: since its last block or decision (after which the
     * owner relabels or answers, and the task starts with a fresh budget). Restarts and requeues don't reset it.
     */
    private attemptsUsed;
    /** Post the report for the latest configured time already passed today, once. */
    maybeReport(now?: Date): Promise<void>;
    /** Label the week's unlabelled failed worker runs (coordinator/stage-labels.ts); a problem never stops the report. */
    private labelStages;
    /** Queue the nightly runs once a day, after tests.yaml nightly_at. */
    private maybeNightly;
    /**
     * The console's requests from the dashboard (called every few seconds and on each tick): message or stop
     * a live run. Only the owner's are acted on; every outcome is an event.
     */
    /**
     * The dashboard chat's questions (called every few seconds and on each tick). Each is answered by a
     * chief_of_staff turn through this coordinator's runner, so it holds the per-login lock like every run and
     * never overlaps another claude on the same login. Turns go one at a time; the returned promise is the queue.
     */
    checkChat(): Promise<void>;
    private chatRequest;
    checkConsole(): void;
    private consoleRequests;
    private liveCfg;
    /**
     * Follow the default branch's config: fetch it, and when its config changed, swap the new one in whole (one
     * assignment: every reader after it sees the new config) with the instance's settings over it. An invalid one is
     * never applied: the last good one stays, recorded once (and raised as an incident when there's a watchdog).
     */
    refreshConfig(): void;
    refreshSettings(): void;
    private dispatch;
    private graph_;
    protected get graph(): TaskGraph;
    /**
     * WHY: a child this instance filed from a writer's goal is worked though the tracker names the bot as its author;
     * only while it is open, labelled ready and its body is exactly as filed (an edit makes it a writer's call again).
     */
    private goalChild;
    /** INVARIANT: a goal is split once; the split is checked whole (src/goal-split.ts) before any child is filed. */
    private splitGoal;
    /** WHY: an issue planned before (a held plan approved, a requeue) is judged by its plan's files too. */
    private plannedFiles;
    /** The checkout's file list, indexed for hotspot estimates; rebuilt only when the checkout's commit or the globs change. */
    private repoFileIndex;
    /** Tasks whose latest hotspot event is a hold (from the log, so a restart doesn't count a wait twice). */
    private heldOn;
    private noteHotspotHold;
    private endHotspotHold;
    private poolBusy;
    private poolCheckedAt;
    private poolRefill;
    /**
     * Keep the worktree pool on main's tip, in the background: at most one refill at a time, checked every
     * few minutes, so a slow setup never holds the coordinator's tick.
     */
    private maybeRefillPool;
    runTask(issue: Issue, doneWhen: DoneWhenList): Promise<void>;
    /**
     * The issue's runs against its agents.yaml budget (src/coordinator/loop-control.ts). Each level is recorded once
     * per reset, and the incident is raised once, when the first is (`raised`: it is open).
     */
    private taskBudget;
    /** A build's model: as routed for the attempt, or escalated once the task was reassigned. */
    private buildModelFor;
    /**
     * Before a retry: a short read-only run on the cheap tier (model routing's `reflection`) reads why the last attempt
     * failed and the change it left, and says what failed and what to change; that goes into the next attempt's brief.
     * Its cost counts toward the issue's budget. A failed reflection never stops the task: the attempt goes on without it.
     */
    private reflect;
    /** Read-only work: findings with evidence go to the owner; nothing is committed or landed. */
    private investigate;
    private reproduce;
    private build;
    /**
     * A worker says the issue needs no change. Not taken on its word: with
     * nothing committed, the worktree is reset to the base and the coordinator
     * runs the done_when checks itself. All passing, the owner gets the
     * verdict and the evidence and decides whether to close; the task stops
     * (no retries toward a change nobody needs).
     */
    private confirmNoChange;
    /**
     * Evals of the agents' instructions a change touches (a skill, AGENTS.md, a role prompt): the same cases on
     * the instructions at the base and at the head, under the per-eval cost cap, through the runner like every
     * run (the agent user, the subscription CLI). One instructions.eval event each; anything that keeps an eval
     * from running is recorded as its error, and the merge policy waits on it.
     */
    private instructionEvals;
    /** Mechanical checks on what the worker produced, before anyone trusts it. */
    protected inspect(n: number, path: string, base: string, head: string, repro: {
        path: string;
        hash: string;
    } | null): Promise<{
        rejected: string;
        refused?: never;
        files?: never;
        tampered?: never;
        patchHash?: never;
    } | {
        rejected: string;
        refused: string[];
        files?: never;
        tampered?: never;
        patchHash?: never;
    } | {
        files: ChangeFile[];
        tampered: string[];
        patchHash: string;
        rejected?: never;
        refused?: never;
    }>;
    /** Browser baselines per (base, flow), kept across a task's attempts (src/coordinator/browser.ts). */
    private readonly browserBaselines;
    /** The coordinator's own run of the contract: it never trusts the agent's word. */
    protected verify(n: number, path: string, head: string, doneWhen: DoneWhenList, repro: {
        path: string;
    } | null): Promise<{
        check: string;
        status: "pass" | "fail" | "unavailable" | "skipped";
        exitCode: number | null;
        tail: string;
        duration_ms?: number;
        kind?: "browser";
    }[]>;
    protected evaluate(issue: Issue, doneWhen: DoneWhenList, path: string, base: string, head: string, patchHash: string, checks: {
        check: string;
        status: string;
    }[], repro: {
        path: string;
    } | null, tampered: string[], files: ChangeFile[], opts?: {
        extra?: string[];
        schema?: object;
    }): Promise<{
        unread: string[];
        bothSidesKept: boolean | null;
        unverified_claims?: string[];
        patch_correct: boolean;
        test_correct: boolean;
        confidence: "high" | "medium" | "low";
        advice: string;
    }>;
    /**
     * The latest worker's claims that no record backs: not the coordinator's passing checks, nor a command the
     * worker's last run recorded as succeeding.
     */
    private unverifiedClaims;
    /**
     * Whether a PR the policy would merge can merge as is: yes when the combined-state check is off, the default
     * branch hasn't moved since the PR branched, or its new commits touch nothing the PR touches or imports.
     * Otherwise the result of the check on that exact head and branch tip (started in the background if there is
     * none yet: 'pending'). The PR is never changed: a pass merges the unchanged head that already passed CI.
     */
    protected combinedGate(w: EventPayload<'pr.opened'>, pr: PullRequest): Promise<'merge' | 'pending' | 'conflict' | {
        hold: string;
    }>;
}
