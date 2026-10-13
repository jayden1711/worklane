// One dashboard over several instances on this machine. Each instance runs
// its own dashboard server, as its own coordinator user: the only process
// that reads its log and records answers in it. The hub, run as a separate
// viewer user, holds no log of its own and opens none: it reads each
// instance's dashboard token (granted read-only by the machine setup) and
// forwards the UI's API calls, answers included, to the selected instance's
// own server, which applies its own checks. So no instance, and not the hub,
// can write another instance's log.
//
// People sign in to the hub with GitHub (dashboard-auth.ts). The hub keeps
// their session (an HttpOnly, Secure, SameSite=Strict cookie; a CSRF token on
// every write; 12 h idle, 7 days at most; signed out server-side) and names
// them to the instance on each call. The instance, not the hub, reads their
// role from its repo, so the hub lists, and forwards to, only the instances
// where they have one.
//
// Two listeners, both on loopback only:
//   - the hub's port (4399): sign-in only. This is the one `tailscale serve`
//     forwards, so every request on it arrives from 127.0.0.1: the token is
//     never accepted here, from anyone.
//   - the break-glass port (4398): the token only, for the owner on this
//     machine (or through an ssh tunnel to it). Tailscale never forwards it,
//     and a request carrying a proxy's headers is refused there anyway.
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_WEB_DIR, dashboardToken, json, serveStatic, tokenGiven } from './dashboard.js';
import { assertLoopbackHost, AUTH_AT_HEADER, authorizeUrl, breakGlassAllowed, clearSessionCookie, clearStateCookie, CSRF_HEADER, DEVICE_HEADER, FRESH_HEADER, LOGIN_HEADER, loginFromCode, parseCookies, ROLE_CACHE_MS, SESSION_COOKIE, sessionCookie, Sessions, SignInStates, STATE_COOKIE, stateCookie, type Role, type SessionOf, type SignInConfig } from './dashboard-auth.js';
import { attachTerminal } from './console/terminal-server.js';
import { deviceRefusal, type DeviceOptions } from './console/terminal-devices.js';
import { fileAudit, type AuditSink, type Exec, type SpawnPty } from './console/terminal.js';
import { currentUser } from './os/index.js';

export interface HubInstance {
  name: string;
  /** The instance's own dashboard server, on loopback. */
  port: number;
  /** The instance's dashboard-token file. */
  tokenFile: string;
}

export interface HubOptions {
  instances: HubInstance[];
  /** The hub's own state (its token, its sessions), in the viewer user's home. */
  stateDir: string;
  /** The sign-in port (the one tailscale serve forwards). */
  port?: number;
  /** The break-glass port (loopback only; never forwarded). */
  breakGlassPort?: number;
  /** Loopback only; anything else is refused. */
  host?: string;
  webDir?: string;
  /** Sign-in with GitHub; without it, the hub's port refuses every API call and only the break-glass works. */
  signIn?: SignInConfig | null;
  /**
   * The owner terminal (the setup console) reads who is asking on the hub's port through a SessionOf: the hub's
   * own (`session` on what startHub returns) unless one is given here; it runs as consoleUser (console_user; none: it
   * never opens). The rest is for tests.
   */
  /**
   * devices: the Tailscale tags and node names the terminal may be opened from (console_devices; none: it never
   * opens); whois and peerUid identify the device (src/console/terminal-devices.ts) and are injected in tests.
   */
  terminal?: { consoleUser?: string | null; devices?: string[]; whois?: (ip: string) => string; peerUid?: (clientPort: number, serverPort: number) => number | null; session?: SessionOf; audit?: AuditSink; spawnPty?: SpawnPty; exec?: Exec; now?: () => number; idleMs?: number; hubUser?: string };
  now?: () => number;
}

/** The hub's port: next to the instances' range (4400-4899). */
export const HUB_PORT = 4399;
/** The break-glass port: the token, on this machine only. */
export const HUB_BREAK_GLASS_PORT = 4398;
const NAME = /^[a-z][a-z0-9-]{0,40}$/;

/** `a=/state/a,b=/state/b`: each instance's name and state dir (its token file is there). */
export function parseHubArg(arg: string, port: (name: string) => number): HubInstance[] {
  const out: HubInstance[] = [];
  for (const part of arg.split(',').filter(Boolean)) {
    const i = part.indexOf('=');
    const name = part.slice(0, i);
    const dir = part.slice(i + 1);
    if (i < 1 || !NAME.test(name) || !dir) throw new Error(`--hub takes name=<state dir>[,name=<state dir>...]; got "${part}"`);
    if (out.some((x) => x.name === name)) throw new Error(`--hub names ${name} twice`);
    out.push({ name, port: port(name), tokenFile: `${dir.replace(/[\\/]+$/, '')}/dashboard-token` });
  }
  if (!out.length) throw new Error('--hub needs at least one instance');
  return out;
}

