import type { DatabaseSync } from 'node:sqlite';
import type { StoredEvent } from './types.js';
/** An events database opened read-only, waiting out another connection's lock (src/events/read-only.ts). */
export type OpenRead = (path: string) => DatabaseSync;
export declare class EventCache {
    readonly path: string;
    private readonly open;
    private snap;
    private last;
    /** What was read: the file (device and inode) and its schema version; a change to either reads it whole again. */
    private identity;
    private memos;
    /** How many times the log was read whole (tests). */
    fullReads: number;
    constructor(path: string, open?: OpenRead);
    /**
     * Every event, oldest first, as the log has it now. Frozen at run time (typed mutable only so the views' signatures
     * stay as they are): never change it, or anything in it; a copy (filter, slice, spread) is yours.
     */
    all(): StoredEvent[];
    /** The events after `id`, oldest first (the log as it is now). */
    after(id: number): StoredEvent[];
    /** The last event's id (0 for none). */
    lastId(): number;
    /**
     * `fn` of the events as they are now, computed once per snapshot and kept until the log changes. Only for a pure fold
     * of the events (`key` names it and anything else it depends on, such as the day). The value is frozen like the events.
     */
    memo<T>(key: string, fn: (events: StoredEvent[]) => T): T;
    private refresh;
    private reset;
}
