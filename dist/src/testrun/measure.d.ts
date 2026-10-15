import type { EventLog } from '../events/log.js';
import type { StoredEvent } from '../events/types.js';
import { type HeldFlock } from '../os/index.js';
import type { TestRunConfig } from './config.js';
import type { RunHost } from './host.js';
import { type TestRunResult } from './run.js';
/** A measure request refused before anything started. The message says why; nothing was made or called. */
export declare class MeasureRefused extends Error {
}
/** At most this many values in one `--set`: each is a whole run, one after another. */
export declare const MAX_VALUES = 12;
/** The keys the engine sets for a run, never a measure's to change: the host's, the database's, the caches' and the shared directories'. */
export declare function engineSetKeys(c: Pick<TestRunConfig, 'caches' | 'shared'>): string[];
export interface MeasurePlan {
    sha: string;
    tiers: string[];
    key: string;
    values: string[];
    /** The kind the run is recorded as: full when a named tier is. Named tiers run unsharded either way. */
    kind: 'fast' | 'full';
}
/**
 * Check a measure request against the project's test_run config, before anything starts. `sets`: every `--set`
 * given, as written. Throws MeasureRefused with the reason; returns what to run otherwise.
 */
export declare function planMeasure(c: TestRunConfig, req: {
    sha: string;
    tiers: string[];
    sets: string[];
}): MeasurePlan;
/**
 * Why the machine isn't quiet enough to measure, or null when it is: a test run of this instance queued or running
 * (from its event log), any test slot held on the machine, or the full-run lock held (or a holder this can't rule out).
 */
export declare function busyReason(events: readonly StoredEvent[], o?: {
    slotsDir?: string;
    lockPath?: string;
}): string | null;
/** Per-suite durations a runner prints as `⏱ <name>: 12.3s` lines; else its per-test ones (src/test-durations.ts). */
export declare function suiteDurations(out: string): {
    name: string;
    ms: number;
}[];
export interface MeasureTier {
    tier: string;
    /** passed, failed, timed out (or cancelled), or not run. */
    status: 'passed' | 'failed' | 'timed out' | 'not run';
    durationMs: number;
    /** The sandbox unit's CPU time and peak memory (systemd-run's summary); null where the host can't tell. */
    cpuS: number | null;
    memPeakMb: number | null;
    /** cpuS over the tier's wall time: how many cores it kept busy on average. */
    avgCores: number | null;
    suites: {
        name: string;
        ms: number;
    }[];
}
export interface MeasureValue {
    key: string;
    value: string;
    runId: string;
    ok: boolean;
    outcome: TestRunResult['outcome'];
    wallMs: number;
    tiers: MeasureTier[];
    /** The setup step that failed, if one did. */
    setup?: string;
}
export interface MeasureDeps {
    instance: string;
    config: TestRunConfig;
    host: RunHost;
    /** The instance's checkout, where the commit is. */
    repo: string;
    /** The instance's event log: read for its runs in flight, written only with testrun.measure. */
    log: Pick<EventLog, 'append' | 'read'>;
    actor: string;
    /** Where the runs' tier logs go (the instance's private state). */
    logDir: string;
    sparseExclude?: readonly string[];
    lockPath?: string;
    slotsDir?: string;
    slotPollMs?: number;
    lock?: (path: string, signal?: AbortSignal) => Promise<HeldFlock>;
    now?: () => number;
    /** Each value's result as it finishes. */
    onValue?: (v: MeasureValue) => void;
    signal?: AbortSignal;
}
/**
 * Run the plan's tiers once per value, one after another, each a full sandboxed run with the key set to that value.
 * Refuses (MeasureRefused, nothing started) while the machine is busy or the helper is outdated or fails its check.
 * Stops before the next value when the machine became busy meanwhile, or on `signal` (the run going is cancelled and
 * wiped by runTestRun).
 */
export declare function runMeasure(d: MeasureDeps, plan: MeasurePlan): Promise<{
    values: MeasureValue[];
    stopped: string | null;
}>;
/** Measure runs started and never finished (the measure was killed): their run ids, to wipe. */
export declare function unfinishedMeasureRuns(events: readonly StoredEvent[]): string[];
/** One value's line: wall time, then each tier's status, time, CPU and memory, and its slowest suites. */
export declare function measureLine(v: MeasureValue, suitesShown?: number): string;
