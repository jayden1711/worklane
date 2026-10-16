import { type ChildProcess } from 'node:child_process';
import type { McpRuntime } from '../plugins/approval.js';
export declare const SERVER_PATH = "/usr/local/bin:/usr/bin:/bin";
/** The argv as it runs: ${CLAUDE_PLUGIN_ROOT} resolved to the approved code directory, nothing else expanded. */
export declare function resolveArgv(runtime: McpRuntime, codeDir: string): string[];
export interface LaunchOptions {
    /** The engine's own cli.js and the node that runs it (root-owned, /opt and /usr/local/bin). */
    engineCli: string;
    node: string;
    runtime: McpRuntime;
    codeDir: string;
    /** Its own secrets, by name. Never anyone else's. */
    secrets: Record<string, string>;
    network: string[];
    /** A directory of its own to write in, made fresh for this start. */
    scratchDir: string;
    /** Paths it may not read even where the OS would let it: every server's secrets, the broker's state. */
    denyRead: string[];
    /** Start as this user (root starting a quarantine run as the broker's user); unset: as this process. */
    as?: {
        uid: number;
        gid: number;
    };
    /** Test seam: start without the sandbox. Never set by the broker or plugins.sh. */
    unsandboxed?: boolean;
}
export declare function launchServer(o: LaunchOptions): ChildProcess;
