import type { DoneWhenList } from './backlog/types.js';
export interface CheckRecord {
    check: string;
    status: 'pass' | 'fail' | 'unavailable' | 'skipped';
    exitCode?: number | null | undefined;
    duration_ms?: number | undefined;
    /** A browser check, set by the coordinator, never inferred from a name (a command can be called anything). */
    kind?: 'browser' | undefined;
}
/** The sentences of a worker's summary that claim verification (at most 10, each at most 300 characters). */
export declare function claimsOf(summary: string): string[];
/**
 * The claims no record backs. A claim naming a command or file is backed only if a passing check or a successful
 * worker command contains it. Otherwise, one about a place or way the coordinator never checks (a phone, a browser,
 * by hand) is not backed; and any other is backed only if at least one of the coordinator's checks passed.
 */
export declare function unbackedClaims(claims: string[], record: {
    checks: CheckRecord[];
    commands: string[];
}): string[];
/** One step less sure for each reason given (high → medium → low), never below low. */
export declare function lowerConfidence(c: 'high' | 'medium' | 'low', unbacked: number): 'high' | 'medium' | 'low';
/** The three receipt sections for a PR description. */
export declare function receiptLines(o: {
    checks: CheckRecord[];
    doneWhen: DoneWhenList;
    unverified: string[];
}): string[];
