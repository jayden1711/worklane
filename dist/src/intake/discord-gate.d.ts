/** The least time between two identifies on one token (Discord: one per 5 s per bucket; every session here is shard 0). */
export declare const IDENTIFY_SPACING_MS = 5000;
export declare const GATE_LOCK = "discord-identify.lock";
export declare const GATE_STATE = "discord-identify.json";
/** GET /gateway/bot's session_start_limit. */
export interface SessionStartLimit {
    total?: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
}
export type GateResult = {
    ok: true;
} | {
    ok: false;
    retryInMs: number;
    why: string;
};
export interface IdentifyGateOptions {
    /** The machine-wide directory (the agent slot directory: every instance's coordinator can write it). */
    dir: string;
    /** The bot token; only a hash of it keys the gate's state. */
    token: string;
    /** Who holds the lock, as the lock file says. */
    owner: string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** The token's session_start_limit (GET /gateway/bot), or null when unknown (a failed call: the 5 s spacing still holds). */
    limit?: () => Promise<SessionStartLimit | null>;
}
/** The key a token's state is kept under: a short hash, never the token. */
export declare const tokenKey: (token: string) => string;
/**
 * The gate one adapter calls before each identify: resolves once this identify may go (`ok`), or says when to try
 * again (the daily session starts are used up, or the lock could not be had).
 */
export declare function identifyGate(o: IdentifyGateOptions): () => Promise<GateResult>;
/** session_start_limit from GET /gateway/bot, with the bot's token; null on any failure. */
export declare function sessionStartLimit(token: string, f?: typeof fetch, api?: string): Promise<SessionStartLimit | null>;
