import type { Snapshot } from './snapshot.js';
export interface McpRun {
    ticket: string;
    servers: {
        id: string;
        tools: string[];
    }[];
}
/**
 * A ticket for one run of `role`, and the approved, unblocked servers it may use. Null when the instance has no broker
 * (no MCP servers set up): the run gets none. A broker that is there but refuses or fails is an error: the run doesn't
 * start, rather than start without servers the owner approved silently.
 */
export declare function registerRun(instance: string, role: string, ttlMs: number, path?: string): Promise<McpRun | null>;
export declare function endRun(instance: string, ticket: string, path?: string): Promise<void>;
/** Claude Code's name for an MCP tool: mcp__<server>__<tool>, any character outside A-Z a-z 0-9 _ - as _. */
export declare const toolName: (server: string, tool: string) => string;
/** What a run with MCP servers passes to claude. */
export declare function mcpRunArgs(instance: string, run: McpRun, node: string, engineCli: string): {
    config: object;
    allowedTools: string[];
    allowedMcpServers: {
        serverCommand: string[];
    }[];
    names: string[];
};
/** The broker's blocked servers (the Plugins page): null when the instance has no broker or it doesn't answer. */
export declare function brokerStatus(instance: string, path?: string): Promise<Record<string, unknown> | null>;
/**
 * Root (plugins.sh mcp-snapshot): the second snapshot of an approved server, taken by the broker as it would start it
 * for a session (its secrets, its approved network, its sandbox). The reply is checked against the snapshot's schema:
 * data, never a command.
 */
export declare function brokerSnapshot(instance: string, id: string, path?: string): Promise<{
    snapshot: Snapshot | null;
    error: string | null;
}>;
