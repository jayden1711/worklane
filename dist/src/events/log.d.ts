import type { DatabaseSync } from 'node:sqlite';
import { type EventPayload, type EventType, type StoredEvent } from './types.js';
/**
 * Why a write failed because the storage refused it (the disk or quota is full, or an I/O error writing it), or null
 * for anything else. INVARIANT: only storage failures; a schema, constraint or programming error is null, so its
 * caller still throws.
 */
export declare function storageFailure(e: unknown): string | null;
/** At most this many events wait in memory while the log can't be written (EventLog's `buffer` option). */
export declare const BUFFER_MAX = 20000;
export interface EventLogOptions {
    /**
     * Keep events the storage refused (storageFailure: a full disk) in memory, in order, and write them on flush(),
     * instead of throwing. Only for the coordinator's own log: its timers and ticks must never die on a full disk.
     */
    buffer?: {
        max?: number;
    };
}
/** A write the storage refused, as the log last saw it. */
export interface WriteFailure {
    at: string;
    reason: string;
}
export declare class EventLog {
    readonly path: string;
    private readonly opts;
    readonly db: DatabaseSync;
    private listeners;
    /** Events the storage refused, oldest first, each with the time it happened: written by flush(). */
    private pending;
    /** Events refused while the buffer was full: lost, and counted. */
    private droppedCount;
    private failure;
    private failureListeners;
    constructor(path: string, opts?: EventLogOptions);
    append<T extends EventType>(type: T, payload: EventPayload<T>, actor: string, source?: StoredEvent['source']): StoredEvent<T>;
    /** Whether a caller's transaction is open on this connection (isTransaction, from Node 22.16; asked of SQLite before). */
    private inTransaction;
    private insert;
    /**
     * Keep an event the storage refused, with a provisional id: the next after the log's last (or the last kept), the id
     * it gets when written unless another process writes first (on a full disk, none can). INVARIANT: ids keep rising,
     * so code that compares them (an event after another) reads the kept events as it will read them once written.
     */
    private hold;
    private failed;
    /** Events waiting in memory to be written (the storage refused them), and those lost because the buffer was full. */
    buffered(): {
        count: number;
        dropped: number;
        failure: WriteFailure | null;
    };
    /** Called on each write the storage refuses (the first, and each failed flush). */
    onWriteFailure(fn: (f: WriteFailure) => void): () => void;
    /**
     * Write the waiting events, in order, in one transaction: all of them or none. Returns how many were written, or
     * why none could be (the storage still refuses). Anything other than a storage failure throws.
     */
    flush(): {
        written: number;
        error: string | null;
    };
    /**
     * Events after `afterId`, optionally of some types, ending with the events waiting to be written (provisional ids),
     * so what the coordinator decides from the log counts them: a report already posted is not posted again while the
     * disk is full.
     */
    read(afterId?: number, types?: EventType[]): StoredEvent[];
    private readStored;
    lastId(): number;
    subscribe(fn: (e: StoredEvent) => void): () => void;
    close(): void;
}
