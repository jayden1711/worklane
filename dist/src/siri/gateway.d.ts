import { type Server } from 'node:http';
/** The gateway's loopback port, beside the hub's (4399) and the break-glass (4398). tailscale serve publishes it on 8443. */
export declare const SIRI_GATEWAY_PORT = 4397;
/** The tailnet HTTPS port tailscale serve publishes the gateway on. */
export declare const SIRI_TAILNET_PORT = 8443;
/** Bad tokens from one node before it is locked out, the window they count in, and how long the lockout lasts. */
export declare const LOCKOUT: {
    readonly fails: 10;
    readonly windowMs: number;
    readonly forMs: number;
};
export interface SiriGatewayInstance {
    name: string;
    /** The instance's own dashboard, on loopback. */
    port: number;
    /** Its Siri gateway token file (`siri-gateway-token`), which the hub's viewer may read. Never the dashboard token. */
    gatewayTokenFile: string;
}
export interface SiriGatewayOptions {
    instances: SiriGatewayInstance[];
    port?: number;
    host?: string;
    /** The hub's own audit file for refusals made here. */
    auditFile: string;
    /** Tests stand in for Tailscale (whois) and the kernel (peerUid). */
    whois?: (ip: string) => string;
    peerUid?: (clientPort: number, serverPort: number) => number | null;
    /** Tests only: a smaller lockout, so one test needs two bad tokens, not ten. */
    lockout?: {
        fails: number;
        windowMs: number;
        forMs: number;
    };
    now?: () => number;
}
/** One of the three routes, or null. */
export declare function gatewayRoute(method: string | undefined, path: string): {
    upstream: string;
    method: 'GET' | 'POST';
} | null;
export declare function startSiriGateway(o: SiriGatewayOptions): Promise<{
    server: Server;
    url: string;
    close: () => Promise<void>;
}>;
