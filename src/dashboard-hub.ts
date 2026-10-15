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
import { Agent, createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_WEB_DIR, dashboardToken, json, serveStatic, tokenGiven, warmStatic } from './dashboard.js';
import { refuseKeyInUrl } from './dashboard-key-url.js';
import { compressStream, mayCompressApi, requestEncoding } from './dashboard-compress.js';
import { assertLoopbackHost, authorizeUrl, breakGlassAllowed, clearSessionCookie, clearStateCookie, CSRF_HEADER, csrfFromProtocols, DEVICE_HEADER, isDeviceView, FRESH_HEADER, LOGIN_HEADER, loginFromCode, parseCookies, ROLE_CACHE_MS, SESSION_COOKIE, sessionCookie, Sessions, SignInStates, STATE_COOKIE, stateCookie, type Role, type SessionOf, type SignInConfig } from './dashboard-auth.js';
import { attachTerminal } from './console/terminal-server.js';
import { deviceRefusal, type DeviceOptions } from './console/terminal-devices.js';
import { fileAudit, type AuditSink, type Exec, type SpawnPty } from './console/terminal.js';
import { currentUser } from './os/index.js';
import { handleManifestBreakGlass, handleManifestPublic, ManifestFlows } from './setup/app-manifest.js';
import { isMachineOwner } from './machine-owners.js';
import { Avatars, type AvatarOptions } from './avatars.js';
import { startSiriGateway } from './siri/gateway.js';
import { SIRI_GATEWAY_TOKEN_FILE } from './siri/instance.js';

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
  /**
   * GitHub Apps made through the manifest flow (src/setup/app-manifest.ts): who is a machine owner, and GitHub's
   * bases (a fake GitHub in tests; the sign-in's, else GitHub's, by default).
   */
  appManifest?: { isMachineOwner?: (login: string) => boolean; api?: string; web?: string; fetch?: typeof fetch };
  /** People's pictures (src/avatars.ts): a stand-in for GitHub, in code, for tests. */
  avatars?: AvatarOptions;
  /**
   * The Siri gateway (src/siri/gateway.ts): its own loopback listener on `port` (tailscale serve publishes it on
   * 8443), given each instance's Siri gateway token file only. Absent: no gateway. whois and peerUid: tests only.
   */
  siri?: { port: number; whois?: (ip: string) => string; peerUid?: (clientPort: number, serverPort: number) => number | null; lockout?: { fails: number; windowMs: number; forMs: number } };
  now?: () => number;
}

/** A person's picture through the hub: /api/i/<instance>/avatar/<login>, served by the hub itself (#462). */
const HUB_AVATAR = /^\/api\/i\/([^/]+)\/avatar\/([^/]+)$/;

/** The hub's port: next to the instances' range (4400-4899). */
export const HUB_PORT = 4399;
/** The break-glass port: the token, on this machine only. */
export const HUB_BREAK_GLASS_PORT = 4398;
const NAME = /^[a-z][a-z0-9-]{0,40}$/;

/** `--hub -`: a hub with no instance yet (a machine's first project: dashboards.sh --no-instances). */
export const NO_INSTANCES = '-';

/**
 * `a=/state/a,b=/state/b`: each instance's name and state dir (its token file is there). `-` alone: none yet, said
 * outright, so a list that came out empty by mistake is still refused.
 */
