export type TokenKind = 'app-installation' | 'fine-grained' | 'personal' | 'unknown';
/** GitHub's token prefixes: ghs_ App installation, github_pat_ fine-grained, gho_/ghp_/ghu_ personal (OAuth, classic, App user). */
export declare function tokenKind(token: string): TokenKind;
type Fetch = typeof fetch;
/** GitHub sends a token's expiry with every response (`GitHub-Authentication-Token-Expiration`, e.g. "2026-11-07 00:00:00 UTC"). */
export declare function parseExpiry(header: string | null): string | null;
/**
 * Check that a token sees exactly the instance's repos: all of them, and no
 * others. Refusals name the problem and counts, never other repos' names.
 */
export declare function checkRepoScope(token: string, allowed: string[], fetchImpl?: Fetch, api?: string): Promise<{
    ok: true;
    kind: TokenKind;
    expiresAt: string | null;
    login: string | null;
} | {
    ok: false;
    why: string;
}>;
/** Days until a token expires (rounded down), or null if it has no expiry. */
export declare const daysLeft: (expiresAt: string | null, now?: Date) => number | null;
export {};
