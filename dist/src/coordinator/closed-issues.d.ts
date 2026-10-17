import type { Backlog } from '../backlog/types.js';
import type { StoredEvent } from '../events/types.js';
export declare class ClosedIssueWatch {
    /** When the last listing was asked for, and the held issues it covered from then on. */
    private last;
    /** The held issues now closed on GitHub, to record as `issue.closed`. No held issue: no call. */
    check(events: StoredEvent[], backlog: Backlog, now?: Date): Promise<number[]>;
}
