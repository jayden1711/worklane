import type { IncomingMessage } from 'node:http';
/** The break-glass port (#197's HUB_BREAK_GLASS_PORT): the terminal is never served there. */
export declare const BREAK_GLASS_PORT = 4398;
/** tailscaled's uid: it runs as root. */
export declare const TAILSCALED_UID = 0;
export interface Device {
    /** The node's MagicDNS name, without the trailing dot (<node>.<tailnet>.ts.net). */
    name: string;
    tags: string[];
    /** Its Tailscale address. */
    ip: string;
    /** Tailscale's stable node id (whois Node.StableID), when Tailscale gives one: a Siri token binds to it. */
    stableId?: string;
}
export type DeviceCheck = {
    ok: true;
    device: Device;
} | {
    ok: false;
    why: string;
};
export interface DeviceOptions {
    /** Allowed tags (tag:x) and node names (short or full MagicDNS name). Empty: nothing is allowed. */
    allow: string[];
    /** Look a Tailscale address up (tailscale whois --json); throws when it can't. */
    whois?: (ip: string) => string;
    /** The uid that opened this loopback connection; null when unknown. */
    peerUid?: (clientPort: number, serverPort: number) => number | null;
    breakGlassPort?: number;
}
/** A Tailscale address: 100.64/10 (CGNAT), or fd7a:115c:a1e0::/48. */
export declare function isTailscaleIp(ip: string): boolean;
/** The allowlist as the hub takes it: `tag:a,laptop,<node>.<tailnet>.ts.net`; anything not a tag or a DNS name is dropped. */
export declare function parseDeviceList(raw: string | null | undefined): string[];
/** Whether a device is on the list: one of its tags, or its name (the full MagicDNS name or its first label). */
export declare function deviceAllowed(d: Pick<Device, 'name' | 'tags'>, allow: string[]): boolean;
/** The device behind a request, from Tailscale: only for a connection tailscaled made, never from what a client says. */
export declare function identifyDevice(req: IncomingMessage, o: DeviceOptions): DeviceCheck;
/** Why this request's device may not open the terminal; null when it may. Fails closed. */
export declare function deviceRefusal(req: IncomingMessage, o: DeviceOptions): {
    why: string | null;
    device: Device | null;
};
