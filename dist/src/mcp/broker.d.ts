import { type Server, type Socket } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { type McpRecord } from '../plugins/approval.js';
import { diffSnapshots } from './snapshot.js';
/** The most a tool result may be before it is refused, not passed on. */
export declare const MAX_RESULT_BYTES: number;
export declare const TICKET: RegExp;
export interface BrokerDeps {
    /** The instance's approved MCP servers now (root's allowlist, read fresh for every session). */
    servers: () => McpRecord[];
    /** One secret of one server, or null when it isn't installed. */
    secret: (id: string, name: string) => string | null;
    /** Start one approved server in its sandbox with these secrets, for one session. */
    launch: (r: McpRecord, secrets: Record<string, string>, sessionId: string) => ChildProcess;
    /** The broker's own state directory (blocked servers, the call log). */
    stateDir: string;
    now?: () => number;
    log?: (line: string) => void;
}
export interface Blocked {
    at: string;
    approved: string | null;
    live: string;
    diff: ReturnType<typeof diffSnapshots>;
}
export declare class Broker {
    private d;
    private tickets;
    private sessions;
    constructor(d: BrokerDeps);
    private now;
    private blockedFile;
    private log;
    /** Servers blocked by a rug-pull check, by id: until a new approval changes the approved snapshot. */
    blocked(): Record<string, Blocked>;
    private block;
    private isBlocked;
    private callLog;
    control(line: string): string;
    serveControl(sock: Socket): void;
    /**
     * The second snapshot of an APPROVED server (Q3), for root: started as for a session (its secrets, its network, its
     * sandbox), listed, stopped; never compared or blocked here (the owner reviews it as an update). Unapproved code
     * never reaches this: its snapshot is a throwaway user's (src/mcp/throwaway.ts).
     */
    snapshotFor(line: string): Promise<string>;
    serveClient(sock: Socket): void;
    /** Start the server for one session and check it against its approved snapshot. */
    private start;
    private answer;
    /** Listen on the client and control sockets (each opened 0660 to its own group by the unit). */
    listen(clientPath: string, controlPath: string): {
        client: Server;
        control: Server;
    };
}
