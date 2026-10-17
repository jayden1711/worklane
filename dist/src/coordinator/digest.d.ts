import type { Backlog } from '../backlog/types.js';
import type { ProjectConfig } from '../config/schema.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
export declare const DIGEST_LABEL = "digest";
/** The time of day the digest goes out: the first report time (08:00 by default). */
export declare function digestTime(times: string[]): string;
/** Post today's digest if it is due and not yet posted. Returns the issue it went to, or null. */
export declare function maybePostDigest(o: {
    log: EventLog;
    backlog: Backlog;
    project: ProjectConfig;
    emit: (payload: EventPayload<'digest.posted'>) => void;
    now?: Date;
}): Promise<number | null>;
