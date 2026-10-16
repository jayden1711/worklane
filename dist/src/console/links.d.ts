import type { EventLog } from '../events/log.js';
/** How long a link works. */
export declare const LINK_TTL_MS: number;
/** A link token as minted: 32 bytes, base64url. */
export declare const LINK_TOKEN: RegExp;
/** Mint a link for `login` to open ask `ask`: the token (for the DM only; never recorded) and when it expires. */
export declare function issueSetupLink(log: EventLog, o: {
    ask: string;
    login: string;
    now?: number;
}): {
    token: string;
    expiresAt: string;
};
export type LinkResult = {
    ok: true;
    ask: string;
} | {
    ok: false;
    status: 400 | 403 | 404 | 409 | 410;
    error: string;
};
/**
 * Exchange a link on the dashboard, by `who` (their session's login and role here). Once only, in one write
 * transaction: of two exchanges at once, one wins. Any presentation of a known link uses it up, refused or not.
 * Errors never quote the token.
 */
export declare function useSetupLink(log: EventLog, o: {
    token: string;
    login: string;
    role: string | null;
    now?: number;
}): LinkResult;
