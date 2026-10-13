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
import type { IncomingMessage } from 'node:http';

export type Role = 'owner' | 'writer' | 'viewer';

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
/** The header the hub passes the person's sign-in time with (ms since the epoch), alongside LOGIN_HEADER. */
export const AUTH_AT_HEADER = 'x-dashboard-authenticated-at';

/**
 * Who is asking, in the shape the setup console (src/console/session.ts) reads: the login, the role on this
 * instance (read from the repo, never the client), when they last signed in with GitHub, and whether this write
 * carries the session's CSRF token. Structurally the same as that module's ConsoleSession and SessionOf.
 */
export interface ConsoleSession {
  login: string;
  role: Role | null;
  authenticatedAt: number | null;
  csrfOk: boolean;
}
export type SessionOf = (req: IncomingMessage, instance: string) => ConsoleSession | null;

/** The header every write carries its CSRF token in. */
export const CSRF_HEADER = 'x-csrf-token';
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
export const validLogin = (s: unknown): s is string => typeof s === 'string' && LOGIN.test(s);

/** The role a repo permission gives: admin owner, maintain/write writer, triage/read viewer; anything else none. */
export function roleFromPermission(p: unknown): Role | null {
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

export const isOwner = (r: Role | null | undefined) => r === 'owner';
/** The owner or a writer: who may read runs, throughput, reports, intake and the digest, and use the chat. */
export const isWriter = (r: Role | null | undefined) => r === 'owner' || r === 'writer';

/** Decisions only the owner may answer: held plans, and high-risk (L3) merges. The rest are the writers' too. */
export const OWNER_DECISIONS: ReadonlySet<string> = new Set(['plan', 'land']);
export const mayAnswerKind = (kind: string, r: Role | null | undefined) => (OWNER_DECISIONS.has(kind) ? isOwner(r) : isWriter(r));

/** `fresh`: ask GitHub now, not the cache (the hub's role check, so its own copy is never older than the cache allows). */
export type RoleOf = (login: string, o?: { fresh?: boolean }) => Promise<Role | null>;
type Fetch = typeof fetch;

/**
 * A person's permission on one repo, read with the instance's own installation token (never the person's):
 * GitHub's role_name when it gives one (maintain, triage), else its permission; 'none' when they aren't a collaborator.
 */
export function repoPermission(o: { repo: string; token: () => Promise<string>; api?: string; fetch?: Fetch }): (login: string) => Promise<string> {
  const api = (o.api ?? 'https://api.github.com').replace(/\/+$/, '');
  const f = o.fetch ?? fetch;
  return async (login) => {
    if (!validLogin(login)) return 'none';
    const res = await f(`${api}/repos/${o.repo}/collaborators/${encodeURIComponent(login)}/permission`, {
      headers: { authorization: `Bearer ${await o.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (res.status === 404) return 'none';
    if (!res.ok) throw new Error(`GitHub ${res.status} reading @${login}'s permission on ${o.repo}`);
    const j = (await res.json()) as { permission?: unknown; role_name?: unknown };
    return typeof j.role_name === 'string' && roleFromPermission(j.role_name) ? j.role_name : String(j.permission ?? 'none');
  };
}

/** Roles from a permission lookup, cached per login for at most `ttl`; an error refuses (and is retried after ROLE_ERROR_CACHE_MS). */
export function cachedRoles(permission: (login: string) => Promise<string>, now: () => number = Date.now, ttl = ROLE_CACHE_MS): RoleOf {
  const cache = new Map<string, { role: Role | null; until: number }>();
  return async (login, o = {}) => {
    if (!validLogin(login)) return null;
    const key = login.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() < hit.until && !o.fresh) return hit.role;
    let role: Role | null;
    let until: number;
    try {
      role = roleFromPermission(await permission(login));
      until = now() + Math.min(ttl, ROLE_CACHE_MS);
    } catch {
      role = null;
      until = now() + Math.min(ttl, ROLE_ERROR_CACHE_MS);
    }
    cache.set(key, { role, until });
    return role;
  };
}

/** Whether an address is this machine's loopback (127.0.0.0/8 or ::1, plain or IPv4-mapped). */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Whether a request came through a proxy (it carries one of PROXY_HEADERS). */
export const proxied = (req: Pick<IncomingMessage, 'headers'>) => PROXY_HEADERS.some((h) => req.headers[h] !== undefined);

/** Where the break-glass token may be used: from this machine's loopback, never through a proxy. */
export const breakGlassAllowed = (req: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string | undefined } }) => isLoopback(req.socket.remoteAddress) && !proxied(req);

/** The dashboard servers listen on loopback only (Tailscale serve forwards to it); anything else is refused. */
export function assertLoopbackHost(host: string): void {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error(`the dashboard listens on loopback only (127.0.0.1 or ::1), not ${host}: reach it through tailscale serve (docs/dashboard.md)`);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** The session cookie: HttpOnly, Secure, SameSite=Strict, the whole site, no Domain; it lasts at most a session's life. */
export const sessionCookie = (id: string) => `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`;
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export const stateCookie = (state: string) => `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SIGNIN_STATE_MS / 1000}`;
export const clearStateCookie = () => `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

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
export class Sessions {
  private readonly map = new Map<string, Session>();
  private saved = 0;
  constructor(private readonly o: { secret: string; file?: string; now?: () => number }) {
    if (o.secret.length < 32) throw new Error('the session secret must be at least 32 characters');
    if (o.file && existsSync(o.file)) {
      try {
        const raw = JSON.parse(readFileSync(o.file, 'utf8')) as Record<string, Session>;
        for (const [k, v] of Object.entries(raw)) if (validLogin(v?.login) && Number.isFinite(v.created) && Number.isFinite(v.lastSeen)) this.map.set(k, v);
      } catch {
        // an unreadable store signs everyone out
      }
    }
  }

  private now = () => (this.o.now ?? Date.now)();
  private key = (id: string) => createHmac('sha256', this.o.secret).update(`session:${id}`).digest('hex');
  private live = (s: Session, t: number) => t - s.lastSeen < SESSION_IDLE_MS && t - s.created < SESSION_MAX_MS;

  private save(force = false) {
    if (!this.o.file) return;
    const t = this.now();
    if (!force && t - this.saved < 60_000) return;
    this.saved = t;
    for (const [k, s] of this.map) if (!this.live(s, t)) this.map.delete(k);
    const tmp = `${this.o.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
    renameSync(tmp, this.o.file);
  }

  create(login: string): { id: string; csrf: string } {
    if (!validLogin(login)) throw new Error('not a GitHub login');
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    this.map.set(this.key(id), { login, created: t, lastSeen: t });
    this.save(true);
    return { id, csrf: this.csrf(id) };
  }

  /** The live session for an id, its idle clock restarted; null (and forgotten) once idle 12 h or 7 days old. */
  get(id: string | undefined): Session | null {
    if (!id) return null;
    const k = this.key(id);
    const s = this.map.get(k);
    if (!s) return null;
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
  delete(id: string | undefined): void {
    if (id && this.map.delete(this.key(id))) this.save(true);
  }

  csrf(id: string): string {
    return createHmac('sha256', this.o.secret).update(`csrf:${id}`).digest('base64url');
  }

  /** Whether `given` is this session's CSRF token (constant time). */
  csrfOk(id: string, given: unknown): boolean {
    return typeof given === 'string' && same(given, this.csrf(id));
  }
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

export const CALLBACK_PATH = '/auth/callback';
export const callbackUrl = (s: Pick<SignInConfig, 'publicUrl'>) => `${s.publicUrl.replace(/\/+$/, '')}${CALLBACK_PATH}`;

/** Where the browser goes to sign in: GitHub's authorize page for the sign-in App, back to our callback with `state`. */
export function authorizeUrl(s: SignInConfig, state: string): string {
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
export async function loginFromCode(s: SignInConfig, code: string): Promise<string> {
  const f = s.fetch ?? fetch;
  const web = (s.web ?? 'https://github.com').replace(/\/+$/, '');
  const api = (s.api ?? 'https://api.github.com').replace(/\/+$/, '');
  const ex = await f(`${web}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: s.clientId, client_secret: s.clientSecret, code, redirect_uri: callbackUrl(s) }),
  });
  const j = (await ex.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
  if (!ex.ok || typeof j.access_token !== 'string' || !j.access_token) throw new Error(`GitHub refused the sign-in code${typeof j.error === 'string' ? ` (${j.error})` : ''}`);
  const token = j.access_token;
  try {
    const u = await f(`${api}/user`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    if (!u.ok) throw new Error(`GitHub ${u.status} reading the signed-in user`);
    const { login } = (await u.json()) as { login?: unknown };
    if (!validLogin(login)) throw new Error('GitHub returned no login');
    return login;
  } finally {
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
  private readonly map = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  create(): string {
    const t = this.now();
    for (const [k, until] of this.map) if (until <= t) this.map.delete(k);
    if (this.map.size > 1000) this.map.clear();
    const s = randomBytes(24).toString('base64url');
    this.map.set(s, t + SIGNIN_STATE_MS);
    return s;
  }
  /** Whether `state` is pending and the browser's cookie names the same one; it is used up either way. */
  take(state: unknown, cookie: unknown): boolean {
    if (typeof state !== 'string' || !state) return false;
    const until = this.map.get(state);
    this.map.delete(state);
    return until !== undefined && until > this.now() && typeof cookie === 'string' && same(state, cookie);
  }
}
