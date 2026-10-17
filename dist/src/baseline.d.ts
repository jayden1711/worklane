import type { EventLog } from './events/log.js';
export interface FailureFormat {
    /** Regex for the line that starts the failure list. */
    section: string;
    /** Regex with one capture group: a failing test or suite name. */
    item: string;
}
export interface ParsedFailures {
    names: string[];
    /** The count the runner itself reported on the section line, when it does. */
    reported: number | null;
}
/** Failing names in a run's output, or null when the output has no failure section. */
export declare function parseFailureList(output: string, fmt: FailureFormat): ParsedFailures | null;
/** Why a parsed list can't be trusted, or null. A count mismatch means the item pattern is wrong. */
export declare function listProblem(p: ParsedFailures | null): string | null;
export declare function parseFailures(output: string, fmt: FailureFormat): string[] | null;
export interface Baseline {
    sha: string;
    failing: string[];
    recordedAt: string;
}
export declare function latestBaseline(log: EventLog): Baseline | null;
export type GateVerdict = {
    outcome: 'pass';
    preexisting: string[];
    note: string;
} | {
    outcome: 'fail';
    newFailures: string[];
    note: string;
};
export declare function baselineGate(exitCode: number | null, output: string, fmt: FailureFormat | undefined, baseline: Baseline | null): GateVerdict;
export declare function recordBaseline(log: EventLog, actor: string, sha: string, exitCode: number | null, output: string, fmt: FailureFormat | undefined): {
    ok: true;
    failing: string[];
} | {
    ok: false;
    why: string;
};
/** The latest baseline straight from an events database, read-only (for hooks; never creates the file). */
export declare function readBaseline(dbPath: string): Baseline | null;
