import { type LaunchOptions } from './launch.js';
import type { Snapshot } from './snapshot.js';
export interface SnapshotResult {
    snapshot: Snapshot | null;
    error: string | null;
    withSecrets: boolean;
    network: string[];
}
export declare function takeSnapshot(o: LaunchOptions & {
    timeoutMs?: number;
}): Promise<SnapshotResult>;
