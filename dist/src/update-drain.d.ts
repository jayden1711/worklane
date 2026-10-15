export interface UpdateDrain {
    /** When the drain began. */
    since: string;
    /** When it lapses unless the updater writes it again. */
    until: string;
    /** The engine commit it waits to install, when known. */
    to: string | null;
}
/** The longest a flag is honored past now. The updater writes at most 3 hours ahead (an install's whole span). */
export declare const DRAIN_TTL_MAX_MS: number;
/** The drain in force now, or null: none, unreadable, expired, or with an expiry too far ahead to be the updater's. */
export declare function updateDrain(dir?: string, now?: number): UpdateDrain | null;
/** What a gate says when the drain holds it. */
export declare function drainHoldLine(d: UpdateDrain): string;
/** The start gate's `drain` source (src/testrun/gate.ts): why no test run may start now, or null. Cheap, never throws. */
export declare function drainRefusal(): string | null;
