import type { Coordinator } from '../coordinator.js';
import type { Config } from '../config/load.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { type ChangeFile } from '../review.js';
import type { DecisionContext } from '../decision-context.js';
import { type CommitIdentity, type RunRequest, type RunResult } from '../runner.js';
import { type FileIndex } from '../hotspots.js';
import { type Hold } from '../governor-holds.js';
import type { PushGuard } from '../push-guard.js';
import type { DeployGate } from '../deploy-gate/gate.js';
import type { TestRuns } from './pr-batch.js';
import { type WorktreeOptions } from '../worktrees.js';
import { type CoordinatorDeps, type LiveEntry, Halted } from './shared.js';
import { type AuthHold } from '../claude-auth-failure.js';
import { type UsagePause } from '../usage-limit.js';
export declare abstract class CoordinatorBase {
    protected d: CoordinatorDeps;
    /** Defined in a later part (or in Coordinator); declared here for the calls in this one. */
    protected abstract noteRefusedHosts(...args: Parameters<Coordinator['noteRefusedHosts']>): ReturnType<Coordinator['noteRefusedHosts']>;
    protected readonly remote: string;
    /** Where task worktrees go and how they're set up; the project's env is filled in when each one is made. */
    private readonly wtBase;
    protected get wt(): WorktreeOptions;
    protected active: Map<number, Promise<void>>;
    protected fileIx: {
        key: string;
        ix: FileIndex;
    } | null;
    /** The default branch's tip as last seen, and when it was last checked. */
    protected defaultTip: string;
    protected tipCheckedAt: number;
    /** PRs whose combined-state check is running. */
    protected lightRunning: Set<number>;
    /** When each watched PR was last polled (ms). */
    protected prPolled: Map<number, number>;
    /** Live runs, for the console. */
    protected live: Map<string, LiveEntry>;
    /** Chat turns, one at a time. */
    protected chatQueue: Promise<void>;
    /** Intake passes, one at a time. */
    protected intakeQueue: Promise<void>;
    protected intakeRunning: boolean;
    protected intakePulledAt: number;
    /** The repo's own config, as the default branch has it (src/config/live.ts): the defaults the instance's settings apply over. */
    protected repoCfg: Config;
    protected settingsKey: string;
    /** When each auto-merge's commit on the default branch was last polled (ms). */
    protected mainPolled: Map<string, number>;
    protected landing: boolean;
    protected stopped: boolean;
    /** Aborted by an emergency stop, and by a shutdown: every agent run gets this signal. */
    protected halt: AbortController;
    /** Aborted once, by a shutdown (stop()): project commands get this signal, and the emergency check never lifts it. */
    protected shutdown: AbortController;
    /** The tick step running now (stop() names it when the shutdown runs out of time). */
    protected inStep: string | null;
    /** Why a run stops now: the shutdown, or an emergency stop. */
    protected haltError(): Halted;
    /**
     * INVARIANT: while the test sandbox's check is failing (PrTestRuns.ready, src/testrun/sandbox-watch.ts), the test-run
     * service and the deploy gate are as absent as they were when a failed check meant none was set up: batches wait, a
     * red main is not re-run through it, the deploy branch doesn't move. Only the PRs' own runs go to the service then,
     * to be refused with a check that says test runs are off. Read at each use: they go on when the check passes.
     */
    protected get liveTestRuns(): TestRuns | null;
    protected get liveDeployGate(): DeployGate | undefined;
    /** Open-model providers that hit their usage or rate limit, by label: skipped (their runs fall back) until then (ms). */
    protected providerLimited: Map<string, number>;
    /** The runner under the wrapper below: only the held-login check calls it directly (it must run while the login is held). */
    private claudeRunner;
    constructor(d: CoordinatorDeps);
    /** This task's share of the machine's cores right now: the cores over the agents running (cores.ts). */
    private coreShare;
    /** The project's env (tests.yaml env) as a command or session starting now gets it: `{cores}` filled in. */
    protected projectEnv(): Record<string, string>;
    /** A project command (check, gate, pre-land step): it runs agent-written code, so it runs as the agent user. */
    protected project(command: string, cwd: string): Promise<{
        code: number | null;
        tail: string;
        out: string;
    }>;
    /** How long a project command or an agent run may take (tests.yaml command_timeout_s). */
    protected get commandTimeoutMs(): number;
    protected get branch(): string;
    /** What every push checks: the default branch is never pushed (only the direct land passes `directLand`); a refusal is recorded. */
    protected pushGuard(directLand?: boolean): PushGuard;
    protected git(cwd: string, ...args: string[]): string;
    protected emit<T extends Parameters<EventLog['append']>[0]>(type: T, payload: EventPayload<T>): StoredEvent<T>;
    protected events(issue?: number): StoredEvent[];
    protected lastSeen(issue: number): unknown;
    /** USD spent today (this machine's local day, as the dashboard shows it: src/local-day.ts) by all runs, from the log. */
    spentToday(): number;
    /** An emergency stop is in force (read now, not only at the last check): nothing lands and nothing merges. */
    protected emergencyInForce(): boolean;
    private lastHold;
    /** Why no new agent may start right now, or null. Load and disk are machine-wide. Each hold carries its numbers (src/governor-holds.ts). */
    governorHold(): Hold | null;
    /** The hold when no agent slot is free: the updater's drain, or the machine-wide cap with its numbers. */
    protected slotHold(): Hold;
    /** The coordinator's clock, in ms (tests set `now`). */
    protected nowMs(): number;
    /**
     * Why no new work may start now: the disk is full (the event log's writes wait in memory) or below its floor
     * (src/disk-guard.ts). Every place that holds on the usage pause holds on this too; runs in flight go on.
     */
    protected diskHeld(): string | null;
    /** The usage-limit pause in force (src/usage-limit.ts), from the log, or null. */
    protected usagePause(): UsagePause | null;
    /** The Claude login a run would use: the runner's own answer (its config dir), else the one login there is. */
    protected loginKeyOf(req: Pick<RunRequest, 'lane' | 'provider'>): string;
    /** Every Claude login held now (src/claude-auth-failure.ts), from the log. */
    protected authHolds(): AuthHold[];
    protected authHold(key: string): AuthHold | null;
    /**
     * A held login, if any: nothing new is dispatched while one is (a task's runs span the instance's logins, its
     * worker's and its evaluator's), and nothing that runs on its own (research, fix runs, evals) starts.
     */
    protected authHeld(): AuthHold | null;
    /** A run's login was refused: it is held (once; a second refusal while held keeps the hold), and the red incident raised. */
    private holdLogin;
    /** A call on a held login succeeded (a run that started after the hold began, or the check): the hold ends. */
    private loginWorks;
    /** When the owner's last re-check was taken (ms): one a minute at most. */
    private ownerRecheckAt;
    /**
     * The way out of a held login (no run may start on it, so no run can succeed to end the hold): one tiny real call
     * on it, as its own user, at most every AUTH_RECHECK_MS; at once after an account switch, and on the owner's
     * re-check from the dashboard (one a minute at most). A refused call costs nothing; one that is answered ends the hold.
     */
    protected checkHeldLogins(): Promise<number>;
    private checkLogin;
    /** Pause on a usage-limit hit: once (a hit while paused changes nothing), with the incident raised when there's a watchdog. */
    private pauseOnLimit;
    /**
     * The pause ends, and the next dispatch starts runs again: at its reset time, or once a Claude account switch put
     * this instance on a new login after it began (the old account's limit no longer applies).
     */
    protected resumeIfDue(): boolean;
    protected noteHold(h: Hold | null): void;
    /**
     * The instance's settings (policy.yaml), re-read every tick: when they change, the repo's config with
     * them applied becomes the config in effect, without a restart. Refused settings: the repo's values.
     */
    /** The live runs list the dashboard reads (only runs whose session is up: they have an id). */
    protected writeLive(): void;
    protected paths(issue: number): {
        name: string;
        branch: string;
        taskFile: string;
    };
    /** The pooled worktree this claim of the issue runs in, if it took one (recorded, so a restart still finds it). */
    private pooledName;
    /**
     * The instance's dependency cache (pip, uv, npm, pnpm, yarn) for worktree setup: only for an instance whose
     * agents run as their own user (the cache lives beside its checkout), and when the project keeps it on.
     * Not for agent sessions: their sandbox writes only inside the worktree, so a cache outside it fails there.
     */
    private depCacheEnv;
    private cacheEnv;
    protected get identity(): CommitIdentity;
    /** The latest eval of each instruction target for an issue. */
    protected instructionResults(n: number): EventPayload<'instructions.eval'>[];
    /** Each file the change base..head touches, with its line counts and added and removed lines (for content checks). */
    protected changeFiles(cwd: string, base: string, head: string): ChangeFile[];
    /**
     * The task file the agent's hook reads (its frozen paths): readable by the agent user, never writable by it,
     * so an agent can neither lose its guard nor rewrite it. The hook refuses every tool call if it can't read it.
     */
    protected writeTask(file: string, task: object): void;
    protected cost(issue: number | null, role: string, r: RunResult): void;
    /**
     * A run's usage for run.cost: its model, turns, tokens and seconds, and its estimated cost. On an open-model
     * provider that is the provider's price (src/providers.ts): local runs cost nothing, a hosted one without prices
     * configured counts as 0 and says which provider it was.
     */
    protected usage(r: RunResult): {
        model: string;
        usd: number;
        turns: number;
        provider?: string;
        tokens_in?: number;
        tokens_out?: number;
        secs?: number;
    };
    protected ownerOf(issue: number): string;
    protected ask(kind: 'land' | 'question' | 'domain' | 'plan' | 'intake' | 'delegation' | 'automation', issue: number | null, owner: string, question: string, options: string[], recommended: string, detail: string[], context?: DecisionContext): Promise<string>;
    /** `retry`: a rate-limit or budget block that retries on its own after `after` (up to RETRY_CAP times). */
    protected block(issue: number, owner: string, why: string, release_?: boolean, retry?: {
        kind: 'rate_limit' | 'budget';
        after: Date;
    }): Promise<void>;
    protected releaseClaim(issue: number, why: string): void;
}
