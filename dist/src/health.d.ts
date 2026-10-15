import type { StoredEvent } from './events/types.js';
import type { MachineStats } from './os/stats.js';
import { type OffsiteStatus } from './offsite-backup.js';
import { type MergeMetrics } from './merge-metrics.js';
import { type HeldUpdate, type UpdateEntry } from './updates.js';
import { type TestRunStatus } from './testrun/status.js';
import { type NetworkHealth } from './network.js';
export type { MachineStats } from './os/stats.js';
/** When a check counts as having got slower: the median of its last `recent` runs against the median of up to `prior` runs before them. */
export declare const REGRESSION: {
    readonly recent: 5;
    readonly prior: 20;
    readonly minPrior: 5;
    readonly slowerBy: 0.25;
    readonly minDeltaMs: 2000;
};
export interface CheckTiming {
    check: string;
    runs: number;
    /** Oldest first: when it ran, how long it took, how it ended. */
    series: {
        at: string;
        ms: number;
        status: string;
    }[];
    recentMedianMs: number;
    priorMedianMs: number | null;
    /** Got slower by REGRESSION's rule: (recent - prior) / prior. */
    regression: {
        slowerPct: number;
    } | null;
}
export interface UsageDay {
    day: string;
    runs: number;
    /** The agent CLI's own per-run cost estimates, summed: not money billed. */
    estimatedUsd: number;
    turns: number;
    /** Runs that ended on the usage limit. */
    rateLimited: number;
    /** Login trouble: a run stopped on a login mismatch, or a retry to refresh the login's token. */
    authProblems: number;
    /** Retries after a transient error, by cause (token_refresh, rate_limit, overloaded, server_error, network, other). */
    retries: Record<string, number>;
    retryWaitMs: number;
    /** Waits of a second or more for a login another run was using. */
    lockWaits: number;
    lockWaitMs: number;
}
export interface HealthView {
    instance: string | null;
    /** The OS adapter's snapshot, as read; null if it couldn't be taken. */
    machine: MachineStats | null;
    cores: number | null;
    checks: {
        timings: CheckTiming[];
        slowest: string[];
        regressions: string[];
        rule: string;
    };
    usage: {
        days: UsageDay[];
        quotaNote: string;
    };
    /** The last off-machine backup verified by reading the remote copy back; null when off-machine backups aren't set up. */
    offsiteBackup: OffsiteStatus | null;
    /** What conflict fixes, light checks and hotspot holds cost per merged PR, over the last MERGE_DAYS days. */
    merge: MergeMetrics;
    /** An engine update this machine rolled back and holds (the machine's update log); null when none. */
    updateHold: HeldUpdate | null;
    /** The coordinator's test runs (src/testrun/): queue, runs, per-tier figures, and what keeps them from working. */
    testRuns: TestRunStatus;
    /** The machine's outbound proxy from root's network.json (src/network.ts), or why that file was refused; null when none is set. Read-only. */
    network: NetworkHealth | null;
    suggestions: string[];
}
/** The window the merge-flow figures cover. */
export declare const MERGE_DAYS = 7;
/** A merge-metrics flag ("X adds N min per merged PR: consider Y") as a suggestion: "Consider Y (X adds N min per merged PR)." */
export declare function mergeFlagSuggestion(flag: string): string;
export declare const QUOTA_NOTE = "How much of the Claude subscription's usage limit is left isn't visible to this harness: it counts only its own runs, their estimated cost, and the rate-limit replies they got.";
/** Each check's run times (verify-stage check.result duration_ms, recorded when it ran), oldest first, with the slowest and the ones that got slower. */
export declare function checkTimings(events: StoredEvent[], keep?: number): HealthView['checks'];
/** What the agent runs used, per day (UTC), newest first. */
export declare function usageByDay(events: StoredEvent[], days?: number): UsageDay[];
/** Conservative thresholds: below them, nothing is suggested. */
export declare const THRESHOLDS: {
    readonly memoryAvailablePct: 10;
    readonly swapUsedPct: 25;
    readonly unitMemoryPct: 90;
    readonly diskFreePct: 10;
    readonly diskFreeGb: 10;
    readonly rateLimitsPerDay: 3;
    readonly lockWaitMinPerDay: 30;
    readonly loadPerCore: 1.5;
};
/** Suggestions only, each a "consider", never a change made; one line saying so when there's nothing to suggest. */
export declare function suggestions(v: Omit<HealthView, 'suggestions' | 'offsiteBackup' | 'updateHold' | 'testRuns' | 'network'> & {
    offsiteBackup?: OffsiteStatus | null;
}, o?: {
    today?: string;
    diskLabels?: Record<string, string>;
}): string[];
/** The whole health view. */
export declare function healthView(events: StoredEvent[], machine: MachineStats | null, o?: {
    cores?: number | null;
    today?: string;
    diskLabels?: Record<string, string>;
    now?: Date; /** The machine's update log; read from its file when not given. */
    updates?: UpdateEntry[]; /** The network line; read from root's network.json when not given. */
    network?: HealthView['network'];
}): HealthView;
