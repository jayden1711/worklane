import type { IncomingMessage, ServerResponse } from 'node:http';
/** The gateway's token file, beside the dashboard token in the instance's state. */
export declare const HOOKS_GATEWAY_TOKEN_FILE = "hooks-gateway-token";
/** The headers a delivery carries (the caller sets the first three; the gateway the node, from Tailscale). */
export declare const HOOK_HEADERS: {
    readonly timestamp: "x-hook-timestamp";
    readonly delivery: "x-hook-delivery";
    readonly signature: "x-hook-signature";
    readonly node: "x-hook-node";
};
/** The instance route the gateway calls: /api/hooks/<automation id>, and nothing else. */
export declare const HOOK_ROUTE: RegExp;
/** A delivery's body, at most. */
export declare const BODY_MAX: number;
/** How far a delivery's timestamp may be from now, either way (seconds). */
export declare const WINDOW_S = 300;
/** How long a delivery id is remembered: longer than the window, so a replay is always refused. */
export declare const REPLAY_KEEP_MS: number;
/** Deliveries one automation accepts an hour, at most (each still waits for an owner). */
export declare const ACCEPT_PER_HOUR = 30;
/** Refused deliveries for one automation in an hour that pause it (a storm), with a notice in its detail. */
export declare const STORM_REFUSALS = 50;
/** The instance's hooks gateway token, made the first time (0600; never the dashboard's or Siri's). */
export declare function hooksGatewayToken(stateDir: string, others: string[]): string;
/** The signature a delivery carries: `v1=` and the hex HMAC-SHA256 of `<timestamp>.<delivery>.<body>`. */
export declare function signature(secret: string, timestamp: string, delivery: string, body: Buffer | string): string;
export interface HookContext {
    stateDir: string;
    /** The instance's home (automations.yaml and the secrets folder). */
    home: string;
    automationsFile: string;
    eventsDb: string;
    gatewayToken: string;
    instance: string;
    now?: () => number;
}
/**
 * Check one delivery. `ok`: accepted (recorded by the caller). Else the status to answer (401 for every refusal of the
 * delivery itself, the same body each time; 413 too long; 429 over the hour's cap) and why (for the log, never sent).
 */
export declare function checkDelivery(o: {
    ctx: HookContext;
    id: string;
    body: Buffer;
    timestamp: string;
    delivery: string;
    sig: string;
    node: {
        id: string;
        name: string;
    };
}): {
    ok: true;
} | {
    ok: false;
    status: number;
    why: string;
    known: boolean;
};
/** Every /api/hooks/... request on an instance's dashboard, before and instead of its own auth. Always ends the request. */
export declare function handleHook(req: IncomingMessage, res: ServerResponse, url: URL, ctx: HookContext): Promise<void>;
