import type { EventLog } from '../events/log.js';
import type { IncidentSink } from '../usage-limit.js';
import type { TestRunRequest, TestRunResult } from '../testrun/index.js';
import { type DeployGateConfig } from './config.js';
import type { PostDeploy } from './post-deploy.js';
/** What the gate reads with git, in the coordinator's clone. */
export interface GateGit {
    /** Fetch the default branch and the deploy branch; their tips (deploy null when the branch doesn't exist). */
    fetch(): {
        main: string;
        deploy: string | null;
    };
    /** Whether `a` is `b` or an ancestor of it. */
    isAncestor(a: string, b: string): boolean;
    /** Whether `sha` is on `tip`'s first-parent line (`tip` itself included). */
    onFirstParent(sha: string, tip: string): boolean;
    /** The full sha of a commit in the clone, or null. */
    resolve(ref: string): string | null;
    /** The files `to` changes since `from` (from null: since its first parent). */
    changed(from: string | null, to: string): string[];
}
export type RefResult = {
    ok: true;
} | {
    ok: false;
    status: number;
    message: string;
};
/**
 * The deploy branch's one write: a fast-forward to `sha` (PATCH git/refs, force false), or the branch's creation
 * when it doesn't exist yet. There is no way to force it: refUpdateBody is the only body either sends.
 */
export interface DeployRefs {
    fastForward(sha: string): Promise<RefResult>;
    create(sha: string): Promise<RefResult>;
}
/** The body of the ref update: never a force. */
export declare function refUpdateBody(sha: string): {
    sha: string;
    force: false;
};
export interface GateDeps {
    config: DeployGateConfig;
    /** The default branch (the gate refuses to be configured on it). */
    defaultBranch: string;
    git: GateGit;
    refs: DeployRefs;
    log: EventLog;
    actor: string;
    stateDir: string;
    /** A run of the gate's tiers on a commit (startTestRun with `tiers`). */
    start: (req: TestRunRequest, o: {
        signal: AbortSignal;
    }) => Promise<TestRunResult>;
    /** Post the run's checks on the commit: its tiers' own and the `deploy-gate` one. */
    post: (sha: string, result: TestRunResult) => Promise<void>;
    /** The coordinator's clone (the run's repo). */
    repo: string;
    incidents?: IncidentSink;
    /** How often the branches are fetched (default 90 s). */
    pollMs?: number;
    now?: () => number;
    /** The post-deploy check (deploy_gate.post_deploy): started after every move. Absent: off. */
    postDeploy?: PostDeploy;
}
/** The gate's state for one commit, as an override records it. */
export type GateState = 'green' | 'red' | 'running' | 'unchecked';
export declare class DeployGate {
    private d;
    private lastPoll;
    private running;
    private readonly stopped;
    constructor(d: GateDeps);
    private get file();
    private read;
    private write;
    private emit;
    get branch(): string;
    /** A commit that failed the post-deploy check in production: the branch is never moved to it again. */
    markFailed(sha: string, reason: string): void;
    /** Whether `sha` failed the post-deploy check. */
    failedPostDeploy(sha: string): boolean;
    /** The gate's state for `sha`: its verdict, running now, or none. */
    stateOf(sha: string): GateState;
    /**
     * One pass, at most every pollMs: fetch both branches, check the deploy branch is where the gate left it, and start
     * a run on the default branch's tip when it is new and no run is going. The run is not waited for.
     */
    step(): Promise<void>;
    /**
     * The deploy branch moved outside the gate: an incident (once per position), and a refusal record when it is off
     * the default branch's line. Back where the gate put it (or the gate moves it on): resolved.
     */
    private watchDeploy;
    private raise;
    private runOn;
    private verdict;
    /**
     * Fast-forward the deploy branch to `target`: only when `target` is on the default branch's line and descends from
     * where the branch is now, and the branch is where the gate left it or on the default branch's line. Never forced.
     */
    advance(target: string, meta: {
        by: string;
        override: boolean;
        gate: string;
    }): Promise<{
        ok: true;
        from: string | null;
    } | {
        ok: false;
        reason: string;
    }>;
    /**
     * Whether an owner may deploy `ref` now: a commit on the default branch's first-parent line. Its full sha and the
     * gate's state for it, or why not. Moves nothing.
     */
    checkOverride(ref: string): {
        ok: true;
        sha: string;
        gate: GateState;
    } | {
        ok: false;
        reason: string;
    };
    /** An owner's confirmed override: checked again, then the same fast-forward-only move. */
    override(ref: string, by: string): Promise<{
        ok: true;
        sha: string;
        gate: GateState;
        from: string | null;
    } | {
        ok: false;
        reason: string;
        gate: GateState | null;
    }>;
    /** Wait for the run in flight (tests and shutdown). */
    idle(): Promise<void>;
    stop(): void;
}
/** The gate for the dashboard: where the branch is, the last held commit and why, and a refusal in force. */
export declare function deployGateView(stateDir: string, events: readonly {
    type: string;
    ts: string;
    payload: unknown;
}[], repo: string, branch: string): {
    branch: string;
    deployed: {
        sha: string;
        url: string;
        at: string | null;
        by: string | null;
        override: boolean;
    } | null;
    held: {
        sha: string;
        url: string;
        at: string;
        reason: string;
    } | null;
    refused: {
        at: string;
        reason: string;
    } | null;
};
