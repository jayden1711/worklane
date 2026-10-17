import type { DatabaseSync } from 'node:sqlite';
import { type Document } from 'yaml';
export interface ConfigMigration {
    to: number;
    what: string;
    /** Edit one file's document (its name, e.g. `tests.yaml`, says which kind it is). */
    apply: (doc: Document, file: string) => void;
}
export interface StateMigration {
    to: number;
    what: string;
    /** Applied when the coordinator starts, needing no `migrate`: only for a step that changes nothing users see. */
    auto?: boolean;
    apply: (db: DatabaseSync) => void;
}
export declare const CONFIG_MIGRATIONS: ConfigMigration[];
export declare const STATE_MIGRATIONS: StateMigration[];
/** The event log's schema version a new log is created at. */
export declare const STATE_VERSION: number;
/** Instance files with a version, in the instance home. */
export declare const INSTANCE_FILES: string[];
/** One pending step: a config file or the event log, from its version to the latest. */
export interface Pending {
    kind: 'config' | 'state';
    path: string;
    from: number;
    to: number;
    steps: string[];
    /** Every step may run at start, without `migrate`. */
    auto: boolean;
}
export interface MigrationPlan {
    pending: Pending[];
    /** Files or logs at a version this engine doesn't know: written by a newer engine. */
    newer: string[];
    /** Files that couldn't be read as YAML: loading the config reports these in full. */
    unreadable: string[];
}
export interface Targets {
    /** Config files that carry a top-level `version`. */
    configFiles: string[];
    /** The event log, if there is one yet. */
    eventsDb?: string;
}
/** The versioned files in a project's config dir. */
export declare function projectConfigFiles(root: string): string[];
/** An instance's versioned files: its own (instance, policy, credentials, intake) and its repo's config dir. */
export declare function instanceTargets(home: string): Targets;
/** What is pending for these targets. Read-only. */
export declare function planMigrations(t: Targets, lists?: {
    config?: ConfigMigration[];
    state?: StateMigration[];
}): MigrationPlan;
/** Stamp a new event log at the latest state version (called once, when the log is created). */
export declare function stampNewLog(db: DatabaseSync, now?: Date): void;
/** A file or log and the backup made of it before it was migrated. */
export interface Backup {
    kind: 'config' | 'state';
    path: string;
    backup: string;
}
/** Put backups back: each file as it was; a log as it was, without the write-ahead files of the migrated one. */
export declare function restoreBackups(made: Backup[]): void;
/** A migration failed; every file and log it had touched was restored from its backup first. */
export declare class MigrationFailed extends Error {
    readonly restored: Backup[];
    constructor(message: string, restored: Backup[]);
}
/**
 * Apply every pending step (only the `auto` ones with `onlyAuto`), each file or log backed up first beside it
 * (`<name>.bak-v<from>-<time>`). Returns what was applied and the backups. A file or log newer than this engine
 * is never touched. If any step fails, everything this call migrated is restored and MigrationFailed is thrown:
 * all or nothing.
 */
export declare function applyMigrations(t: Targets, o?: {
    config?: ConfigMigration[];
    state?: StateMigration[];
    onlyAuto?: boolean;
    now?: () => Date;
}): {
    applied: Pending[];
    backups: string[];
    made: Backup[];
};
/** Why the coordinator can't start on these targets, or null: anything newer than this engine, or a pending step `migrate` must apply. */
export declare function migrationGate(t: Targets, lists?: {
    config?: ConfigMigration[];
    state?: StateMigration[];
}): string | null;
