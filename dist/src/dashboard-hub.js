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
import { Agent, createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_WEB_DIR, dashboardToken, json, serveStatic, tokenGiven, warmStatic } from './dashboard.js';
import { refuseKeyInUrl } from './dashboard-key-url.js';
import { compressStream, mayCompressApi, requestEncoding } from './dashboard-compress.js';
import { assertLoopbackHost, authorizeUrl, breakGlassAllowed, clearSessionCookie, clearStateCookie, CSRF_HEADER, csrfFromProtocols, DEVICE_HEADER, isDeviceView, FRESH_HEADER, LOGIN_HEADER, loginFromCode, parseCookies, ROLE_CACHE_MS, SESSION_COOKIE, sessionCookie, Sessions, SignInStates, STATE_COOKIE, stateCookie } from './dashboard-auth.js';
import { attachTerminal } from './console/terminal-server.js';
import { deviceRefusal } from './console/terminal-devices.js';
import { fileAudit } from './console/terminal.js';
import { currentUser } from './os/index.js';
import { handleManifestBreakGlass, handleManifestPublic, ManifestFlows } from './setup/app-manifest.js';
import { isMachineOwner } from './machine-owners.js';
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
export function parseHubArg(arg, port) {
    if (arg === NO_INSTANCES)
        return [];
    const out = [];
    for (const part of arg.split(',').filter(Boolean)) {
        const i = part.indexOf('=');
        const name = part.slice(0, i);
        const dir = part.slice(i + 1);
        if (i < 1 || !NAME.test(name) || !dir)
            throw new Error(`--hub takes name=<state dir>[,name=<state dir>...]; got "${part}"`);
        if (out.some((x) => x.name === name))
            throw new Error(`--hub names ${name} twice`);
        out.push({ name, port: port(name), tokenFile: `${dir.replace(/[\\/]+$/, '')}/dashboard-token` });
    }
    if (!out.length)
        throw new Error(`--hub needs at least one instance (or ${NO_INSTANCES} alone for none yet)`);
    return out;
}
/**
 * The sign-in settings from the files `credentials.sh dashboard-signin` installs (client-secret and session-secret,
 * 0400, the viewer's), the App's client id and the hub's public URL (https, as browsers reach it).
 */