export function parseHubArg(arg: string, port: (name: string) => number): HubInstance[] {
  if (arg === NO_INSTANCES) return [];
  const out: HubInstance[] = [];
  for (const part of arg.split(',').filter(Boolean)) {
    const i = part.indexOf('=');
    const name = part.slice(0, i);
    const dir = part.slice(i + 1);
    if (i < 1 || !NAME.test(name) || !dir) throw new Error(`--hub takes name=<state dir>[,name=<state dir>...]; got "${part}"`);
    if (out.some((x) => x.name === name)) throw new Error(`--hub names ${name} twice`);
    out.push({ name, port: port(name), tokenFile: `${dir.replace(/[\\/]+$/, '')}/dashboard-token` });
  }
  if (!out.length) throw new Error(`--hub needs at least one instance (or ${NO_INSTANCES} alone for none yet)`);
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

/**
 * The hub's connections to its instances' servers, kept open between calls: a page switch makes several calls at once,
 * and each would otherwise open a new connection. Said here rather than left to Node's default.
 */
const upstream = new Agent({ keepAlive: true });

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
function forward(i: HubInstance, req: IncomingMessage, res: ServerResponse, path: string, search: URLSearchParams, login: string | null, deviceOk = false): void {
  const token = readToken(i);
  if (!token) return json(res, 502, { error: `can't read instance ${i.name}'s dashboard token (${i.tokenFile}): is its dashboard running, and the hub allowed to read it?` });
  search.delete('t');
  const qs = search.toString();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': req.headers['content-type'] ?? 'application/json' };
  if (req.headers['last-event-id']) headers['last-event-id'] = String(req.headers['last-event-id']);
  if (login) headers[LOGIN_HEADER] = login;
  if (login && deviceOk) headers[DEVICE_HEADER] = '1';
  // No accept-encoding goes upstream (the headers are built above), so the instance answers uncompressed over loopback;
  // a view COMPRESSIBLE_API lists is compressed here, on its way to the browser. Never a stream: it is text/event-stream.
  const enc = mayCompressApi(path) ? requestEncoding(req) : null;
  const up = request({ host: '127.0.0.1', port: i.port, path: `${path}${qs ? `?${qs}` : ''}`, method: req.method, headers, agent: upstream }, (r) => {
    const h: Record<string, string> = { 'cache-control': 'no-store' };
    const type = r.headers['content-type'];
    if (type) h['content-type'] = type;
    const json = !!type && /^application\/json/.test(type) && !r.headers['content-encoding'];
    if (mayCompressApi(path)) h.vary = 'accept-encoding';
    if (enc && json) {
      res.writeHead(r.statusCode ?? 502, { ...h, 'content-encoding': enc });
      return void r.pipe(compressStream(enc)).pipe(res);
    }
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

/**
 * Whether `who` is a person instance `i` knows (its events and config name them), as that instance says when asked
 * as `asker` (null: the break-glass); false when it can't say.
 */
function instanceKnows(i: HubInstance, who: string, asker: string | null): Promise<boolean> {
  const token = readToken(i);
  if (!token) return Promise.resolve(false);
  return new Promise((done) => {
    const r = request({ host: '127.0.0.1', port: i.port, path: `/api/people/${who}`, headers: { authorization: `Bearer ${token}`, ...(asker ? { [LOGIN_HEADER]: asker } : {}) }, timeout: 3000, agent: upstream }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (body.length + c.length <= 4096) body += c;
      });
      res.on('end', () => {
        try {
          done(res.statusCode === 200 && (JSON.parse(body) as { known?: unknown }).known === true);
        } catch {
          done(false);
        }
      });
    });
    r.on('timeout', () => r.destroy(new Error('timed out')));
    r.on('error', () => done(false));
    r.end();
  });
}

/** Whether an instance's own server answers, as the hub sees it, and the person's role there (owner for the break-glass). */
function probe(i: HubInstance, login: string | null): Promise<{ up: boolean; error: string | null; role: Role | null }> {
  const token = readToken(i);
  if (!token) return Promise.resolve({ up: false, error: "can't read its dashboard token", role: null });
  return new Promise((done) => {
    const r = request({ host: '127.0.0.1', port: i.port, path: '/api/role', headers: { authorization: `Bearer ${token}`, ...(login ? { [LOGIN_HEADER]: login, [FRESH_HEADER]: '1' } : {}) }, timeout: 3000, agent: upstream }, (res) => {
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

export async function startHub(opts: HubOptions): Promise<{ server: Server; breakGlass: Server; url: string; breakGlassUrl: string; keyFile: string; token: string; session: SessionOf; siriUrl: string | null; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  assertLoopbackHost(host);
  const token = dashboardToken(opts.stateDir);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  warmStatic(webDir);
  const now = opts.now ?? Date.now;
  const byName = new Map(opts.instances.map((i) => [i.name, i]));
  const signIn = opts.signIn ?? null;
  const sessions = signIn ? new Sessions({ secret: signIn.sessionSecret, file: join(opts.stateDir, 'sessions.json'), now }) : null;
  const states = new SignInStates(now);
  const avatars = new Avatars(join(opts.stateDir, 'avatars'), { now, ...opts.avatars });
  // Who each instance said it knows, per asker, kept as long as a role is.
  const knownCache = new Map<string, { known: boolean; until: number }>();
  /** Whether the hub may fetch `who`'s picture for `asker` on instance `i`: themselves, a machine owner, or a person `i` knows. */
  const mayShow = async (i: HubInstance, who: string, asker: string | null) => {
    if ((asker && who.toLowerCase() === asker.toLowerCase()) || (am.isMachineOwner ?? ((l: string) => isMachineOwner(l)))(who)) return true;
    const k = `${i.name}\n${asker ?? ''}\n${who.toLowerCase()}`;
    const c = knownCache.get(k);
    if (c && now() < c.until) return c.known;
    const known = await instanceKnows(i, who, asker);
    if (knownCache.size >= 10_000) knownCache.clear();
    knownCache.set(k, { known, until: now() + ROLE_CACHE_MS });
    return known;
  };
  const origin = signIn ? new URL(signIn.publicUrl).origin : null;
  const am = opts.appManifest ?? {};
  const appApi = am.api ?? signIn?.api;
  const appWeb = am.web ?? signIn?.web;
  const appFetch = am.fetch ?? signIn?.fetch;
  const flows = new ManifestFlows({ isMachineOwner: am.isMachineOwner ?? ((l) => isMachineOwner(l)), signIn: !!signIn, publicUrl: origin, now, ...(appApi ? { api: appApi } : {}), ...(appWeb ? { web: appWeb } : {}), ...(appFetch ? { fetch: appFetch } : {}) });

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
  /** The terminal's upgrade: from this site, with the session's CSRF token offered as a subprotocol (a browser can't set the header). */
  const upgradeOk = (req: IncomingMessage, sid: string) => req.headers.origin === origin && sessions!.csrfOk(sid, csrfFromProtocols(req));

  /**
   * Who is asking on the hub's port, for the owner terminal: the signed-in person, their role on `instance` as
   * that instance read it from its repo (null until the hub has asked, or once 5 minutes old: refused), and whether the
   * request carries this session's CSRF token from this site: on the WebSocket upgrade, as a subprotocol.
   */
  const hubSession: SessionOf = (req, instance) => {
    if (!sessions) return null;
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const s = sid ? sessions.get(sid) : null;
    if (!s || !sid) return null;
    return { login: s.login, role: byName.has(instance) ? (knownRole(instance, s.login)?.role ?? null) : null, csrfOk: req.headers.upgrade ? upgradeOk(req, sid) : writeOk(req, sid) };
  };
  const session = opts.terminal?.session ?? hubSession;
  const t = opts.terminal;
  // The console's allowed devices, as Tailscale identifies them: the terminal needs one, and so does a machine change.
  const devices: DeviceOptions = { allow: t?.devices ?? [], breakGlassPort: opts.breakGlassPort ?? HUB_BREAK_GLASS_PORT, ...(t?.whois ? { whois: t.whois } : {}), ...(t?.peerUid ? { peerUid: t.peerUid } : {}) };

  /** The hub's port: sign-in, sessions, and the instances as the signed-in person sees them. Never the token. */
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Every route: a key in the URL is refused (GitHub's sign-in callback carries code and state, never a key).
    if (refuseKeyInUrl(url, res, [token])) return;
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
      // A GitHub App's manifest flow: its start page and GitHub's redirect back, for a signed-in machine owner.
      if (await handleManifestPublic(req, res, url, flows, session?.login ?? null)) return;
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
          // Only the instances where this person has a role: each instance reads it from its own repo. One that isn't
          // answering can't say, so it is listed (as down, nothing more) only while the hub's own copy of the person's
          // role there is still fresh: the same copy, and the same 5 minutes, that the hub forwards a request on.
          const all = await Promise.all(opts.instances.map(async (i) => ({ name: i.name, ...(await probe(i, session.login)) })));
          for (const i of all) if (i.up) learn(i.name, session.login, i.role);
          const listed = all.map((i) => (i.up ? i : { ...i, role: knownRole(i.name, session.login)?.role ?? null }));
          return json(res, 200, { instances: listed.filter((i) => i.role) });
        }
        const av = url.pathname.match(HUB_AVATAR);
        if (av && req.method === 'GET') {
          const inst = byName.get(av[1]!);
          if (!inst || !(await roleOn(inst, session.login))) return json(res, 403, { error: `no access to instance ${av[1]}` });
          return await avatars.serve(req, res, av[2]!, url.searchParams.get('size'), (l) => mayShow(inst, l, session.login));
        }
        const m = url.pathname.match(/^\/api\/i\/([^/]+)\/(.+)$/);
        if (m) {
          const inst = byName.get(m[1]!);
          if (!inst || !(await roleOn(inst, session.login))) return json(res, 403, { error: `no access to instance ${m[1]}` });
          // A write says whether it came from an allowed console device (asked of Tailscale only for writes, and for the
          // views that say before anything is submitted whether a change would pass: DEVICE_VIEWS).
          const deviceOk = (write || (req.method === 'GET' && isDeviceView(m[2]!))) && deviceRefusal(req, devices).why === null;
          return forward(inst, req, res, `/api/${m[2]!}`, url.searchParams, session.login, deviceOk);
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
    // Every route, the page itself included: the break-glass key goes in a header only.
    if (refuseKeyInUrl(url, res, [token])) return;
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!breakGlassAllowed(req)) return json(res, 403, { error: "the break-glass is the owner's, on this machine only: refused through a proxy or from another address" });
        if (!tokenGiven(req, url, token)) return json(res, 401, { error: 'missing or wrong key; give the break-glass key on the page (the hub setup printed its file)' });
        if (url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, { login: null, csrf: null, breakGlass: true });
        // The manifest flow's runner (root, on this machine): register a flow, and collect its App once.
        if (await handleManifestBreakGlass(req, res, url, flows)) return;
        if (url.pathname === '/api/hub' && req.method === 'GET') {
          const instances = await Promise.all(opts.instances.map(async (i) => ({ name: i.name, ...(await probe(i, null)) })));
          return json(res, 200, { instances });
        }
        const av = url.pathname.match(HUB_AVATAR);
        if (av && req.method === 'GET') {
          const inst = byName.get(av[1]!);
          if (!inst) return json(res, 404, { error: `no instance ${av[1]} in this hub` });
          return await avatars.serve(req, res, av[2]!, url.searchParams.get('size'), (l) => mayShow(inst, l, null));
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
  // The Siri gateway: built from each instance's Siri gateway token file only, never its dashboard token.
  let siri: Awaited<ReturnType<typeof startSiriGateway>> | null = null;
  if (opts.siri) {
    try {
      siri = await startSiriGateway({
        instances: opts.instances.map((i) => ({ name: i.name, port: i.port, gatewayTokenFile: join(dirname(i.tokenFile), SIRI_GATEWAY_TOKEN_FILE) })),
        port: opts.siri.port,
        host,
        auditFile: join(opts.stateDir, 'siri-audit.jsonl'),
        ...(opts.siri.whois ? { whois: opts.siri.whois } : {}),
        ...(opts.siri.peerUid ? { peerUid: opts.siri.peerUid } : {}),
        ...(opts.siri.lockout ? { lockout: opts.siri.lockout } : {}),
        now,
      });
    } catch (e) {
      detachTerminal();
      server.close();
      breakGlass.close();
      throw e;
    }
  }
  return {
    server,
    breakGlass,
    url: `http://${shown}:${port}/`,
    // INVARIANT: no key in the URL; the page asks for it (keyFile names where it is).
    breakGlassUrl: `http://${shown}:${bgPort}`,
    keyFile: join(opts.stateDir, 'dashboard-token'),
    token,
    session,
    siriUrl: siri?.url ?? null,
    close: () => {
      detachTerminal();
      return Promise.all(
        [server, breakGlass].map(
          (s) =>
            new Promise<void>((r) => {
              s.closeAllConnections();
              s.close(() => r());
            }),
        ).concat(siri ? [siri.close()] : []),
      ).then(() => undefined);
    },
  };
}
