import type { IncomingMessage, Server } from 'node:http';
import { type AuditSink, type Exec, type SpawnPty, type TerminalConfig } from './terminal.js';
import type { SessionOf } from './session.js';
import { type DeviceOptions } from './terminal-devices.js';
export interface TerminalServerOptions {
    config: TerminalConfig;
    /** The instances the hub serves; the terminal opens from one of them, as its owner. */
    instances: string[];
    session: SessionOf;
    audit: AuditSink;
    /** The Tailscale devices allowed to open it (console_devices), and how they're identified (terminal-devices.ts). */
    devices: DeviceOptions;
    spawnPty?: SpawnPty;
    exec?: Exec;
    now?: () => number;
    idleMs?: number;
}
export declare const TERMINAL_PATH = "/api/terminal";
/** Whether the request's Origin is the host it was sent to (a browser always sends Origin on a WebSocket). */
export declare function sameOrigin(req: IncomingMessage): boolean;
/** Serve the terminal on this server's upgrades to TERMINAL_PATH; others are refused. Returns a closer. */
export declare function attachTerminal(server: Server, o: TerminalServerOptions): () => void;
