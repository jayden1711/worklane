import type { AutomationsPolicy } from '../automations/schema.js';
import type { Get } from '../automations/github.js';
import type { IncidentSink } from '../usage-limit.js';
import type { Config, ConfigError } from '../config/load.js';
import { type Backlog, type Issue } from '../backlog/types.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import type { SuiteOptions } from '../harness-evals/replay.js';
import { type AgentRunner, type CommitIdentity, type RunAs, type RunControl } from '../runner.js';
import { type PendingMessage } from '../console.js';
import type { InstanceSettings } from '../instance.js';
import { type IntakeConfig, type IntakeSource } from '../intake/report.js';
import type { PrTestRuns } from './test-runs.js';
import type { TestRuns } from './pr-batch.js';
import type { RoleOf } from '../dashboard-auth.js';
import type { MainWatchApi } from '../main-watch.js';
import type { MergePostsApi } from '../merge-posts.js';
import type { CiMetricsApi } from '../ci-metrics.js';
import type { DeployGate } from '../deploy-gate/gate.js';
import type { JournalRead } from '../superfan/digest.js';
import type { Previews } from '../preview/previews.js';
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
    /**
     * Where task files go when agents run as their own user: a directory the agent user can read but not
     * write (group `gid`, 2750; files 0640), outside the worktree. Without it, task files stay in stateDir.
     */
    agentTasks?: {
        dir: string;
        gid: number;
    };
    /**
     * The instance's root (beside its checkout), where its dependency cache lives, and the agents' group: set only
     * when agents run as their own user. Without it there is no shared cache.
     */
    depCacheRoot?: {
        dir: string;
        gid: number;
    };
    /** The OS user project commands run as (checks, gates, setup, full runs): the agent user, never the coordinator's. */
    commandsAs?: RunAs;
    /** The instance's GitHub token expiry, from the start-up scope check (null: never expires). */
    tokenExpiresAt?: string | null;
    /** The identity on every commit; agents' commits with any other are rejected. */
    commitIdentity?: CommitIdentity;
    /** The instance's GitHub App key, whose age the reports watch. */
    appKeyPath?: string;
    maxAttempts?: number;
    leaseMs?: number;
    /** WHY: tests shorten it; a task waiting on another's files re-checks this often (ms; default 15 s). */
    ownershipPollMs?: number;
    /** How often each open PR is polled for its checks (ms; default 60 s). */
    prPollMs?: number;
    /** How often the harness's open PRs are read for new reviews that start a fix run (ms; default REVIEW_FIX_POLL_MS, 5 min). */
    reviewPollMs?: number;
    /** The instance policy's auto-merge kill switch, read on every decision (absent or throwing: off). */
    autoMerge?: () => boolean;
    /** The instance's settings (policy.yaml), read every tick; absent: the repo's config as is. */
    settings?: () => {
        settings: InstanceSettings;
        error: string | null;
    };
    /**
     * The watchdog's incident model (one alert per incident, one when resolved), when the instance has one: the
     * usage-limit pause raises and resolves its incident there. Absent: the pause reports only through its events.
     */
    incidents?: IncidentSink;
    /**
     * The superfan's view of this instance (src/coordinator/superfan.ts): its name (the incidents' `instance`) and its
     * own service log, read as the coordinator's user (never sudo). Absent (a checkout's coordinator): no superfan.
     */
    superfan?: {
        name: string;
        journal?: () => Promise<JournalRead | null>;
    };
    /**
     * Experiment studies (src/coordinator/experiments.ts), server mode only: the instance's name (the root helper's
     * first argument) and its pins file. `helper` and `root` replace the real sudo helper and root's file (tests).
     */
    experiments?: {
        instance: string;
        pinsFile: string;
        helper?: import('./experiments.js').ExperimentHost['helper'];
        root?: () => import('../experiments/root-file.js').RootState;
        logTail?: (job: string, step: string) => string;
    };
    /**
     * The config follows the default branch (src/config/live.ts): `tree`, the config tree `cfg` was loaded from
     * (absent: the checkout's HEAD); `check`, checks beyond the schema a new config must pass (an instance's policy).
     */
    liveConfig?: {
        tree?: string | null;
        check?: (cfg: Config) => ConfigError[];
    };
    /**
     * When the last Claude account switch put this instance on a new login and resumed it (src/claude-account.ts,
     * switchedOnto): that time, else null. A usage-limit pause from before it ends then. Absent: only the reset ends it.
     */
    accountSwitched?: () => string | null;
    /** Open-model providers' key files, by credential name (credentials.yaml provider_keys): paths only, never keys. */
    providerKeys?: Record<string, string>;
    /** The clock (tests). */
    now?: () => Date;
    /** Nightly queuing (tests inject this). */
    nightly?: (root: string, cfg: Config, eventsDb: string, actor: string, runAs?: RunAs) => {
        id: string;
    }[];
    /** Machine readings (tests inject these). */
    machine?: {
        load(): number | null;
        disk(path: string): {
            freePct: number;
            totalGb: number;
            freeGb?: number;
        };
    };
    /**
     * The harness eval suite (src/harness-evals/; tests inject these): the suite run itself, the engine commit running
     * here, and whether src/ changed between two engine commits. Absent: the real ones.
     */
    harnessEvals?: {
        /** This coordinator is itself a replay's scratch instance: it never runs harness evals (no recursion), whatever its config says. */
        replay?: true;
        suite?: (o: SuiteOptions) => Promise<EventPayload<'harness_eval.run'>>;
        engine?: () => string | null;
        changed?: (from: string, to: string) => boolean | null;
    };
    /** How the machine helper is run for the dashboard's machine requests (sudo -n; tests inject it). */
    machineExec?: (file: string, args: string[]) => string;
    /**
     * Work intake (docs/intake.md): the instance's intake config, read on every pass (null: intake is off), and its
     * sources. `pullMs`: how often the sources are pulled (default 30 s). `roleOf`: a person's role on the instance's
     * repo, read as the dashboard reads it (dashboard-auth.ts), for what a mapped chat sender may do (absent: nothing).
     * `typingMs`: how often the typing indicator is sent again while a reply is on its way (default 8 s; tests).
     * `name`: the instance's name, as the dashboard hub knows it (a setup step's one-time link names it).
     */
    intake?: {
        config: () => IntakeConfig | null;
        sources: IntakeSource[];
        pullMs?: number;
        roleOf?: RoleOf;
        typingMs?: number;
        name?: string;
    };
    /**
     * The fast test runs on every open PR (src/coordinator/test-runs.ts); absent: tests.yaml has no test_run. While the
     * sandbox's check is failing it refuses every run, and `testRuns` and `deployGate` below count as absent.
     */
    prTestRuns?: PrTestRuns;
    /**
     * The disk guard (src/disk-guard.ts): why no new work may start (the disk is full, or below its floor), or null.
     * Absent: never held.
     */
    disk?: {
        held(): string | null;
    };
    /**
     * The test-run service (src/testrun/: startTestRun, postChecks) for PR-mode batching (tests.yaml land.pr_batch).
     * Absent with batching on: queued PRs wait, and nothing merges untested.
     */
    testRuns?: TestRuns;
    /**
     * The main watch (src/main-watch.ts): its GitHub calls, and the instance policy's main_watch (auto: on when GitHub
     * doesn't protect the default branch; off). Absent: no watch (no GitHub, e.g. a file backlog).
     */
    mainWatch?: {
        api: MainWatchApi;
        setting?: () => 'auto' | 'off';
        now?: () => number;
    };
    /**
     * Merge posts (src/merge-posts.ts): every merge to the default branch posted in intake.yaml's discord.ops_channel
     * (discord.post_merges). Its GitHub calls. Absent: none (no GitHub, e.g. a file backlog).
     */
    mergePosts?: {
        api: MergePostsApi;
        now?: () => number;
    };
    /**
     * CI timings for the metrics (src/ci-metrics.ts): merged PRs' CI wall-clock and the default branch's CI jobs' slow
     * tests, read from GitHub. Its GitHub calls. Absent: not measured (no GitHub, e.g. a file backlog).
     */
    ciMetrics?: {
        api: CiMetricsApi;
        now?: () => number;
    };
    /**
     * The default branch's protection, as the main watch asks it (src/direct-land.ts): land_mode direct pushes nothing
     * unless GitHub enforces it, asked again before every direct land. Absent: only a remote that is a local path lands.
     */
    protection?: Pick<MainWatchApi, 'protection'>;
    /** A person's role on the repo, from their permission (dashboard-auth.ts): whose PRs get the full run. Absent: nobody's. */
    roleOf?: RoleOf;
    /** The pre-deploy gate (src/deploy-gate/, tests.yaml deploy_gate); absent: off. */
    deployGate?: DeployGate;
    /** docs/previews.md: PR previews; absent, off. */
    previews?: Previews;
    /**
     * Automations (src/coordinator/automations.ts): the instance's automations.yaml, its policy's automations part (read
     * every pass), and a GET for GitHub's listings (absent: no GitHub triggers). Absent: no automations (a checkout).
     */
    automations?: {
        file: string;
        policy: () => AutomationsPolicy;
        github?: Get;
    };
}
/** The default for tests.yaml command_timeout_s (2 hours), for a command run without the config. */
export declare const COMMAND_TIMEOUT_MS: number;
/** How often the worktree pool is checked against main's tip. */
export declare const POOL_CHECK_MS: number;
/** When GitHub is still computing whether a PR can merge, look again this soon. */
export declare const MERGEABLE_RECHECK_MS = 10000;
/** How often the default branch's tip is checked for a merge (which can make open PRs conflict). */
export declare const TIP_CHECK_MS = 15000;
/** A wait on the Claude login shorter than this isn't worth an event. */
export declare const LOCK_WAIT_RECORDED_MS = 1000;
/** How many times an issue blocked on a rate limit or budget is requeued on its own before it waits for a person. */
export declare const RETRY_CAP = 3;
/** When a rate-limit or budget block may retry: a rate limit after its window (5 h), a budget at the next UTC midnight. */
export declare function retryAfter(kind: 'rate_limit' | 'budget', now?: number): {
    kind: 'rate_limit' | 'budget';
    after: Date;
};
/** How long a fix run waits on an issue claim held elsewhere (from the first time it found it so) before giving up. */
export declare const CLAIM_HELD_GIVE_UP_MS = 3600000;
/**
 * Run a project command without blocking the event loop: with several agents
 * in flight, a blocking test run would starve their output streams and trip
 * their stall timers. Output is capped; the tail is kept for reports.
 */
