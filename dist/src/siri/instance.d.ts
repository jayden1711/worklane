import type { IncomingMessage, ServerResponse } from 'node:http';
import { RateLimits, type DeviceRecord, type SiriNode } from './tokens.js';
/** The gateway's token file, beside the dashboard token in the instance's state. */
export declare const SIRI_GATEWAY_TOKEN_FILE = "siri-gateway-token";
/** The device token, as the gateway passes it on (the phone sends it as its bearer token). */
export declare const SIRI_DEVICE_HEADER = "x-siri-device-token";
/** The Tailscale node the gateway identified: JSON { id, name }. */
export declare const SIRI_NODE_HEADER = "x-siri-node";
/** The instance routes the gateway calls, and nothing else. */
export declare const SIRI_ROUTES: {
    readonly tell: "/api/siri/tell";
    readonly ask: "/api/siri/ask";
};
/** How long one request waits for an answer before saying it is still thinking. */
export declare const SIRI_WAIT_MS = 8000;
/** What a pending answer says: the last thing heard if the answer never came in time. */
export declare const STILL_THINKING = "That's taking too long. Try again in a minute.";
/** The instance's Siri gateway token, made the first time (0600, like the dashboard token, and never the same). */
export declare function siriGatewayToken(stateDir: string, dashboardToken: string): string;
/** A Siri request: a device and its node. Not a `Who`: no login, no role, nothing the dashboard's routes accept. */
export interface SiriCaller {
    readonly kind: 'siri';
    readonly device: DeviceRecord;
    readonly node: SiriNode;
}
export interface SiriContext {
    stateDir: string;
    /** The instance's name (server mode); null: a checkout's own dashboard, which has no Siri. */
    instance: string | null;
    intakeFile?: string;
    eventsDb: string;
    gatewayToken: string;
    limits: RateLimits;
    waitMs?: number;
    now?: () => Date;
}
/** Every answer: JSON with `speech` (what the phone says), `done`, and an `id` while an answer is pending. */
export declare function speak(res: ServerResponse, status: number, speech: string, extra?: {
    done?: boolean;
    id?: string;
}): void;
/**
 * Every /api/siri/... request on an instance's dashboard, before and instead of the dashboard's own auth. Ends the
 * request whatever happens.
 */
export declare function handleSiri(req: IncomingMessage, res: ServerResponse, url: URL, ctx: SiriContext): Promise<void>;
