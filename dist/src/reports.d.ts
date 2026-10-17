import type { Config } from './config/load.js';
import type { StoredEvent } from './events/types.js';
import { type FailureProposal } from './failure-modes.js';
import { type RunRecord } from './run-record.js';
export interface Report {
    markdown: string;
    /** Fixes proposed for repeated failures (weekly section only): for the owner to decide on. */
    proposals: FailureProposal[];
}
/** Run records that ended at or after `since`, from an instance's state dir (none if unreadable). */
export declare function recentRunRecords(stateDir: string, since: Date): RunRecord[];
/** The weekly section goes in the first report of each Monday (and every preview, which has no slot). */
export declare function weeklyDue(times: string[], slot: string | undefined, now: Date): boolean;
/** A warning line for the coordinator's GitHub token: 7 days before it expires, or always if it never does. */
export declare function tokenWarning(expiresAt: string | null | undefined, now?: Date): string | null;
/** A GitHub App's private key never expires, so it is rotated on a schedule instead. */
export declare const APP_KEY_ROTATE_DAYS = 90;
/** Days since the App key file was installed on this machine (rotating it installs a new file), or null if unreadable. */
export declare function appKeyAge(keyPath: string, now?: Date): number | null;
/** A warning line once the App key is due for rotation. */
export declare function appKeyWarning(days: number | null): string | null;
export declare function buildReport(events: StoredEvent[], cfg: Config, opts: {
    since: Date;
    now?: Date;
    slot?: string;
    tokenExpiresAt?: string | null;
    appKeyPath?: string;
    runRecords?: RunRecord[];
    weekly?: boolean;
    throughput?: boolean;
}): Report;
/** The report slot due now (latest configured time already passed today), or null. */
export declare function dueSlot(times: string[], now?: Date): string | null;
