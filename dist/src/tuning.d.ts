import type { FailureProposal } from './failure-modes.js';
export type TuningProposal = FailureProposal;
/** One suite run at a given worker count, from `tune`. */
export interface ProfileRun {
    workers: number;
    seconds: number;
    ok: boolean;
    /** The largest single process's peak memory (one test worker), when the OS reports it. */
    peakWorkerMb: number | null;
}
/** What `tune` measured, kept in the instance's state. */
export interface TuneProfile {
    at: string;
    command: string;
    cores: number;
    memAvailableMb: number | null;
    runs: ProfileRun[];
    /** The slowest tests, when the runner reports per-test times. */
    slowTests?: {
        id: string;
        seconds: number;
    }[];
}
export declare const TUNING: {
    /** A worker count is "as fast" as the best within this factor. */
    asFast: number;
    /** Share of available memory test workers may use together. */
    memoryShare: number;
    /** A full-suite check whose median is at least this long is worth splitting. */
    slowSuiteMin: number;
    /** Runs needed before a median counts. */
    minSamples: number;
    /** A test at least this slow is a candidate for the nightly tier. */
    slowTestSeconds: number;
};
/**
 * The worker count to use: the fewest workers within `asFast` of the fastest passing run (more workers past
 * that point only take cores from other tasks), then no more than the memory available holds.
 */
export declare function recommendWorkers(runs: ProfileRun[], memAvailableMb: number | null): {
    workers: number;
    why: string;
} | null;
export interface TuningInput {
    /** Verify-stage check durations, oldest first. */
    checks: {
        check: string;
        durationMs: number;
    }[];
    /** The project's full-suite check (as it appears in check results). */
    fullCheck?: string;
    /** The worker cap in force now (tests.yaml cores.max, or a fixed worker count), if any. */
    currentWorkers: number | null;
    profile?: TuneProfile | null;
}
/** The profile `tune` left in the instance's state, if any. */
export declare function readTuneProfile(stateDir: string): TuneProfile | null;
/** Variable names that usually hold a test worker count. */
export declare const WORKER_VAR: RegExp;
/** The worker cap in force: tests.yaml cores.max, else a fixed number in a worker variable, else none. */
export declare function currentWorkerCap(tests: {
    cores?: {
        max?: number | undefined;
    };
    env: Record<string, string>;
}): number | null;
/**
 * The tuning input from the event log: every verify-stage check's duration, and the full-suite check, which is
 * whichever of the candidates (runner.full and the project's checks) has the longest median among what ran.
 */
export declare function tuningInput(events: {
    type: string;
    payload: unknown;
}[], tests: {
    runner: {
        full: string;
    };
    checks: string[];
    cores?: {
        max?: number | undefined;
    };
    env: Record<string, string>;
}, profile: TuneProfile | null): TuningInput;
export declare function tuningProposals(input: TuningInput): TuningProposal[];
