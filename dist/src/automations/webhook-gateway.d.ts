import { type Server } from 'node:http';
/** The gateway's loopback port, beside Siri's (4397), the break-glass (4398) and the hub (4399). */
export declare const HOOKS_GATEWAY_PORT = 4396;
/** The tailnet HTTPS port tailscale serve publishes it on. */
export declare const HOOKS_TAILNET_PORT = 8444;
export declare const LOCKOUT: {
    readonly fails: 10;
    readonly windowMs: number;
    readonly forMs: number;
};
export interface HooksGatewayInstance {
    name: string;
    /** The instance's own dashboard, on loopback. */
    port: number;
    /** Its hooks gateway token file (`hooks-gateway-token`), which the hub's viewer may read with --hooks. */
    gatewayTokenFile: string;
}
export interface HooksGatewayOptions {
    instances: HooksGatewayInstance[];
    port?: number;
    host?: string;
    auditFile: string;
    /** Tests stand in for Tailscale (whois, this machine's own node) and the kernel (peerUid). */
    whois?: (ip: string) => string;
    peerUid?: (clientPort: number, serverPort: number) => number | null;
    /** This machine's own Tailscale node id (tailscale status Self.ID), or null when it can't be told: then nothing is taken. */
    selfNode?: () => string | null;
    lockout?: {
        fails: number;
        windowMs: number;
        forMs: number;
    };
    now?: () => number;
}
/** This machine's own node, from `tailscale status --json` (Self.ID), or null. */
export declare function tailscaleSelfNode(): string | null;
export declare function startHooksGateway(o: HooksGatewayOptions): Promise<{
    server: Server;
    url: string;
    close: () => Promise<void>;
}>;
