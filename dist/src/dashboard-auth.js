// Who is asking the dashboard, and what they may do there.
//
// People sign in to the hub with GitHub (a GitHub App used only for user
// authorization, with no repository permissions). Their token is used once,
// to learn their login, and then revoked; it is never stored. Each instance's
// own dashboard server decides the person's role on every request, from their
// permission on that instance's repo, read with the instance's own
// installation token and cached at most 5 minutes:
//   admin -> owner; maintain or write -> writer; triage or read -> viewer;
//   none, or any error -> no access (fail closed).
// The role is never taken from the client.
//
// The per-install token is kept only as the owner's break-glass: accepted on a
// loopback-only port that the Tailscale proxy never forwards, and refused on
// any request that carries a proxy's headers.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
/** How long a person's role on an instance is trusted before GitHub is asked again. */
export const ROLE_CACHE_MS = 5 * 60_000;
/** A failed permission lookup is retried after this long (it refuses meanwhile). */
export const ROLE_ERROR_CACHE_MS = 30_000;
/** A session ends after this long without a request... */
export const SESSION_IDLE_MS = 12 * 3_600_000;
/** ...and this long after sign-in, whatever happens. */
export const SESSION_MAX_MS = 7 * 24 * 3_600_000;
/** A sign-in must come back from GitHub within this long. */
export const SIGNIN_STATE_MS = 10 * 60_000;
/** The header the hub names the signed-in person with when it forwards to an instance's own server (token-authenticated). */
export const LOGIN_HEADER = 'x-dashboard-login';
/** On the hub's role check (/api/role): read the permission from GitHub now, not the instance's cache. */
export const FRESH_HEADER = 'x-dashboard-fresh-role';
/**
 * Set (to 1) by the hub on a forwarded write when Tailscale identified the request's device as one of the console's
 * allowed devices (src/console/terminal-devices.ts); only the hub can tell, and it builds every forwarded header
 * itself, so a browser's own copy never reaches an instance. Machine changes need it (src/machine-owners.ts).
 */
export const DEVICE_HEADER = 'x-dashboard-console-device';
/** The header every write carries its CSRF token in. */
export const CSRF_HEADER = 'x-csrf-token';
/**
 * The owner terminal's WebSocket subprotocol. A browser can't set headers on a WebSocket upgrade, so the page offers
 * two subprotocols: this one and `csrf.<the session's CSRF token>`. The hub reads the token from the second and
 * answers with this one alone, never echoing the token.
 */
export const TERMINAL_PROTOCOL = 'terminal.v1';
/** The prefix of the subprotocol that carries the CSRF token on the terminal's upgrade. */
export const CSRF_PROTOCOL_PREFIX = 'csrf.';
/** The CSRF token a WebSocket upgrade offers as a subprotocol (`csrf.<token>`); undefined when it offers none. */
export function csrfFromProtocols(req) {
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const p = offered.find((x) => x.startsWith(CSRF_PROTOCOL_PREFIX));
    return p ? p.slice(CSRF_PROTOCOL_PREFIX.length) : undefined;
}
/**
 * The instance API paths (after /api/) whose GET says whether a machine change would pass now, the device included.
 * The hub asks Tailscale for the device on these reads, as on every write, and the instance serves these views
 * under exactly these paths (src/dashboard.ts), so the two can't drift apart.
 */
export const DEVICE_VIEWS = { addProject: 'add-project', machine: 'machine', claudeAccount: 'claude-account', tailscale: 'tailscale' };
export const isDeviceView = (path) => Object.values(DEVICE_VIEWS).includes(path);
/** The session cookie: __Host- binds it to this origin, Path=/, Secure, with no Domain. */
export const SESSION_COOKIE = '__Host-session';
/** The sign-in round trip's state cookie (Lax: it must come back on GitHub's redirect). */
export const STATE_COOKIE = '__Host-signin-state';
/**
 * Headers a reverse proxy adds (Tailscale serve adds Tailscale-User-* and X-Forwarded-*): a request carrying any
 * of them came through a proxy, so it isn't from this machine, whatever its socket's address says.
 */
