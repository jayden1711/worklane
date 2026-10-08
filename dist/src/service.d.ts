import type { Backlog } from './backlog/types.js';
import { type Config } from './config/load.js';
export declare const instanceId: () => string;
export declare const logPath: (root: string) => string;
export declare const serviceLabel: (cfg: Config) => string;
export declare function backlogFor(cfg: Config, root: string): Backlog;
export declare function runCoordinator(root: string, opts?: {
    once?: boolean;
    intervalMs?: number;
    backupDir?: string;
}): Promise<number>;
/** A plain-text status summary from the event log (the dashboard reads the same log). */
export declare function status(root: string): string;
