import type { Backlog, Issue } from '../backlog/types.js';
import type { EventPayload, EventType, StoredEvent } from '../events/types.js';
import type { Hold } from '../hotspots.js';
import { FileClaims } from '../ownership.js';
export interface TaskGraphDeps {
    backlog: Pick<Backlog, 'get' | 'comment'>;
    emit: <T extends EventType>(type: T, payload: EventPayload<T>) => unknown;
    /** The log's events of these types, oldest first. */
    read: (types: EventType[]) => StoredEvent[];
    now?: () => number;
    /** WHY: tests shorten it; a real wait re-checks every 15 s. */
    pollMs?: number;
}
export declare class TaskGraph {
    private readonly d;
    readonly claims: FileClaims;
    private readonly gate;
    constructor(d: TaskGraphDeps);
    private now;
    private lastDep;
    /** WHY: one tracker read per ready issue is saved each pass; call once per dispatch pass. */
    seed(ready: readonly Issue[]): void;
    /** INVARIANT: true while `issue` waits on an open, unreadable or cyclic dependency; each hold and unblock is recorded once. */
    held(issue: Issue): Promise<boolean>;
    /** WHY: a held issue that is closed or relabeled must not show as held forever. */
    dropNotReady(stillReady: ReadonlySet<number>): void;
    private waited;
    private reportCycle;
    /**
     * INVARIANT: returns once `issue` owns `files`. While another running task owns any of them it waits; a wait
     * cycle lets its lowest issue go ahead (reported), and a claim with no live task is dropped (reported).
     * `halted` throws to end the wait on a stop.
     */
    own(issue: number, files: readonly string[], o: {
        live: (n: number) => boolean;
        halted: () => void;
        onHold: (h: Hold) => void;
        onFree: () => void;
    }): Promise<void>;
}