export declare function sh(command: string, cwd: string, timeoutMs?: number, runAs?: RunAs, projectEnv?: Record<string, string>, signal?: AbortSignal): Promise<{
    code: number | null;
    tail: string;
    out: string;
}>;
/** An issue's lane: its lane:<name> label, if any (otherwise the runner's default lane). */
export declare const laneOf: (issue: Issue) => {
    lane?: string;
};
/** An emergency stop interrupted this task. */
/** The owner stopped this run from the console. */
export declare class StoppedByOwner extends Error {
    readonly by: string;
    constructor(by: string);
}
/** A live run, as the console holds it. */
export interface LiveEntry {
    key: string;
    /** The run's id (its record and feed), once the session is up. */
    run: string | null;
    control: RunControl | null;
    issue: number | null;
    role: string;
    model: string;
    startedAt: string;
    pending: PendingMessage[];
    stoppedBy: string | null;
}
export declare class Halted extends Error {
    constructor(message?: string);
}
/**
 * The coordinator is shutting down (SIGTERM or SIGINT: a restart, an update, a stop): its runs are aborted and their
 * tasks requeued to start again after the restart. A kind of halt, so every caller that requeues on a halt does here too.
 */
export declare class ShuttingDown extends Halted {
    constructor();
}
/**
 * The instance is paused on the Claude usage limit (src/usage-limit.ts): a run that hit it, or one asked for while
 * the pause holds, which never starts. A kind of halt, so every caller that requeues on a halt requeues on this too.
 */
