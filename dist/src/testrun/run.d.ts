import type { EventLog } from '../events/log.js';
import { type HeldFlock } from '../os/index.js';
import type { TestRunConfig, TestRunTier } from './config.js';
import type { HelperState } from './helper.js';
import type { SandboxState } from './sandbox-watch.js';
import { type RunHost } from './host.js';
import { type Predates } from './predates.js';
import type { Plan } from './affected.js';
export interface TestRunRequest {
    repo: string;
    sha: string;
    kind: 'fast' | 'full';
    prs: number[];
    changedFiles?: string[];
    /** This shard of a sharded full run: `index` is 1-based (1..total). */
    shard?: {
        index: number;
        total: number;
    };
    /** Only these tiers, of either kind, unsharded (the deploy gate's post-merge run); absent: the kind's tiers. */
    tiers?: string[];
}
export interface TierResult {
    tier: string;
    ok: boolean;
    durationMs: number;
    /** What the check shows of it: its last output lines (redacted), or why it didn't run. */
    summary: string;
    logRef: string;
    /** The PR's head is older than the test-run config and can't run this tier as configured (./predates.ts). */
    predates?: Predates;
}
export interface TestRunResult {
    id: string;
    sha: string;
    kind: 'fast' | 'full';
    ok: boolean;
    tiers: TierResult[];
    /**
     * How the run ended, as testrun.finished records it: `done` is a verdict on the code (ok says which); `cancelled`
     * (superseded, dropped, the coordinator stopping) and `error` (the run couldn't go ahead) are none. A cancel during
     * a tier and that tier timing out both fail it, so only this tells them apart.
     */
    outcome: 'done' | 'cancelled' | 'error';
    /**
     * The setup step that failed, when one did (the helper's version, the workspace, a cache, the database, a setup
     * command): what the posted check says, with the end of that step's stderr, redacted. Never its stdout.
     */
    setup?: SetupFailure;
    /** A line the posted check adds under the result (the coordinator's: its disk is full and the run's events wait). */
    note?: string;
}
export interface SetupFailure {
    /** helper, sandbox, create, changed-files, caches, shared, db-start, or "setup step <n> (<command>)". */
    step: string;
    detail: string;
    /** The last lines of its stderr, redacted; '' when it said nothing there. */
    stderr: string;
}
/** The setup step of a run refused because the sandbox's check is failing (./sandbox-watch.ts), and what its check says. */
export declare const SANDBOX_STEP = "sandbox";
export declare const SANDBOX_OFF = "test runs are off on this instance: the test sandbox failed its own check, so no test run starts. The coordinator checks it again by itself (every 5 minutes at most) and runs this commit's tests once it passes: nothing to restart, and this check is replaced then. An admin can see every line with `sudo bash scripts/setup/test-user.sh check <name>`";
/** The machine-wide full-run lock: test runs take it shared, agents' and other full runs exclusive. */
export declare const FULL_RUN_LOCK: string;
export interface TestRunDeps {
    config: TestRunConfig;
    host: RunHost;
    /** The coordinator's clone, where `sha` is (fetched already). */
    repo: string;
    /** Only append is used: a measure (./measure.ts) passes a sink that keeps its runs' events out of the instance's log. */
    log: Pick<EventLog, 'append'>;
    actor: string;
    /** Where each tier's full log goes: the instance's private state. */
    logDir: string;
    lockPath?: string;
    slotsDir?: string;
    slotPollMs?: number;
    /** Taking the lock (tests inject one). */
    lock?: (path: string, signal?: AbortSignal) => Promise<HeldFlock>;
    now?: () => number;
    /** The helper's protocol, asked once at coordinator start (./helper.ts): when not ok, no run starts. */
    helper?: HelperState;
    /** INVARIANT: read before every run (./sandbox-watch.ts): while the sandbox's check is failing, no run starts. */
    sandbox?: SandboxState;
    /** test_run.select: imports's plan for a change (tests inject one); default ./select.ts importsPlan. */
    plan?: (repo: string, sha: string, changed: readonly string[]) => Plan;
    /** Directories left out of the workspace (tests.yaml checkout.sparse_exclude), unless a tier of the run sets full_checkout. */
    sparseExclude?: readonly string[];
}
/** What a run's workspace leaves out: the project's sparse_exclude, or nothing when one of its tiers needs a full checkout. */
export declare function workspaceExclude(tiers: readonly TestRunTier[], sparseExclude?: readonly string[]): readonly string[];
/**
 * What a run hands {tests} (test_run.select: imports): the test files a PR's fast run can affect, or null for the
 * whole suite (a full run, a run given no changed files, a plan that can't tell or fails), with the line its checks
 * show. Never fails the run: the whole suite is always a safe answer.
 */
export declare function selectionFor(d: Pick<TestRunDeps, 'config' | 'repo' | 'plan'>, req: Pick<TestRunRequest, 'kind' | 'sha' | 'changedFiles' | 'tiers'>): {
    tests: string[] | null;
    line: string;
};
/** The tiers a request runs: its kind's, and of a sharded run's later shards only the shardable ones. */
export declare function tiersFor(c: TestRunConfig, req: Pick<TestRunRequest, 'kind' | 'shard' | 'tiers'>): TestRunTier[];
/**
 * A tier's command with its placeholders filled; null when it needs the change's files and has none. `tests` fills
 * {tests}: the selected test files, or null (nothing) for the whole suite.
 */
export declare function tierCommand(t: TestRunTier, shard: {
    index: number;
    total: number;
}, changedFilesPath: string | null, tests?: readonly string[] | null): string | null;
/**
 * A tier's last lines, as its check shows them. The whole output is redacted first, so a secret that spans lines (a
 * private key) is masked even when only its end is in the last lines.
 */
export declare const TIER_LINES = 30;
export declare const lastLines: (out: string, lines?: number) => string;
export declare function validateRequest(req: TestRunRequest): void;
/**
 * The longest a run can take once it holds its slot: each setup step's cap, the database's start, and each tier's own
 * timeout_s. Recorded in the slot, so the engine updater's drain can say when the machine will be quiet.
 */
export declare function runLimitMs(config: TestRunConfig, tiers: TestRunTier[]): number;
/**
 * Run one test run. Waits for a slot and then the lock as long as either takes (until `signal` aborts: a
 * superseded run), wipes the run whatever happens, and records every step. Never throws for a test failure, a
 * setup failure or a cancellation: those are the result (ok false). Throws for a bad request, and TestRunHeld while
 * the start gate (./gate.ts: the disk full or below its floor) refuses: nothing is queued, recorded or started then.
 */
export declare function runTestRun(d: TestRunDeps, req: TestRunRequest, o?: {
    signal?: AbortSignal;
    id?: string;
}): Promise<TestRunResult>;
/** A sharded full run's shards as one result: each tier passes only if it passed in every shard that ran it. */
export declare function mergeShards(results: readonly TestRunResult[]): TestRunResult;
