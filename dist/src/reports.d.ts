import type { Config } from './config/load.js';
import type { StoredEvent } from './events/types.js';
import { type Scorecard } from './scorecard.js';
export interface Report {
    markdown: string;
    card: Scorecard;
}
export declare function buildReport(events: StoredEvent[], cfg: Config, opts: {
    since: Date;
    now?: Date;
    previous?: Scorecard | null;
    slot?: string;
}): Report;
/** The report slot due now (latest configured time already passed today), or null. */
export declare function dueSlot(times: string[], now?: Date): string | null;