export const PROXY_HEADERS = ['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'tailscale-headers-info', 'tailscale-app-capabilities', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip', 'forwarded', 'via'];
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A GitHub login as GitHub allows them (letters, digits, dashes; at most 39). */
export const validLogin = (s) => typeof s === 'string' && LOGIN.test(s);
/** The role a repo permission gives: admin owner, maintain/write writer, triage/read viewer; anything else none. */
export function roleFromPermission(p) {
    switch (p) {
        case 'admin':
            return 'owner';
        case 'maintain':
        case 'write':
            return 'writer';
        case 'triage':
        case 'read':
            return 'viewer';
        default:
            return null;
    }
}
export const isOwner = (r) => r === 'owner';
/** The owner or a writer: who may read runs, throughput, reports, intake and the digest, and use the chat. */
export const isWriter = (r) => r === 'owner' || r === 'writer';
/** Decisions only the owner may answer: held plans, and high-risk (L3) merges. The rest are the writers' too. */
export const OWNER_DECISIONS = new Set(['plan', 'land']);
export const mayAnswerKind = (kind, r) => (OWNER_DECISIONS.has(kind) ? isOwner(r) : isWriter(r));
/**
 * A person's permission on one repo, read with the instance's own installation token (never the person's):
 * GitHub's role_name when it gives one (maintain, triage), else its permission; 'none' when they aren't a collaborator.
 */
export function repoPermission(o) {
    const api = (o.api ?? 'https://api.github.com').replace(/\/+$/, '');
    const f = o.fetch ?? fetch;
    return async (login) => {
        if (!validLogin(login))
            return 'none';
        const res = await f(`${api}/repos/${o.repo}/collaborators/${encodeURIComponent(login)}/permission`, {
            headers: { authorization: `Bearer ${await o.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
        if (res.status === 404)
            return 'none';
        if (!res.ok)
            throw new Error(`GitHub ${res.status} reading @${login}'s permission on ${o.repo}`);
        const j = (await res.json());
        return typeof j.role_name === 'string' && roleFromPermission(j.role_name) ? j.role_name : String(j.permission ?? 'none');
    };
}
/** Roles from a permission lookup, cached per login for at most `ttl`; an error refuses (and is retried after ROLE_ERROR_CACHE_MS). */
export function cachedRoles(permission, now = Date.now, ttl = ROLE_CACHE_MS) {
    const cache = new Map();
    return async (login, o = {}) => {
        if (!validLogin(login))
            return null;
        const key = login.toLowerCase();
        const hit = cache.get(key);
        if (hit && now() < hit.until && !o.fresh)
            return hit.role;
        let role;
        let until;
        try {
            role = roleFromPermission(await permission(login));
            until = now() + Math.min(ttl, ROLE_CACHE_MS);
        }
        catch {
            role = null;
            until = now() + Math.min(ttl, ROLE_ERROR_CACHE_MS);
        }
        cache.set(key, { role, until });
        return role;
    };
}
/** Whether an address is this machine's loopback (127.0.0.0/8 or ::1, plain or IPv4-mapped). */
export function isLoopback(addr) {
    if (!addr)
        return false;
    const a = addr.replace(/^::ffff:/i, '');
    return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
/** Whether a request came through a proxy (it carries one of PROXY_HEADERS). */
export const proxied = (req) => PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
/** Where the break-glass token may be used: from this machine's loopback, never through a proxy. */
export const breakGlassAllowed = (req) => isLoopback(req.socket.remoteAddress) && !proxied(req);
/** The dashboard servers listen on loopback only (Tailscale serve forwards to it); anything else is refused. */
export function assertLoopbackHost(host) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host))
        throw new Error(`the dashboard listens on loopback only (127.0.0.1 or ::1), not ${host}: reach it through tailscale serve (docs/dashboard.md)`);
}
export function parseCookies(header) {
    const out = {};
    for (const part of (header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i < 1)
            continue;
        const k = part.slice(0, i).trim();
        if (!(k in out))
            out[k] = part.slice(i + 1).trim();
    }
    return out;
}
/** The session cookie: HttpOnly, Secure, SameSite=Strict, the whole site, no Domain; it lasts at most a session's life. */
export const sessionCookie = (id) => `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`;
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export const stateCookie = (state) => `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SIGNIN_STATE_MS / 1000}`;
export const clearStateCookie = () => `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
const same = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};
/**
 * Sessions, server-side. A session id is 256 random bits, given to the browser only in the cookie; what's kept is
 * its HMAC under the session secret, so the store (a 0600 file in the hub's own state) holds no usable id. The CSRF
 * token is derived from the id under the same secret: tied to that session, useless with any other.
 */
export class Sessions {
    o;
    map = new Map();
    saved = 0;
    constructor(o) {
        this.o = o;
        if (o.secret.length < 32)
            throw new Error('the session secret must be at least 32 characters');
        if (o.file && existsSync(o.file)) {
            try {
                const raw = JSON.parse(readFileSync(o.file, 'utf8'));
                for (const [k, v] of Object.entries(raw))
                    if (validLogin(v?.login) && Number.isFinite(v.created) && Number.isFinite(v.lastSeen))
                        this.map.set(k, v);
            }
            catch {
                // an unreadable store signs everyone out
            }
        }
    }
    now = () => (this.o.now ?? Date.now)();
    key = (id) => createHmac('sha256', this.o.secret).update(`session:${id}`).digest('hex');
    live = (s, t) => t - s.lastSeen < SESSION_IDLE_MS && t - s.created < SESSION_MAX_MS;
    save(force = false) {
        if (!this.o.file)
            return;
        const t = this.now();
        if (!force && t - this.saved < 60_000)
            return;
        this.saved = t;
        for (const [k, s] of this.map)
            if (!this.live(s, t))
                this.map.delete(k);
        const tmp = `${this.o.file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
        renameSync(tmp, this.o.file);
    }
    create(login) {
        if (!validLogin(login))
            throw new Error('not a GitHub login');
        const id = randomBytes(32).toString('base64url');
        const t = this.now();
        this.map.set(this.key(id), { login, created: t, lastSeen: t });
        this.save(true);
        return { id, csrf: this.csrf(id) };
    }
    /** The live session for an id, its idle clock restarted; null (and forgotten) once idle 12 h or 7 days old. */
    get(id) {
        if (!id)
            return null;
        const k = this.key(id);
        const s = this.map.get(k);
        if (!s)
            return null;
        const t = this.now();
        if (!this.live(s, t)) {
            this.map.delete(k);
            this.save(true);
            return null;
        }
        s.lastSeen = t;
        this.save();
        return s;
    }
    /** Sign-out: the session is gone server-side, whatever the browser keeps. */
    delete(id) {
        if (id && this.map.delete(this.key(id)))
            this.save(true);
    }
    csrf(id) {
        return createHmac('sha256', this.o.secret).update(`csrf:${id}`).digest('base64url');
    }
    /** Whether `given` is this session's CSRF token (constant time). */
    csrfOk(id, given) {
        return typeof given === 'string' && same(given, this.csrf(id));
    }
}
export const CALLBACK_PATH = '/auth/callback';
export const callbackUrl = (s) => `${s.publicUrl.replace(/\/+$/, '')}${CALLBACK_PATH}`;
/** Where the browser goes to sign in: GitHub's authorize page for the sign-in App, back to our callback with `state`. */
export function authorizeUrl(s, state) {
    const u = new URL(`${(s.web ?? 'https://github.com').replace(/\/+$/, '')}/login/oauth/authorize`);
    u.searchParams.set('client_id', s.clientId);
    u.searchParams.set('redirect_uri', callbackUrl(s));
    u.searchParams.set('state', state);
    u.searchParams.set('allow_signup', 'false');
    return u.toString();
}
/**
 * The GitHub login behind a sign-in code: the code exchanged for a user token, the token used for GET /user only,
 * then revoked (best effort). The token is never stored or logged.
 */
