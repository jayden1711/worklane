import type { ChildProcess } from 'node:child_process';
import { LineChannel } from './jsonrpc.js';
import { type Snapshot } from './snapshot.js';
/** The protocol revision the broker speaks to servers (MCP 2025-11-25). */
export declare const UPSTREAM_PROTOCOL = "2025-11-25";
export interface Upstream {
    child: ChildProcess;
    channel: LineChannel;
    snapshot: Snapshot;
    /** Called when the server says its tools changed: the broker re-lists and compares. */
    onListChanged: () => void;
    list(): Promise<Snapshot>;
    call(name: string, args: unknown, timeoutMs: number): Promise<unknown>;
    stop(): void;
}
/** Handshake with a started server (stdio) and list its tools. Rejects when it doesn't answer as an MCP server. */
export declare function connectUpstream(child: ChildProcess, o: {
    clientName: string;
    timeoutMs?: number;
}): Promise<Upstream>;
