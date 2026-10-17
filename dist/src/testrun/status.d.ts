import type { StoredEvent } from '../events/types.js';
import { type GpuOptIn } from './gpu.js';
import { type NetworkPolicy } from './network.js';
/**
 * Whether this instance's test runs came up, as its coordinator last said at a start (./setup.ts): the newest of its
 * sandbox check's result and an outdated helper (which skips the check and refuses every run). null: it never said
 * (no test runs configured, or it hasn't started with them). The engine updater compares this across an update
 * (the `sandbox-status` command).
 */
export declare function sandboxVerdict(events: StoredEvent[]): {
    ok: boolean;
    detail: string;
    at: string;
} | null;
export interface TestRunRow {
    id: string;
    sha: string;
    kind: 'fast' | 'full';
    prs: number[];
    shard: {
        index: number;
        total: number;
    } | null;
    state: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    slot: string | null;
    lockWaitMs: number | null;
    /** Recorded as a GPU run when it started (a tier asked, root's file listed the instance). */
    gpu: 'planned' | null;
    /** Each tier's outcome so far (or at the end); `gpu` only for a tier that asked for the GPU. */
    tiers: {
        tier: string;
        ok: boolean;
        durationMs: number | null;
        summary?: string;
        logRef?: string;
        gpu?: {
            granted: boolean;
            devices: string[];
            detail: string;
        };
    }[];
}
export interface TierStats {
    tier: string;
    runs: number;
    medianMs: number;
    /** The largest peak memory and CPU time a run of it recorded (the sandbox reports them), null when none did. */
    peakMemMb: number | null;
    maxCpuS: number | null;
}
export interface TestRunStatus {
    sandbox: {
        ok: boolean;
        detail: string;
        at: string;
    } | null;
    checksPermission: {
        level: 'write' | 'read' | 'none' | 'unknown';
        detail: string;
        at: string;
    } | null;
    /** The last attempt to post checks failed for want of the permission, and none posted since. */
    checksBlocked: {
        detail: string;
        at: string;
    } | null;
    queue: TestRunRow[];
    running: TestRunRow[];
    recent: TestRunRow[];
    tierStats: TierStats[];
    wipeFailures: {
        id: string;
        left: string[];
        at: string;
    }[];
    /** Plain statements of what keeps test runs from working; empty when nothing does. */
    problems: string[];
}
export declare function testRunStatus(events: readonly StoredEvent[], recentN?: number): TestRunStatus;
/** What a viewer sees of the test runs: each run's commit, PRs, state and tiers' pass or fail. Never a log, summary or slot. */
export declare function viewerTestRuns(s: TestRunStatus): {
    queue: {
        id: string;
        sha: string;
        kind: "fast" | "full";
        prs: number[];
        state: "queued" | "failed" | "running" | "interrupted" | "cancelled" | "passed";
        tiers: {
            tier: string;
            ok: boolean;
        }[];
    }[];
    running: {
        id: string;
        sha: string;
        kind: "fast" | "full";
        prs: number[];
        state: "queued" | "failed" | "running" | "interrupted" | "cancelled" | "passed";
        tiers: {
            tier: string;
            ok: boolean;
        }[];
    }[];
    recent: {
        id: string;
        sha: string;
        kind: "fast" | "full";
        prs: number[];
        state: "queued" | "failed" | "running" | "interrupted" | "cancelled" | "passed";
        tiers: {
            tier: string;
            ok: boolean;
        }[];
    }[];
};
export interface TestRunsViewInput {
    events: readonly StoredEvent[];
    /** tests.yaml has a test_run section. */
    configured: boolean;
    /** Whether this person is an owner or writer (else a viewer). */
    writer: boolean;
    cap: number;
    slots: {
        slot: string;
        owner: string;
        acquiredAt: string;
    }[];
    lock: {
        path: string;
        holders: {
            pid: number;
            mode: 'shared' | 'exclusive';
        }[] | null;
    };
    /** Root's GPU opt-in for this instance (./gpu.ts gpuOptIn), read-only here; absent: not shown. */
    gpu?: GpuOptIn;
    /** Root's network grants for this instance (./network.ts networkPolicy), read-only here; absent: not shown. */
    network?: NetworkPolicy;
    /** The instance, for the root commands shown with the opt-in. */
    instance?: string;
}
/** Root's GPU opt-in as the Machine page shows it: read-only, with the root commands that change it. */
export declare function gpuView(o: GpuOptIn, instance: string): {
    state: "on";
    devices: number[];
    maxMinutes: number;
    change: string;
    status: string;
    why?: never;
} | {
    state: "off" | "unknown";
    why: string;
    change: string;
    status: string;
    devices?: never;
    maxMinutes?: never;
};
/** Root's network grants as the Machine page shows them: read-only, with the root commands that change them. */
export declare function networkView(p: NetworkPolicy, instance: string): {
    state: "on";
    tiers: string[];
    change: string;
    status: string;
    why?: never;
} | {
    state: "off" | "unknown";
    why: string;
    change: string;
    status: string;
    tiers?: never;
};
/**
 * The test runs as the dashboard shows them. Owners and writers: the queue, the running slots and their holders,
 * the full-run lock's holders, results with each tier's summary, per-tier figures, and the problems. A viewer: the
 * runs' commits, PRs, states and tiers' pass or fail, and the slot counts; never a log, summary, holder or problem.
 */
export declare function testRunsView(i: TestRunsViewInput): {
    queue: {
        id: string;
        sha: string;
        kind: "fast" | "full";
        prs: number[];
        state: "queued" | "failed" | "running" | "interrupted" | "cancelled" | "passed";
        tiers: {
            tier: string;
            ok: boolean;
        }[];
    }[];
    running: {
        id: string;
        sha: string;
        kind: "fast" | "full";
        prs: number[];
        state: "queued" | "failed" | "running" | "interrupted" | "cancelled" | "passed";
        tiers: {
            tier: string;
            ok: boolean;
        }[];
    }[];
    recent: {
        id: string;
        sha: string;
        kind: "fast" | "full";
        prs: number[];
        state: "queued" | "failed" | "running" | "interrupted" | "cancelled" | "passed";
        tiers: {
            tier: string;
            ok: boolean;
        }[];
    }[];
    viewer: true;
    configured: boolean;
    cap: number;
    inUse: number;
} | {
    network?: {
        state: "on";
        tiers: string[];
        change: string;
        status: string;
        why?: never;
    } | {
        state: "off" | "unknown";
        why: string;
        change: string;
        status: string;
        tiers?: never;
    };
    gpu?: {
        state: "on";
        devices: number[];
        maxMinutes: number;
        change: string;
        status: string;
        why?: never;
    } | {
        state: "off" | "unknown";
        why: string;
        change: string;
        status: string;
        devices?: never;
        maxMinutes?: never;
    };
    viewer: false;
    slots: {
        slot: string;
        owner: string;
        acquiredAt: string;
    }[];
    lock: {
        path: string;
        holders: {
            pid: number;
            mode: "shared" | "exclusive";
        }[] | null;
    };
    queue: TestRunRow[];
    running: TestRunRow[];
    recent: TestRunRow[];
    tierStats: TierStats[];
    sandbox: {
        ok: boolean;
        detail: string;
        at: string;
    } | null;
    checksPermission: {
        level: "write" | "read" | "none" | "unknown";
        detail: string;
        at: string;
    } | null;
    problems: string[];
    configured: boolean;
    cap: number;
    inUse: number;
};
