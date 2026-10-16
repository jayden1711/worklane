import { spawnSync } from 'node:child_process';
import { type McpRuntime } from '../plugins/approval.js';
import { resolveArgv } from './launch.js';
import type { Snapshot } from './snapshot.js';
/** The transient unit's properties: every one is part of the boundary, so a test checks each. */
export declare const THROWAWAY_PROPERTIES: readonly ["DynamicUser=yes", "PrivateNetwork=yes", "PrivateTmp=yes", "PrivateDevices=yes", "ProtectSystem=strict", "ProtectHome=yes", "NoNewPrivileges=yes", "RestrictAddressFamilies=AF_UNIX", "RuntimeMaxSec=90", "MemoryMax=1G", "UMask=0077"];
/** systemd-run's arguments for one snapshot: the engine's own snapshot-job, as a throwaway user, waited for. */
export declare function throwawayCommand(o: {
    node: string;
    engineCli: string;
    runtime: McpRuntime;
    codeDir: string;
    unit: string;
}): string[];
/** Root: run one snapshot as a throwaway user; the snapshot it printed, checked against the schema, or why not. */
export declare function runThrowawaySnapshot(o: {
    node: string;
    engineCli: string;
    runtime: McpRuntime;
    codeDir: string;
    unit: string;
}, spawn?: typeof spawnSync): {
    snapshot: Snapshot | null;
    error: string | null;
};
/** The job's last line, as data: {"snapshot": ...} or {"error": "..."}; anything else is an error. */
export declare function parseSnapshotOutput(stdout: string, status: number | null, stderr?: string): {
    snapshot: Snapshot | null;
    error: string | null;
};
/** Inside the throwaway unit: start the server from its read-only code, list its tools, print one JSON line. */
export declare function snapshotJob(codeDir: string, argv: string[]): Promise<string>;
export { resolveArgv };
