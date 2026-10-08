import type { Config } from './config/load.js';
import { type Job } from './queue.js';
/** Queue a full run on the tip of main that records main's baseline when it finishes. */
export declare function queueBaselineRun(root: string, cfg: Config, eventsDb: string, actor: string, maxLoad?: number): Job;
/** True once per day, after the configured time (local), if nightly isn't queued yet. */
export declare function nightlyDue(at: string | undefined, lastQueuedDay: string | null, now?: Date): boolean;
export declare function queueNightly(root: string, cfg: Config, eventsDb: string, actor: string): Job[];
