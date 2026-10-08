import { DatabaseSync } from 'node:sqlite';
import { type EventPayload, type EventType, type StoredEvent } from './types.js';
export declare class EventLog {
    readonly path: string;
    readonly db: DatabaseSync;
    private listeners;
    constructor(path: string);
    append<T extends EventType>(type: T, payload: EventPayload<T>, actor: string, source?: StoredEvent['source']): StoredEvent<T>;
    /** Events after `afterId`, optionally of some types. */
    read(afterId?: number, types?: EventType[]): StoredEvent[];
    lastId(): number;
    subscribe(fn: (e: StoredEvent) => void): () => void;
    close(): void;
}