export declare class UsagePaused extends Halted {
    readonly resetAt: string;
    constructor(resetAt: string);
}
/**
 * The run's Claude login is held (src/claude-auth-failure.ts): the API refused it, on this run or an earlier one, and
 * no call on it has succeeded since. A run asked for while it holds never starts. A kind of halt, so every caller that
 * requeues on a halt requeues on this too; it never counts as an attempt.
 */
export declare class AuthPaused extends Halted {
    readonly login: string;
    readonly detail: string;
    constructor(login: string, detail: string);
}
export declare const DEFAULT_REVIEW: {
    version: 1;
    categories: {};
    levels: {
        L0_auto: {
            when: string[];
            max_lines: number;
        };
        L1_evaluator: {
            when: string[];
            max_lines: number;
            max_files: number;
        };
        L2_notify: {
            when: string[];
        };
        L3_human: {
            when: string[];
            over_lines: number;
        };
    };
    merge: {
        auto: boolean;
        max_lines: number;
        max_files: number;
        wait_categories: string[];
        loosened: string[];
    };
    max_pr_lines: number;
    generated: string[];
    docs_only_checks: string[];
    delegation: {
        enabled: boolean;
        min_clean: number;
    };
};
/** The PR body's lines for instruction evals: base and head scores, the cost, and every case that changed. */
export declare function evalLines(results: EventPayload<'instructions.eval'>[]): string[];
/** The end of a CI job log, for a fix run's brief: the last lines, without the runner's per-line timestamps. */
export declare function logTail(text: string, lines?: number, chars?: number): string;
/** The blocked comment for a refused push: every reason, one per line. */
export declare function pushRefusal(reasons: string[]): string;