/**
 * The sign-in settings from the files `credentials.sh dashboard-signin` installs (client-secret and session-secret,
 * 0400, the viewer's), the App's client id and the hub's public URL (https, as browsers reach it).
 */
export function signInFromFiles(o: { clientId: string; publicUrl: string; dir: string }): SignInConfig {
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(o.clientId)) throw new Error('--client-id: the sign-in App\'s client id (letters, digits, dots, dashes)');
  let u: URL;
  try {
    u = new URL(o.publicUrl);
  } catch {
    throw new Error(`--public-url: not a URL: ${o.publicUrl}`);
  }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash) throw new Error(`--public-url: the hub's https origin as browsers reach it (https://<machine>.<tailnet>.ts.net), not ${o.publicUrl}`);
  const read = (f: string) => {
    try {
      return readFileSync(join(o.dir, f), 'utf8').trim();
    } catch {
      throw new Error(`can't read ${join(o.dir, f)}: install it with credentials.sh dashboard-signin`);
    }
  };
  return { clientId: o.clientId, clientSecret: read('client-secret'), sessionSecret: read('session-secret'), publicUrl: u.origin };
}

const readToken = (i: HubInstance): string | null => {
  try {
    return readFileSync(i.tokenFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

/**
 * Forward one API call to an instance's own server with its token; the instance's token never reaches the browser.
 * `login`: the signed-in person, named to the instance, which reads their role itself; null for the break-glass.
 * Only the headers the instance needs go upstream, built here: never a cookie, a CSRF token or a client's own login header.
 * `deviceOk`: Tailscale identified this write's device as an allowed console device (DEVICE_HEADER; machine changes need it).
 */
function forward(i: HubInstance, req: IncomingMessage, res: ServerResponse, path: string, search: URLSearchParams, login: string | null, authenticatedAt: number | null = null, deviceOk = false): void {
  const token = readToken(i);
  if (!token) return json(res, 502, { error: `can't read instance ${i.name}'s dashboard token (${i.tokenFile}): is its dashboard running, and the hub allowed to read it?` });
  search.delete('t');
  const qs = search.toString();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': req.headers['content-type'] ?? 'application/json' };
  if (req.headers['last-event-id']) headers['last-event-id'] = String(req.headers['last-event-id']);
  if (login) headers[LOGIN_HEADER] = login;
  if (login && authenticatedAt) headers[AUTH_AT_HEADER] = String(authenticatedAt);
  if (login && deviceOk) headers[DEVICE_HEADER] = '1';
  const up = request({ host: '127.0.0.1', port: i.port, path: `${path}${qs ? `?${qs}` : ''}`, method: req.method, headers }, (r) => {
    const h: Record<string, string> = { 'cache-control': 'no-store' };
    if (r.headers['content-type']) h['content-type'] = r.headers['content-type'];
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: `instance ${i.name}'s dashboard isn't answering on 127.0.0.1:${i.port} (${e.message})` });
    else res.end();
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

/** Whether an instance's own server answers, as the hub sees it, and the person's role there (owner for the break-glass). */
function probe(i: HubInstance, login: string | null): Promise<{ up: boolean; error: string | null; role: Role | null }> {
  const token = readToken(i);
  if (!token) return Promise.resolve({ up: false, error: "can't read its dashboard token", role: null });
  return new Promise((done) => {
    const r = request({ host: '127.0.0.1', port: i.port, path: '/api/role', headers: { authorization: `Bearer ${token}`, ...(login ? { [LOGIN_HEADER]: login, [FRESH_HEADER]: '1' } : {}) }, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        let role: Role | null = null;
        try {
          role = ((JSON.parse(body) as { role?: Role | null }).role ?? null) as Role | null;
        } catch {
          // no role
        }
        done({ up: res.statusCode === 200, error: res.statusCode === 200 ? null : `answered ${res.statusCode}`, role: res.statusCode === 200 ? role : null });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timed out')));
    r.on('error', (e) => done({ up: false, error: e.message, role: null }));
    r.end();
  });
}

const redirect = (res: ServerResponse, to: string, cookies: string[] = []) => {
  res.writeHead(302, { location: to, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  res.end();
};

const page = (res: ServerResponse, status: number, text: string) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
};

const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      const addr = server.address();
      done(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

export async function startHub(opts: HubOptions): Promise<{ server: Server; breakGlass: Server; url: string; breakGlassUrl: string; token: string; session: SessionOf; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  assertLoopbackHost(host);
  const token = dashboardToken(opts.stateDir);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const now = opts.now ?? Date.now;
  const byName = new Map(opts.instances.map((i) => [i.name, i]));
  const signIn = opts.signIn ?? null;
  const sessions = signIn ? new Sessions({ secret: signIn.sessionSecret, file: join(opts.stateDir, 'sessions.json'), now }) : null;
  const states = new SignInStates(now);
  const origin = signIn ? new URL(signIn.publicUrl).origin : null;

  // Each person's role per instance, as that instance just read it from the repo (fresh, not from its cache),
  // kept no longer than the role cache allows.
  const roles = new Map<string, { role: Role | null; until: number }>();
  const roleKey = (instance: string, login: string) => `${instance}\n${login.toLowerCase()}`;
  const learn = (instance: string, login: string, role: Role | null) => roles.set(roleKey(instance, login), { role, until: now() + ROLE_CACHE_MS });
  const knownRole = (instance: string, login: string) => {
    const r = roles.get(roleKey(instance, login));
    return r && now() < r.until ? r : null;
  };
  /** The person's role on an instance: the hub's fresh copy, else the instance asked again. */
  const roleOn = async (i: HubInstance, login: string) => {
    const k = knownRole(i.name, login);
    if (k) return k.role;
    const p = await probe(i, login);
    if (p.up) learn(i.name, login, p.role);
    return p.role;
  };
  const writeOk = (req: IncomingMessage, sid: string) => (req.headers.origin === undefined || req.headers.origin === origin) && sessions!.csrfOk(sid, req.headers[CSRF_HEADER]);

  /**
   * Who is asking on the hub's port, for the owner terminal: the signed-in person, their role on `instance` as
   * that instance read it from its repo (null until the hub has asked, or once 5 minutes old: refused), when they
   * signed in with GitHub, and whether the request carries this session's CSRF token from this site.
   */
  const hubSession: SessionOf = (req, instance) => {
    if (!sessions) return null;
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const s = sid ? sessions.get(sid) : null;
    if (!s || !sid) return null;
    return { login: s.login, role: byName.has(instance) ? (knownRole(instance, s.login)?.role ?? null) : null, authenticatedAt: s.created, csrfOk: writeOk(req, sid) };
  };
  const session = opts.terminal?.session ?? hubSession;
  const t = opts.terminal;
  // The console's allowed devices, as Tailscale identifies them: the terminal needs one, and so does a machine change.
  const devices: DeviceOptions = { allow: t?.devices ?? [], breakGlassPort: opts.breakGlassPort ?? HUB_BREAK_GLASS_PORT, ...(t?.whois ? { whois: t.whois } : {}), ...(t?.peerUid ? { peerUid: t.peerUid } : {}) };

  /** The hub's port: sign-in, sessions, and the instances as the signed-in person sees them. Never the token. */
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      const cookies = parseCookies(req.headers.cookie);
      if (url.pathname === '/auth/login' && req.method === 'GET') {
        if (!signIn) return page(res, 503, "sign-in isn't set up on this hub: see docs/dashboard.md (the owner's break-glass works on this machine)");
        const state = states.create();
        return redirect(res, authorizeUrl(signIn, state), [stateCookie(state)]);
      }
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        if (!signIn || !sessions) return page(res, 503, "sign-in isn't set up on this hub");
        if (!states.take(url.searchParams.get('state'), cookies[STATE_COOKIE])) return page(res, 400, 'this sign-in expired or did not start here; sign in again');
        const code = url.searchParams.get('code');
        if (!code) return page(res, 400, 'GitHub sent no sign-in code; sign in again');
        let login: string;
        try {
          login = await loginFromCode(signIn, code);
        } catch (e) {
          return page(res, 403, `sign-in failed: ${(e as Error).message}`);
        }
        const s = sessions.create(login);
        return redirect(res, '/', [sessionCookie(s.id), clearStateCookie()]);
      }
      const sid = cookies[SESSION_COOKIE];
      const session = sessions?.get(sid) ?? null;
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      // Every write: from this site (when the browser says where from) and with this session's CSRF token.
      if (write && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/'))) {
        if (!session || !sid) return json(res, 401, { error: 'sign in first', signIn: '/auth/login' });
        if (!writeOk(req, sid)) return json(res, 403, { error: req.headers.origin !== undefined && req.headers.origin !== origin ? 'a write from another site is refused' : 'missing or wrong CSRF token: reload the page' });
      }
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        sessions!.delete(sid);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': clearSessionCookie() });
        return void res.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname.startsWith('/api/')) {
        // Who is signed in: nobody is an answer too (the page then shows the sign-in), not an error.
        if (url.pathname === '/api/me' && req.method === 'GET' && !session) return json(res, 200, { login: null, csrf: null, breakGlass: false });
        if (!signIn) return json(res, 401, { error: "sign-in isn't set up on this hub; the owner's break-glass works on this machine only" });
        if (!session || !sid) return json(res, 401, { error: 'sign in first', signIn: '/auth/login' });
        if (url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, { login: session.login, csrf: sessions!.csrf(sid), breakGlass: false });
        if (url.pathname === '/api/hub' && req.method === 'GET') {
          // Only the instances where this person has a role: each instance reads it from its own repo.
          const all = await Promise.all(opts.instances.map(async (i) => ({ name: i.name, ...(await probe(i, session.login)) })));
          for (const i of all) if (i.up) learn(i.name, session.login, i.role);
          return json(res, 200, { instances: all.filter((i) => i.role) });
        }
        const m = url.pathname.match(/^\/api\/i\/([^/]+)\/(.+)$/);
        if (m) {
          const inst = byName.get(m[1]!);
          if (!inst || !(await roleOn(inst, session.login))) return json(res, 403, { error: `no access to instance ${m[1]}` });
          // A write says whether it came from an allowed console device (asked of Tailscale only for writes: they're rare).
          const deviceOk = write && deviceRefusal(req, devices).why === null;
          return forward(inst, req, res, `/api/${m[2]!}`, url.searchParams, session.login, session.created, deviceOk);
        }
        return json(res, 404, { error: 'not found: the hub serves /api/me, /api/hub and /api/i/<instance>/...' });
      }
      serveStatic(webDir, url, res, { hub: true });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  /** The break-glass port: the owner's token, from this machine only, never through a proxy. It grants owner. */
  const breakGlass = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!breakGlassAllowed(req)) return json(res, 403, { error: "the break-glass is the owner's, on this machine only: refused through a proxy or from another address" });
        if (!tokenGiven(req, url, token)) return json(res, 401, { error: 'missing or wrong token; open the URL the hub setup printed' });
        if (url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, { login: null, csrf: null, breakGlass: true });
        if (url.pathname === '/api/hub' && req.method === 'GET') {
          const instances = await Promise.all(opts.instances.map(async (i) => ({ name: i.name, ...(await probe(i, null)) })));
          return json(res, 200, { instances });
        }
        // /api/i/<instance>/<path> is that instance's /api/<path>.
        const m = url.pathname.match(/^\/api\/i\/([^/]+)\/(.+)$/);
        if (m) {
          const inst = byName.get(m[1]!);
          if (!inst) return json(res, 404, { error: `no instance ${m[1]} in this hub` });
          return forward(inst, req, res, `/api/${m[2]!}`, url.searchParams, null);
        }
        return json(res, 404, { error: 'not found: the hub serves /api/hub and /api/i/<instance>/...' });
      }
      serveStatic(webDir, url, res, { hub: true });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  // The owner terminal, on WebSocket upgrades to the sign-in port (src/console/terminal-server.ts); every attempt and command goes to the hub's audit log.
  const detachTerminal = attachTerminal(server, {
    config: { consoleUser: t?.consoleUser ?? null, hubUser: t?.hubUser ?? currentUser() },
    instances: opts.instances.map((i) => i.name),
    session,
    audit: t?.audit ?? fileAudit(join(opts.stateDir, 'terminal-audit.jsonl')),
    // Never served on the break-glass server (only this one), and refused there anyway if it ever were.
    devices,
    ...(t?.spawnPty ? { spawnPty: t.spawnPty } : {}),
    ...(t?.exec ? { exec: t.exec } : {}),
    ...(t?.now ? { now: t.now } : {}),
    ...(t?.idleMs ? { idleMs: t.idleMs } : {}),
  });
  const shown = host.includes(':') ? `[${host}]` : host;
  const port = await listen(server, opts.port ?? 0, host);
  let bgPort: number;
  try {
    bgPort = await listen(breakGlass, opts.breakGlassPort ?? 0, host);
  } catch (e) {
    detachTerminal();
    server.close();
    throw e;
  }
  return {
    server,
    breakGlass,
    url: `http://${shown}:${port}/`,
    breakGlassUrl: `http://${shown}:${bgPort}/?t=${token}`,
    token,
    session,
    close: () => {
      detachTerminal();
      return Promise.all(
        [server, breakGlass].map(
          (s) =>
            new Promise<void>((r) => {
              s.closeAllConnections();
              s.close(() => r());
            }),
        ),
      ).then(() => undefined);
    },
  };
}
