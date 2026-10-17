import { z } from 'zod';
import { type BackupResult, type BackupStore } from './events/backup.js';
import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
/** The file, in the instance home beside policy.yaml, that turns off-machine backups on. */
export declare const OFFSITE_FILE = "offsite-backup.yaml";
/** What each command gets: the file to read, the file to write, and the copy's name at the destination. */
export declare const VARS: {
    readonly in: "WORKLANE_BACKUP_IN";
    readonly out: "WORKLANE_BACKUP_OUT";
    readonly name: "WORKLANE_BACKUP_NAME";
};
export declare const OffsiteConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    destination: z.ZodString;
    every_hours: z.ZodDefault<z.ZodNumber>;
    encrypt: z.ZodString;
    put: z.ZodString;
    get: z.ZodString;
    decrypt: z.ZodString;
    timeout_minutes: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type OffsiteConfig = z.infer<typeof OffsiteConfig>;
/** A copy older than this is reported as stale. */
export declare const STALE_HOURS = 24;
/** The owner's config, or null when there's none (off-machine backups are off). A file anyone else could change is refused: it runs commands. */
export declare function loadOffsiteConfig(path: string): {
    config: OffsiteConfig;
} | {
    error: string;
} | null;
/** A backup store made of the owner's commands; `tmp` is a private scratch dir the caller removes. */
export declare function commandStore(c: OffsiteConfig, tmp: string): BackupStore;
/** One off-machine backup, verified by reading the remote copy back and decrypting it. */
export declare function offsiteBackup(log: EventLog, c: OffsiteConfig, now?: Date): Promise<BackupResult>;
export interface OffsiteEvent {
    ok: boolean;
    destination: string;
    key: string;
    last_id: number;
    error?: string;
}
/** Due: no attempt yet, the last copy is `every_hours` old, or the last attempt failed over an hour ago. */
export declare function offsiteDue(events: StoredEvent[], c: OffsiteConfig, now?: Date): boolean;
/** Called by the service about once an hour: runs a backup when one is due and records the outcome either way. */
export declare function maybeOffsiteBackup(log: EventLog, configPath: string, actor: string, now?: Date): Promise<OffsiteEvent | null>;
export interface OffsiteStatus {
    destination: string;
    /** The last copy verified by reading it back, or null if none ever was. */
    lastOkAt: string | null;
    lastOkKey: string | null;
    lastAttemptAt: string;
    /** The latest attempt's error, when it failed. */
    lastError: string | null;
    /** Hours since the last verified copy (null: never). */
    ageHours: number | null;
    /** No verified copy, or the last one is over a day old. */
    stale: boolean;
}
/** The off-machine backup's state from the log, or null if it was never set up (no attempt recorded). */
export declare function offsiteStatus(events: StoredEvent[], now?: Date): OffsiteStatus | null;
/** The report line: every report when set up; a warning when the last verified copy is over a day old. */
export declare function offsiteLine(s: OffsiteStatus | null): string | null;
