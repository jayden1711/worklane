import type { IncomingMessage } from 'node:http';
export type Role = 'owner' | 'writer' | 'viewer';
/** How long a person's role on an instance is trusted before GitHub is asked again. */
export declare const ROLE_CACHE_MS: number;
/** A failed permission lookup is retried after this long (it refuses meanwhile). */
export declare const ROLE_ERROR_CACHE_MS = 30000;
/** A session ends after this long without a request... */
export declare const SESSION_IDLE_MS: number;
/** ...and this long after sign-in, whatever happens. */
export declare const SESSION_MAX_MS: number;
/** A sign-in must come back from GitHub within this long. */
export declare const SIGNIN_STATE_MS: number;
/** The header the hub names the signed-in person with when it forwards to an instance's own server (token-authenticated). */
export declare const LOGIN_HEADER = "x-dashboard-login";
/** On the hub's role check (/api/role): read the permission from GitHub now, not the instance's cache. */
export declare const FRESH_HEADER = "x-dashboard-fresh-role";
/**
 * Set (to 1) by the hub on a forwarded write when Tailscale identified the request's device as one of the console's
 * allowed devices (src/console/terminal-devices.ts); only the hub can tell, and it builds every forwarded header
 * itself, so a browser's own copy never reaches an instance. Machine changes need it (src/machine-owners.ts).
 */
export declare const DEVICE_HEADER = "x-dashboard-console-device";
/**
 * Who is asking, in the shape the setup console (src/console/session.ts) reads: the login, the role on this
 * instance (read from the repo, never the client), and whether this write
 * carries the session's CSRF token. Structurally the same as that module's ConsoleSession and SessionOf.
 */
export interface ConsoleSession {
    login: string;
    role: Role | null;
    csrfOk: boolean;
    /** The owner's break-glass (no person named). */
    breakGlass?: boolean;
    /** The hub identified this write's device as an allowed console device (DEVICE_HEADER). */
    deviceOk?: boolean;
}
export type SessionOf = (req: IncomingMessage, instance: string) => ConsoleSession | null;
/** The header every write carries its CSRF token in. */
export declare const CSRF_HEADER = "x-csrf-token";
/**
 * The owner terminal's WebSocket subprotocol. A browser can't set headers on a WebSocket upgrade, so the page offers
 * two subprotocols: this one and `csrf.<the session's CSRF token>`. The hub reads the token from the second and
 * answers with this one alone, never echoing the token.
 */
export declare const TERMINAL_PROTOCOL = "terminal.v1";
/** The prefix of the subprotocol that carries the CSRF token on the terminal's upgrade. */
export declare const CSRF_PROTOCOL_PREFIX = "csrf.";
/** The CSRF token a WebSocket upgrade offers as a subprotocol (`csrf.<token>`); undefined when it offers none. */
export declare function csrfFromProtocols(req: IncomingMessage): string | undefined;
/**
 * The instance API paths (after /api/) whose GET says whether a machine change would pass now, the device included.
 * The hub asks Tailscale for the device on these reads, as on every write, and the instance serves these views
 * under exactly these paths (src/dashboard.ts), so the two can't drift apart.
 */
export declare const DEVICE_VIEWS: {
    readonly addProject: "add-project";
    readonly machine: "machine";
    readonly claudeAccount: "claude-account";
    readonly tailscale: "tailscale";
};
export declare const isDeviceView: (path: string) => boolean;
/** The session cookie: __Host- binds it to this origin, Path=/, Secure, with no Domain. */
export declare const SESSION_COOKIE = "__Host-session";
/** The sign-in round trip's state cookie (Lax: it must come back on GitHub's redirect). */
export declare const STATE_COOKIE = "__Host-signin-state";
/**
 * Headers a reverse proxy adds (Tailscale serve adds Tailscale-User-* and X-Forwarded-*): a request carrying any
 * of them came through a proxy, so it isn't from this machine, whatever its socket's address says.
 */
export declare const PROXY_HEADERS: string[];
/** A GitHub login as GitHub allows them (letters, digits, dashes; at most 39). */
export declare const validLogin: (s: unknown) => s is string;
/** The role a repo permission gives: admin owner, maintain/write writer, triage/read viewer; anything else none. */
export declare function roleFromPermission(p: unknown): Role | null;
export declare const isOwner: (r: Role | null | undefined) => r is "owner";
/** The owner or a writer: who may read runs, throughput, reports, intake and the digest, and use the chat. */
export declare const isWriter: (r: Role | null | undefined) => r is "owner" | "writer";
/** Decisions only the owner may answer: held plans, and high-risk (L3) merges. The rest are the writers' too. */
export declare const OWNER_DECISIONS: ReadonlySet<string>;
export declare const mayAnswerKind: (kind: string, r: Role | null | undefined) => boolean;
/** `fresh`: ask GitHub now, not the cache (the hub's role check, so its own copy is never older than the cache allows). */
export type RoleOf = (login: string, o?: {
    fresh?: boolean;
}) => Promise<Role | null>;
type Fetch = typeof fetch;
/**
 * A person's permission on one repo, read with the instance's own installation token (never the person's):
 * GitHub's role_name when it gives one (maintain, triage), else its permission; 'none' when they aren't a collaborator.
 */