export async function loginFromCode(s, code) {
    const f = s.fetch ?? fetch;
    const web = (s.web ?? 'https://github.com').replace(/\/+$/, '');
    const api = (s.api ?? 'https://api.github.com').replace(/\/+$/, '');
    const ex = await f(`${web}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: s.clientId, client_secret: s.clientSecret, code, redirect_uri: callbackUrl(s) }),
    });
    const j = (await ex.json().catch(() => ({})));
    if (!ex.ok || typeof j.access_token !== 'string' || !j.access_token)
        throw new Error(`GitHub refused the sign-in code${typeof j.error === 'string' ? ` (${j.error})` : ''}`);
    const token = j.access_token;
    try {
        const u = await f(`${api}/user`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
        if (!u.ok)
            throw new Error(`GitHub ${u.status} reading the signed-in user`);
        const { login } = (await u.json());
        if (!validLogin(login))
            throw new Error('GitHub returned no login');
        return login;
    }
    finally {
        // The person's token has done its one job: revoke it.
        await f(`${api}/applications/${encodeURIComponent(s.clientId)}/token`, {
            method: 'DELETE',
            headers: { authorization: `Basic ${Buffer.from(`${s.clientId}:${s.clientSecret}`).toString('base64')}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
            body: JSON.stringify({ access_token: token }),
        }).catch(() => undefined);
    }
}
/** Pending sign-ins: each state is random, used once, and expires after SIGNIN_STATE_MS. */
export class SignInStates {
    now;
    map = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    create() {
        const t = this.now();
        for (const [k, until] of this.map)
            if (until <= t)
                this.map.delete(k);
        if (this.map.size > 1000)
            this.map.clear();
        const s = randomBytes(24).toString('base64url');
        this.map.set(s, t + SIGNIN_STATE_MS);
        return s;
    }
    /** Whether `state` is pending and the browser's cookie names the same one; it is used up either way. */
    take(state, cookie) {
        if (typeof state !== 'string' || !state)
            return false;
        const until = this.map.get(state);
        this.map.delete(state);
        return until !== undefined && until > this.now() && typeof cookie === 'string' && same(state, cookie);
    }
}
//# sourceMappingURL=dashboard-auth.js.map