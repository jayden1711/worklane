import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import type { CheckOutcome } from './pr-watch.js';
export declare const FLAKY_EVENTS: readonly ["flaky.rerun_requested", "flaky.rerun_result", "flaky.quarantined", "flaky.sighted", "flaky.observed", "flaky.released"];
export interface QuarantinedTest {
    test: string;
    state: 'quarantined' | 'released';
    firstSeen: string;
    lastSeen: string;
    /** How many times it was seen flaky (a failure that passed on the re-run). */
    sightings: number;
    issue: number | null;
    url: string | null;
    /** Passes in a row on the default branch since it was (last) quarantined. */
    passes: number;
    released: {
        at: string;
        how: 'passes' | 'owner';
        by: string;
    } | null;
}
/** Every test ever quarantined, by name, as the log has it now. */
export declare function quarantine(events: readonly StoredEvent[]): Map<string, QuarantinedTest>;
export declare const isQuarantined: (q: ReadonlyMap<string, QuarantinedTest>, test: string) => boolean;
/** A failure, as the harness's red/green decisions count one. */
export declare const failed: (o: CheckOutcome) => o is "fail" | "cancelled";
export interface RerunVerdict {
    flaky: string[];
    real: string[];
    timedOut: string[];
    /** Not finished re-running yet (empty once timed out). */
    waiting: string[];
}
/**
 * The re-run's verdict on each check that failed: passed now (flaky), failed again or couldn't re-run (real), or
 * not finished (waiting; real once `timedOut`). `now`: each check's outcome on the re-run, null while it runs.
 */
export declare function classifyRerun(checks: {
    check: string;
    now: 'pass' | 'fail' | null;
}[], timedOut: boolean): RerunVerdict;
/** The passes in a row after one more result, and whether that releases it (at `releaseAfter`). */
export declare function afterResult(passes: number, ok: boolean, releaseAfter: number): {
    passes: number;
    release: boolean;
};
export interface FlakeRate {
    days: number;
    /** Red runs on the default branch that were re-run (flaky.rerun_requested). */
    redRuns: number;
    /** Of those, the re-runs that found a flaky test (at least one failure passed on the re-run). */
    flakyReruns: number;
    /** flakyReruns / redRuns; null with no red runs. */
    rate: number | null;
}
/** The flake rate over each window (default 7 and 30 days, up to `now`): flaky re-runs over red runs. */
export declare function flakeRates(events: readonly StoredEvent[], now: Date, windows?: readonly number[]): FlakeRate[];
export declare const issueTitle: (test: string) => string;
export declare function issueBody(o: {
    test: string;
    sha: string;
    branch: string;
    product: string;
    releaseAfter: number;
}): string;
/** The dashboard's view: the quarantined tests, those released lately, and the flake rate. */
export declare function flakyView(events: readonly StoredEvent[], o: {
    now: Date;
    releaseAfter: number;
}): {
    releaseAfter: number;
    quarantined: QuarantinedTest[];
    released: QuarantinedTest[];
    rates: FlakeRate[];
};
/**
 * An owner clears a test from quarantine (the dashboard; the caller checks they are an owner and audits it): it blocks
 * again from the next commit. Refused for a test not quarantined.
 */
export declare function releaseByOwner(log: EventLog, test: unknown, by: string): {
    ok: true;
} | {
    ok: false;
    status: 400 | 404;
    error: string;
};
