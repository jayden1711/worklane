import { DatabaseSync } from 'node:sqlite';
/**
 * How long a connection waits on another one's lock before SQLite says "database is locked". WHY: in WAL mode a reader
 * still meets a lock: the last connection to close checkpoints and drops the WAL under an exclusive lock, which any
 * process's close (a CLI write, the dashboard's own audit write, a log the garbage collector closes) can take while a
 * read opens. Without a wait that read fails, and the dashboard answers 500.
 */
export declare const BUSY_TIMEOUT_MS = 5000;
/** An events database opened read-only, waiting out another connection's lock (BUSY_TIMEOUT_MS). The caller closes it. */
export declare function openReadOnly(path: string): DatabaseSync;