export declare function repoPermission(o: {
    repo: string;
    token: () => Promise<string>;
    api?: string;
    fetch?: Fetch;
}): (login: string) => Promise<string>;
/** Roles from a permission lookup, cached per login for at most `ttl`; an error refuses (and is retried after ROLE_ERROR_CACHE_MS). */
export declare function cachedRoles(permission: (login: string) => Promise<string>, now?: () => number, ttl?: number): RoleOf;
/** Whether an address is this machine's loopback (127.0.0.0/8 or ::1, plain or IPv4-mapped). */
export declare function isLoopback(addr: string | undefined): boolean;
/** Whether a request came through a proxy (it carries one of PROXY_HEADERS). */
export declare const proxied: (req: Pick<IncomingMessage, "headers">) => boolean;
/** Where the break-glass token may be used: from this machine's loopback, never through a proxy. */
export declare const breakGlassAllowed: (req: Pick<IncomingMessage, "headers"> & {
    socket: {
        remoteAddress?: string | undefined;
    };
}) => boolean;
/** The dashboard servers listen on loopback only (Tailscale serve forwards to it); anything else is refused. */
export declare function assertLoopbackHost(host: string): void;
export declare function parseCookies(header: string | undefined): Record<string, string>;
/** The session cookie: HttpOnly, Secure, SameSite=Strict, the whole site, no Domain; it lasts at most a session's life. */
export declare const sessionCookie: (id: string) => string;
export declare const clearSessionCookie: () => string;
export declare const stateCookie: (state: string) => string;
export declare const clearStateCookie: () => string;
export interface Session {
    login: string;
    created: number;
    lastSeen: number;
}
/**
 * Sessions, server-side. A session id is 256 random bits, given to the browser only in the cookie; what's kept is
 * its HMAC under the session secret, so the store (a 0600 file in the hub's own state) holds no usable id. The CSRF
 * token is derived from the id under the same secret: tied to that session, useless with any other.
 */
export declare class Sessions {
    private readonly o;
    private readonly map;
    private saved;
    constructor(o: {
        secret: string;
        file?: string;
        now?: () => number;
    });
    private now;
    private key;
    private live;
    private save;
    create(login: string): {
        id: string;
        csrf: string;
    };
    /** The live session for an id, its idle clock restarted; null (and forgotten) once idle 12 h or 7 days old. */
    get(id: string | undefined): Session | null;
    /** Sign-out: the session is gone server-side, whatever the browser keeps. */
    delete(id: string | undefined): void;
    csrf(id: string): string;
    /** Whether `given` is this session's CSRF token (constant time). */
    csrfOk(id: string, given: unknown): boolean;
}
export interface SignInConfig {
    /** The sign-in GitHub App's client id (not secret). */
    clientId: string;
    clientSecret: string;
    sessionSecret: string;
    /** The hub's public URL as browsers reach it (the MagicDNS https URL); the callback is <publicUrl>/auth/callback. */
    publicUrl: string;
    /** GitHub's web and API bases (a fake GitHub in tests). */
    web?: string;
    api?: string;
    fetch?: Fetch;
}
export declare const CALLBACK_PATH = "/auth/callback";
export declare const callbackUrl: (s: Pick<SignInConfig, "publicUrl">) => string;
/** Where the browser goes to sign in: GitHub's authorize page for the sign-in App, back to our callback with `state`. */
export declare function authorizeUrl(s: SignInConfig, state: string): string;
/**
 * The GitHub login behind a sign-in code: the code exchanged for a user token, the token used for GET /user only,
 * then revoked (best effort). The token is never stored or logged.
 */
export declare function loginFromCode(s: SignInConfig, code: string): Promise<string>;
/** Pending sign-ins: each state is random, used once, and expires after SIGNIN_STATE_MS. */
export declare class SignInStates {
    private readonly now;
    private readonly map;
    constructor(now?: () => number);
    create(): string;
    /** Whether `state` is pending and the browser's cookie names the same one; it is used up either way. */
    take(state: unknown, cookie: unknown): boolean;
}
export {};
