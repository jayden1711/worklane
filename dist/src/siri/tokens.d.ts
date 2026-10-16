/** A token unused this long is refused (and shown as expired): there is no fixed lifetime. */
export declare const IDLE_EXPIRY_MS: number;
/** The most devices one instance keeps (revoked ones included, until removed). */
export declare const MAX_DEVICES = 20;
/** A device's name: what the owner calls the phone. */
export declare const DEVICE_NAME: RegExp;
/** The prefix every token starts with (a scanner can find one pasted where it shouldn't be). */
export declare const TOKEN_PREFIX: string;
/** A whole token: its instance, its id and its secret. */
export declare const TOKEN: RegExp;
export declare const DEVICE_ID: RegExp;
/** The Tailscale device a request came from, as the hub's gateway identified it (src/console/terminal-devices.ts). */
export interface SiriNode {
    /** Tailscale's stable node id: what a token binds to (a node can be renamed; this can't). */
    id: string;
    /** Its MagicDNS name. */
    name: string;
}
export interface DeviceRecord {
    id: string;
    name: string;
    /** sha256 of the secret, hex. */
    hash: string;
    created: string;
    createdBy: string;
    /** The first node that used it; every later use must come from the same one. */
    boundNode: SiriNode | null;
    lastUsed: string | null;
    lastNode: string | null;
    /** The last refusal because the request came from another node: when, and from which. */
    lastForeign: {
        at: string;
        node: string;
    } | null;
    revokedAt: string | null;
    revokedBy: string | null;
}
/** What the dashboard shows of a device: never the hash. */
export interface DeviceView {
    id: string;
    name: string;
    created: string;
    createdBy: string;
    boundNode: string | null;
    lastUsed: string | null;
    lastNode: string | null;
    lastForeign: {
        at: string;
        node: string;
    } | null;
    state: 'active' | 'revoked' | 'expired';
    revokedAt: string | null;
}
export declare class SiriTokenError extends Error {
}
/** The instance's devices (an unreadable or malformed store is no devices: every token is refused). */
export declare function readDevices(stateDir: string): DeviceRecord[];
export declare function viewOf(d: DeviceRecord, now?: number): DeviceView;
export declare const listDevices: (stateDir: string, now?: number) => DeviceView[];
/** A new device's token: returned here once, never stored or shown again (only its hash is kept). */
export declare function createDevice(o: {
    stateDir: string;
    instance: string;
    name: string;
    by: string;
    now?: Date;
}): {
    token: string;
    device: DeviceView;
};
/** Revoke: refused from the next request on. Kept on the list (as revoked) for the record. */
export declare const revokeDevice: (stateDir: string, id: string, by: string, now?: Date) => DeviceView;
/** Revoke every device still active (an instance removed or renamed): none works from the next request on. Returns their ids. */
export declare function revokeAllDevices(stateDir: string, by: string, now?: Date): string[];
/** Unbind: the next use binds it again (to whichever node makes it). */
export declare const unbindDevice: (stateDir: string, id: string) => DeviceView;
export type Verdict = {
    ok: true;
    device: DeviceRecord;
    bound: boolean;
} | {
    ok: false;
    why: string;
    device: DeviceRecord | null;
};
/**
 * Check a token for this instance, from this node. On success the device's last use (and, the first time, its node)
 * is recorded; a use from another node than the bound one is recorded as foreign and refused.
 */
export declare function verifyToken(o: {
    stateDir: string;
    instance: string;
    token: string;
    node: SiriNode;
    now?: Date;
}): Verdict;
/** Per-device limits, in the instance's dashboard process (a restart starts them afresh). */
export declare const LIMITS: {
    readonly tell: {
        readonly n: 20;
        readonly ms: 3600000;
    };
    readonly ask: {
        readonly n: 10;
        readonly ms: 3600000;
    };
};
export declare class RateLimits {
    private readonly now;
    private readonly seen;
    constructor(now?: () => number);
    /** Count one use of `kind` by device `id`; false (and not counted) when over its limit. */
    take(id: string, kind: keyof typeof LIMITS): boolean;
}