export function signInFromFiles(o) {
    if (!/^[A-Za-z0-9._-]{8,64}$/.test(o.clientId))
        throw new Error('--client-id: the sign-in App\'s client id (letters, digits, dots, dashes)');
    let u;
    try {
        u = new URL(o.publicUrl);
    }
    catch {
        throw new Error(`--public-url: not a URL: ${o.publicUrl}`);
    }
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash)
        throw new Error(`--public-url: the hub's https origin as browsers reach it (https://<machine>.<tailnet>.ts.net), not ${o.publicUrl}`);
    const read = (f) => {
        try {
            return readFileSync(join(o.dir, f), 'utf8').trim();
        }
        catch {
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
const readToken = (i) => {
    try {
        return readFileSync(i.tokenFile, 'utf8').trim() || null;
    }
    catch {
        return null;
    }
};
/**
 * Forward one API call to an instance's own server with its token; the instance's token never reaches the browser.
 * `login`: the signed-in person, named to the instance, which reads their role itself; null for the break-glass.
 * Only the headers the instance needs go upstream, built here: never a cookie, a CSRF token or a client's own login header.
 * `deviceOk`: Tailscale identified this write's device as an allowed console device (DEVICE_HEADER; machine changes need it).
 */
function forward(i, req, res, path, search, login, deviceOk = false) {
    const token = readToken(i);
    if (!token)
        return json(res, 502, { error: `can't read instance ${i.name}'s dashboard token (${i.tokenFile}): is its dashboard running, and the hub allowed to read it?` });
    search.delete('t');
    const qs = search.toString();
    const headers = { authorization: `Bearer ${token}`, 'content-type': req.headers['content-type'] ?? 'application/json' };
    if (req.headers['last-event-id'])
        headers['last-event-id'] = String(req.headers['last-event-id']);
    if (login)
        headers[LOGIN_HEADER] = login;
    if (login && deviceOk)
        headers[DEVICE_HEADER] = '1';
    // No accept-encoding goes upstream (the headers are built above), so the instance answers uncompressed over loopback;
    // a view COMPRESSIBLE_API lists is compressed here, on its way to the browser. Never a stream: it is text/event-stream.
    const enc = mayCompressApi(path) ? requestEncoding(req) : null;
    const up = request({ host: '127.0.0.1', port: i.port, path: `${path}${qs ? `?${qs}` : ''}`, method: req.method, headers, agent: upstream }, (r) => {
        const h = { 'cache-control': 'no-store' };
        const type = r.headers['content-type'];
        if (type)
            h['content-type'] = type;
        const json = !!type && /^application\/json/.test(type) && !r.headers['content-encoding'];
        if (mayCompressApi(path))
            h.vary = 'accept-encoding';
        if (enc && json) {
            res.writeHead(r.statusCode ?? 502, { ...h, 'content-encoding': enc });
            return void r.pipe(compressStream(enc)).pipe(res);
        }
        res.writeHead(r.statusCode ?? 502, h);
        r.pipe(res);
    });
    up.on('error', (e) => {
        if (!res.headersSent)
            json(res, 502, { error: `instance ${i.name}'s dashboard isn't answering on 127.0.0.1:${i.port} (${e.message})` });
        else
            res.end();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
}
/** Whether an instance's own server answers, as the hub sees it, and the person's role there (owner for the break-glass). */
function probe(i, login) {
    const token = readToken(i);
    if (!token)
        return Promise.resolve({ up: false, error: "can't read its dashboard token", role: null });
    return new Promise((done) => {
        const r = request({ host: '127.0.0.1', port: i.port, path: '/api/role', headers: { authorization: `Bearer ${token}`, ...(login ? { [LOGIN_HEADER]: login, [FRESH_HEADER]: '1' } : {}) }, timeout: 3000, agent: upstream }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                let role = null;
                try {
                    role = (JSON.parse(body).role ?? null);
                }
                catch {
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
const redirect = (res, to, cookies = []) => {
    res.writeHead(302, { location: to, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
    res.end();
};
const page = (res, status, text) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
};
const listen = (server, port, host) => new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
        server.off('error', fail);
        const addr = server.address();
        done(typeof addr === 'object' && addr ? addr.port : 0);
    });
});
export async function startHub(opts) {
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
    const origin = signIn ? new URL(signIn.publicUrl).origin : null;
    const am = opts.appManifest ?? {};
    const appApi = am.api ?? signIn?.api;
    const appWeb = am.web ?? signIn?.web;
    const appFetch = am.fetch ?? signIn?.fetch;
    const flows = new ManifestFlows({ isMachineOwner: am.isMachineOwner ?? ((l) => isMachineOwner(l)), signIn: !!signIn, publicUrl: origin, now, ...(appApi ? { api: appApi } : {}), ...(appWeb ? { web: appWeb } : {}), ...(appFetch ? { fetch: appFetch } : {}) });
    // Each person's role per instance, as that instance just read it from the repo (fresh, not from its cache),
    // kept no longer than the role cache allows.
    const roles = new Map();
    const roleKey = (instance, login) => `${instance}\n${login.toLowerCase()}`;
    const learn = (instance, login, role) => roles.set(roleKey(instance, login), { role, until: now() + ROLE_CACHE_MS });
    const knownRole = (instance, login) => {
        const r = roles.get(roleKey(instance, login));
        return r && now() < r.until ? r : null;
    };
    /** The person's role on an instance: the hub's fresh copy, else the instance asked again. */
    const roleOn = async (i, login) => {
        const k = knownRole(i.name, login);
        if (k)
            return k.role;
        const p = await probe(i, login);
        if (p.up)
            learn(i.name, login, p.role);
        return p.role;
    };
    const writeOk = (req, sid) => (req.headers.origin === undefined || req.headers.origin === origin) && sessions.csrfOk(sid, req.headers[CSRF_HEADER]);
    /** The terminal's upgrade: from this site, with the session's CSRF token offered as a subprotocol (a browser can't set the header). */
    const upgradeOk = (req, sid) => req.headers.origin === origin && sessions.csrfOk(sid, csrfFromProtocols(req));
    /**
     * Who is asking on the hub's port, for the owner terminal: the signed-in person, their role on `instance` as
     * that instance read it from its repo (null until the hub has asked, or once 5 minutes old: refused), and whether the
     * request carries this session's CSRF token from this site: on the WebSocket upgrade, as a subprotocol.
     */
    const hubSession = (req, instance) => {
        if (!sessions)
            return null;
        const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        const s = sid ? sessions.get(sid) : null;
        if (!s || !sid)
            return null;
        return { login: s.login, role: byName.has(instance) ? (knownRole(instance, s.login)?.role ?? null) : null, csrfOk: req.headers.upgrade ? upgradeOk(req, sid) : writeOk(req, sid) };
    };
    const session = opts.terminal?.session ?? hubSession;
    const t = opts.terminal;
    // The console's allowed devices, as Tailscale identifies them: the terminal needs one, and so does a machine change.
    const devices = { allow: t?.devices ?? [], breakGlassPort: opts.breakGlassPort ?? HUB_BREAK_GLASS_PORT, ...(t?.whois ? { whois: t.whois } : {}), ...(t?.peerUid ? { peerUid: t.peerUid } : {}) };
    /** The hub's port: sign-in, sessions, and the instances as the signed-in person sees them. Never the token. */
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        // Every route: a key in the URL is refused (GitHub's sign-in callback carries code and state, never a key).
        if (refuseKeyInUrl(url, res, [token]))
            return;
        try {
            const cookies = parseCookies(req.headers.cookie);
            if (url.pathname === '/auth/login' && req.method === 'GET') {
                if (!signIn)
                    return page(res, 503, "sign-in isn't set up on this hub: see docs/dashboard.md (the owner's break-glass works on this machine)");
                const state = states.create();
                return redirect(res, authorizeUrl(signIn, state), [stateCookie(state)]);
            }
            if (url.pathname === '/auth/callback' && req.method === 'GET') {
                if (!signIn || !sessions)
                    return page(res, 503, "sign-in isn't set up on this hub");
                if (!states.take(url.searchParams.get('state'), cookies[STATE_COOKIE]))
                    return page(res, 400, 'this sign-in expired or did not start here; sign in again');
                const code = url.searchParams.get('code');
                if (!code)
                    return page(res, 400, 'GitHub sent no sign-in code; sign in again');
                let login;
                try {
                    login = await loginFromCode(signIn, code);
                }
                catch (e) {
                    return page(res, 403, `sign-in failed: ${e.message}`);
                }
                const s = sessions.create(login);
                return redirect(res, '/', [sessionCookie(s.id), clearStateCookie()]);
            }
            const sid = cookies[SESSION_COOKIE];
            const session = sessions?.get(sid) ?? null;
            // A GitHub App's manifest flow: its start page and GitHub's redirect back, for a signed-in machine owner.
            if (await handleManifestPublic(req, res, url, flows, session?.login ?? null))
                return;
            const write = req.method !== 'GET' && req.method !== 'HEAD';
            // Every write: from this site (when the browser says where from) and with this session's CSRF token.
            if (write && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/'))) {
                if (!session || !sid)
                    return json(res, 401, { error: 'sign in first', signIn: '/auth/login' });
                if (!writeOk(req, sid))
                    return json(res, 403, { error: req.headers.origin !== undefined && req.headers.origin !== origin ? 'a write from another site is refused' : 'missing or wrong CSRF token: reload the page' });
            }
            if (url.pathname === '/auth/logout' && req.method === 'POST') {
                sessions.delete(sid);
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': clearSessionCookie() });
                return void res.end(JSON.stringify({ ok: true }));
            }
            if (url.pathname.startsWith('/api/')) {
                // Who is signed in: nobody is an answer too (the page then shows the sign-in), not an error.
                if (url.pathname === '/api/me' && req.method === 'GET' && !session)
                    return json(res, 200, { login: null, csrf: null, breakGlass: false });
                if (!signIn)
                    return json(res, 401, { error: "sign-in isn't set up on this hub; the owner's break-glass works on this machine only" });
                if (!session || !sid)
                    return json(res, 401, { error: 'sign in first', signIn: '/auth/login' });
                if (url.pathname === '/api/me' && req.method === 'GET')
                    return json(res, 200, { login: session.login, csrf: sessions.csrf(sid), breakGlass: false });
                if (url.pathname === '/api/hub' && req.method === 'GET') {
                    // Only the instances where this person has a role: each instance reads it from its own repo. One that isn't
                    // answering can't say, so it is listed (as down, nothing more) only while the hub's own copy of the person's
                    // role there is still fresh: the same copy, and the same 5 minutes, that the hub forwards a request on.
                    const all = await Promise.all(opts.instances.map(async (i) => ({ name: i.name, ...(await probe(i, session.login)) })));
                    for (const i of all)
                        if (i.up)
                            learn(i.name, session.login, i.role);
                    const listed = all.map((i) => (i.up ? i : { ...i, role: knownRole(i.name, session.login)?.role ?? null }));
                    return json(res, 200, { instances: listed.filter((i) => i.role) });
                }
                const m = url.pathname.match(/^\/api\/i\/([^/]+)\/(.+)$/);
                if (m) {
                    const inst = byName.get(m[1]);
                    if (!inst || !(await roleOn(inst, session.login)))
                        return json(res, 403, { error: `no access to instance ${m[1]}` });
                    // A write says whether it came from an allowed console device (asked of Tailscale only for writes, and for the
                    // views that say before anything is submitted whether a change would pass: DEVICE_VIEWS).
                    const deviceOk = (write || (req.method === 'GET' && isDeviceView(m[2]))) && deviceRefusal(req, devices).why === null;
                    return forward(inst, req, res, `/api/${m[2]}`, url.searchParams, session.login, deviceOk);
                }
                return json(res, 404, { error: 'not found: the hub serves /api/me, /api/hub and /api/i/<instance>/...' });
            }
            serveStatic(webDir, url, res, { hub: true });
        }
        catch (e) {
            json(res, 500, { error: e.message });
        }
    });
    /** The break-glass port: the owner's token, from this machine only, never through a proxy. It grants owner. */
    const breakGlass = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        // Every route, the page itself included: the break-glass key goes in a header only.
        if (refuseKeyInUrl(url, res, [token]))
            return;
        try {
            if (url.pathname.startsWith('/api/')) {
                if (!breakGlassAllowed(req))
                    return json(res, 403, { error: "the break-glass is the owner's, on this machine only: refused through a proxy or from another address" });
                if (!tokenGiven(req, url, token))
                    return json(res, 401, { error: 'missing or wrong key; give the break-glass key on the page (the hub setup printed its file)' });
                if (url.pathname === '/api/me' && req.method === 'GET')
                    return json(res, 200, { login: null, csrf: null, breakGlass: true });
                // The manifest flow's runner (root, on this machine): register a flow, and collect its App once.
                if (await handleManifestBreakGlass(req, res, url, flows))
                    return;
                if (url.pathname === '/api/hub' && req.method === 'GET') {
                    const instances = await Promise.all(opts.instances.map(async (i) => ({ name: i.name, ...(await probe(i, null)) })));
                    return json(res, 200, { instances });
                }
                // /api/i/<instance>/<path> is that instance's /api/<path>.
                const m = url.pathname.match(/^\/api\/i\/([^/]+)\/(.+)$/);
                if (m) {
                    const inst = byName.get(m[1]);
                    if (!inst)
                        return json(res, 404, { error: `no instance ${m[1]} in this hub` });
                    return forward(inst, req, res, `/api/${m[2]}`, url.searchParams, null);
                }
                return json(res, 404, { error: 'not found: the hub serves /api/hub and /api/i/<instance>/...' });
            }
            serveStatic(webDir, url, res, { hub: true });
        }
        catch (e) {
            json(res, 500, { error: e.message });
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
    let bgPort;
    try {
        bgPort = await listen(breakGlass, opts.breakGlassPort ?? 0, host);
    }
    catch (e) {
        detachTerminal();
        server.close();
        throw e;
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
        close: () => {
            detachTerminal();
            return Promise.all([server, breakGlass].map((s) => new Promise((r) => {
                s.closeAllConnections();
                s.close(() => r());
            }))).then(() => undefined);
        },
    };
}
//# sourceMappingURL=dashboard-hub.js.map