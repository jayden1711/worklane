type Fetch = typeof fetch;
/** An App JWT (RS256), valid for 9 minutes, backdated a minute for clock skew. */
export declare function appJwt(appId: number, privateKeyPem: string, now?: number): string;
export interface AppCredentials {
    appId: number;
    installationId: number;
    keyPath: string;
}
export interface InstallationToken {
    token: string;
    expiresAt: string;
}
/**
 * Mint an installation token limited to `repos` (owner/name; all must share the installation's owner). The request
 * gives up after `timeoutMs` (a TimeoutError), like every other GitHub call: a connection that never answers must not
 * hold a coordinator tick, or the watchdog's pass, forever.
 */
export declare function mintInstallationToken(c: AppCredentials, repos: string[], fetchImpl?: Fetch, api?: string, now?: number, timeoutMs?: number): Promise<InstallationToken>;
/**
 * A token source for one instance: reuses the cached token while it has more
 * than 10 minutes left, otherwise mints and caches a new one (0600, in the
 * instance's state, which only the coordinator user can read).
 */
export declare function installationTokens(c: AppCredentials, repos: string[], stateDir: string, fetchImpl?: Fetch, api?: string): (now?: number) => Promise<string>;
/**
 * The App's bot identity, as GitHub attributes commits to it:
 * "<slug>[bot]" <"<bot user id>+<slug>[bot]@users.noreply.github.com">.
 */
export declare function appBotIdentity(c: AppCredentials, fetchImpl?: Fetch, api?: string, timeoutMs?: number): Promise<{
    name: string;
    email: string;
}>;
export {};
