// WHY: the setup audit's B8. The hub signs people in with a GitHub App, and that App is best made through GitHub's
// manifest flow, which needs a running hub to send the browser back to; but the hub wouldn't start without the App's
// secret. Setup mode is a hub with no instances and no sign-in, serving one page: make the sign-in App. Once the App's
// client secret is stored, setup mode turns itself off (the process exits), and dashboards.sh starts the real hub with
// it. dashboards.sh --setup runs this as the hub's own viewer user (wl-dash), on loopback; tailscale serve or an ssh
// tunnel reaches it.
//
// Only the machine's owner may use it. Proof is a one-time setup token from a 0600 file in the hub's state, which only
// the hub's user and root can read (`sudo cat` it). It is pasted into the page's form and sent as a POST body: never in
// a URL, a log, an argument or a cookie. It works once: the page's browser then holds a setup session (an HttpOnly,
// Secure cookie, 2 hours at most), and the token file is deleted. Ten wrong tries lock the page until the next start.
//
// What it can change: it writes the sign-in App's client secret, a session secret, the App's client id and the hub's
// public URL into the hub user's sign-in directory (0700; each file 0400), as that user. Nothing else: no root, no
// instance, no key (the App's private key GitHub returns is dropped, as runAppManifest drops it).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { GITHUB_WEB } from './github-hosts.js';
import { assertLoopbackHost, parseCookies } from './dashboard-auth.js';
import { fileAccess, installOwnerOnlySecret, ownerOnlyDir, writeOwnerOnly } from './os/index.js';
import { FlowError, GITHUB_LOGIN, INSTANCE_NAME, MANIFEST_CALLBACK_PATH, MANIFEST_START_PATH, ManifestFlows } from './setup/app-manifest.js';
export const SETUP_TOKEN_FILE = 'setup-token';
/** The file whose existence ends setup mode: the sign-in App's client secret (credentials.sh dashboard-signin's too). */
export const SIGNIN_SECRET_FILE = 'client-secret';
/** __Host-: Secure, Path=/, no Domain: only this origin, only over https. */
export const SETUP_COOKIE = '__Host-setup';
export const SETUP_SESSION_MS = 2 * 60 * 60_000;
export const SETUP_MAX_TRIES = 10;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export class SetupOver extends Error {
}
/** Whether setup mode is over: the sign-in App's client secret is in place. */
export const setupOver = (signinDir) => existsSync(join(signinDir, SIGNIN_SECRET_FILE));
/** This machine's short host name as an App name prefix, or `hub`. */
export function defaultAppPrefix(host = hostname()) {
    const p = (host.toLowerCase().split('.')[0] ?? '')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^[^a-z]+/, '')
        .slice(0, 21)
        .replace(/-+$/, '');
    return INSTANCE_NAME.test(p) ? p : 'hub';
}
const sha = (s) => createHash('sha256').update(s).digest();
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);
/**
 * The setup token: the one in the file, or a new one written there (0600) when there is none. Refuses a file anyone
 * but this user may read, or one this user doesn't own. Only its hash is kept.
 */
export function setupToken(stateDir) {
    const file = join(stateDir, SETUP_TOKEN_FILE);
    const a = fileAccess(file);
    if (a.kind === 'unsupported')
        throw new Error('setup mode needs a POSIX machine (a 0600 token file)');
    if (a.kind === 'hidden')
        throw new Error(`can't read ${file}`);
    if (a.kind === 'missing') {
        ownerOnlyDir(stateDir);
        const token = randomBytes(32).toString('base64url');
        writeOwnerOnly(file, `${token}\n`);
        return { file, hash: sha(token) };
    }
    if (a.uid !== process.getuid?.())
        throw new Error(`${file} isn't this user's: delete it and start again`);
    if (a.openToOthers)
        throw new Error(`${file} is open to others (${a.mode}): delete it and start again`);
    const token = readFileSync(file, 'utf8').trim();
    if (!TOKEN.test(token))
        throw new Error(`${file} doesn't hold a setup token: delete it and start again`);
    return { file, hash: sha(token) };
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** One page, light and dark, no script. */
function layout(title, body) {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1c1c1a;--mut:#5f5e5a;--card:#fff;--line:#e4e3df;--btn:#1c1c1a;--btnfg:#fff;--bad:#b42318;--ok:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--mut:#a3a29d;--card:#1f1f1d;--line:#34332f;--btn:#ececea;--btnfg:#161615;--bad:#f97066;--ok:#47cd89}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:620px;margin:40px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
p{margin:8px 0}.mut{color:var(--mut);font-size:13.5px}.bad{color:var(--bad)}.ok{color:var(--ok)}
label{display:block;font-size:13.5px;margin:8px 0 4px}
input{font:inherit;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;margin-top:12px;padding:8px 16px;border:0;border-radius:999px;background:var(--btn);color:var(--btnfg);cursor:pointer}
code{font:13px ui-monospace,monospace;overflow-wrap:anywhere}
pre{font:13px ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
<main><h1>${esc(title)}</h1>${body}</main></html>`;
}
const headers = (type, extra = {}) => ({
    'content-type': type,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    ...extra,
});
/** The setup-mode hub. Throws SetupOver when the sign-in secret exists already: there is nothing to set up. */
export async function startSetupHub(o) {
    const host = o.host ?? '127.0.0.1';
    assertLoopbackHost(host);
    if (setupOver(o.signinDir))
        throw new SetupOver(`the sign-in App's secret is in ${o.signinDir} already: setup mode is off; start the hub with dashboards.sh <name>...`);
    let origin;
    try {
        const u = new URL(o.publicUrl);
        if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash)
            throw new Error();
        origin = u.origin;
    }
    catch {
        throw new Error(`--public-url: the hub's https origin as browsers reach it (https://<machine>.<tailnet>.ts.net), not ${o.publicUrl}`);
    }
    const now = o.now ?? Date.now;
    const prefix = o.appPrefix ?? defaultAppPrefix();
    const tok = setupToken(o.stateDir);
    /** The token's hash until it is used; then null for good (this process). */
    let tokenHash = tok.hash;
    let tries = 0;
    /** The one setup session: the hash of its cookie, its CSRF token, and when it ends. */
    let session = null;
    let pending = null;
    const gh = o.github ?? {};
    const flows = new ManifestFlows({ isMachineOwner: () => false, signIn: false, publicUrl: origin, now, ...(gh.api ? { api: gh.api } : {}), ...(gh.web ? { web: gh.web } : {}), ...(gh.fetch ? { fetch: gh.fetch } : {}) });
    // GitHub itself: `gh.web` is a test's, in this process; no setting names another host (src/github-hosts.ts).
    const githubWeb = new URL(gh.web ?? GITHUB_WEB).origin;
    let over = null;
    let done;
    const closed = new Promise((r) => (done = r));
    const send = (res, status, title, body, extra = {}) => {
        res.writeHead(status, headers('text/html; charset=utf-8', { 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, ...extra }));
        res.end(layout(title, body));
    };
    const seeOther = (res, to, cookies = []) => {
        res.writeHead(303, headers('text/plain', { location: to, ...(cookies.length ? { 'set-cookie': cookies } : {}) }));
        res.end();
    };
    const sessionOk = (req) => {
        const c = parseCookies(req.headers.cookie)[SETUP_COOKIE];
        if (!session || !c || now() >= session.until)
            return false;
        return same(sha(c), session.hash);
    };
    /** A write from this page: the browser says it came from this origin (or says nothing), and, with a session, its CSRF token. */
    const fromHere = (req) => req.headers.origin === undefined || req.headers.origin === origin;
    const readForm = async (req) => {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
            size += c.length;
            if (size > 4_000)
                throw new FlowError('too large');
            chunks.push(c);
        }
        return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    };
    const unlockPage = (res, status = 200, note = '') => send(res, status, 'Connect GitHub: setup mode', `<p>This hub is in setup mode: it makes the dashboard's sign-in GitHub App, then turns itself off.</p>
<div class="card"><p>Only the machine's owner can go on. On the machine, as root, show the one-time setup token:</p>
<pre>sudo cat ${esc(tok.file)}</pre>
<form method="post" action="/setup/unlock"><label for="token">Setup token (works once)</label><input id="token" name="token" type="password" autocomplete="off" required>
<button type="submit">Continue</button></form>${note ? `<p class="bad">${esc(note)}</p>` : ''}</div>
<p class="mut">The token goes only into this form: never into a link. By hand instead: make the App on GitHub, then <code>credentials.sh dashboard-signin</code> and <code>dashboards.sh --client-id &lt;id&gt; --public-url ${esc(origin)} &lt;name&gt;...</code></p>`);
    const appPage = (res, note = '') => send(res, 200, 'Connect GitHub: the sign-in App', `<p>People sign in to the dashboard with GitHub, through a GitHub App of its own. It has no permissions and no webhook: it only names who signs in.</p>
<div class="card"><form method="post" action="/setup/signin-app"><input type="hidden" name="csrf" value="${esc(session.csrf)}">
<label for="owner">The GitHub account or organization that owns the App</label><input id="owner" name="owner" required pattern="[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}" autocomplete="off" placeholder="your GitHub login">
<p class="mut">GitHub shows the App before it makes it, then sends you back here. Its callback is ${esc(origin)}/auth/callback.</p>
<button type="submit">Continue to GitHub</button></form>${note ? `<p class="bad">${esc(note)}</p>` : ''}</div>`);
    const finish = (why) => {
        if (over)
            return;
        over = why;
        clearInterval(watch);
        server.closeAllConnections?.();
        server.close(() => done(why));
    };
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
            if (over || setupOver(o.signinDir)) {
                send(res, 410, 'Setup mode is off', `<p>The sign-in App is set up. Start the hub with it: <code>${esc(o.nextCommand ?? 'dashboards.sh <name>...')}</code></p>`);
                return void setImmediate(() => finish(over ?? 'the sign-in secret exists'));
            }
            // INVARIANT: the token is never taken from a URL: a link that carries it is refused, not used.
            if (url.searchParams.has('token') || url.searchParams.has('t'))
                return send(res, 400, 'Not in a link', '<p>The setup token is pasted into the page, never put in a link. Open the page without it.</p>');
            if (url.pathname === '/' && req.method === 'GET')
                return sessionOk(req) ? appPage(res) : unlockPage(res);
            if (url.pathname === '/setup/unlock' && req.method === 'POST') {
                if (!fromHere(req))
                    return send(res, 403, 'Refused', '<p>A form from another site is refused.</p>');
                if (!tokenHash)
                    return send(res, 410, 'The token is used', `<p>The setup token works once, and it was used. For a new one, run <code>dashboards.sh --setup</code> again.</p>`);
                if (tries >= SETUP_MAX_TRIES)
                    return send(res, 429, 'Locked', `<p>Too many wrong tokens: setup mode is locked. Run <code>dashboards.sh --setup</code> again.</p>`);
                const given = (await readForm(req)).get('token')?.trim() ?? '';
                if (!same(sha(given), tokenHash)) {
                    tries++;
                    return unlockPage(res, 401, tries >= SETUP_MAX_TRIES ? 'Wrong token. Setup mode is locked now.' : 'Wrong token.');
                }
                tokenHash = null;
                rmSync(tok.file, { force: true });
                const cookie = randomBytes(32).toString('base64url');
                session = { hash: sha(cookie), csrf: randomBytes(24).toString('base64url'), until: now() + SETUP_SESSION_MS };
                // Lax, so GitHub's redirect back (a top-level GET from github.com) carries it; every write also checks the origin and the CSRF token.
                return seeOther(res, '/', [`${SETUP_COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SETUP_SESSION_MS / 1000}`]);
            }
            if (!sessionOk(req))
                return unlockPage(res, 401, url.pathname === '/' ? '' : 'Unlock setup mode first, in this browser.');
            if (url.pathname === '/setup/signin-app' && req.method === 'POST') {
                const form = await readForm(req);
                if (!fromHere(req) || !same(sha(form.get('csrf') ?? ''), sha(session.csrf)))
                    return send(res, 403, 'Refused', '<p>Missing or wrong form token: reload the page.</p>');
                const owner = form.get('owner')?.trim() ?? '';
                if (!GITHUB_LOGIN.test(owner))
                    return appPage(res, 'That is not a GitHub account or organization name.');
                try {
                    const r = await flows.register({ kind: 'signin', instance: prefix, owner });
                    pending = { id: r.id, owner };
                    return seeOther(res, `${MANIFEST_START_PATH}/${r.id}`);
                }
                catch (e) {
                    return appPage(res, `GitHub's App setup couldn't start: ${e.message.slice(0, 200)}`);
                }
            }
            const start = url.pathname.match(/^\/setup\/app-manifest\/start\/(amf-[0-9a-f]{24})$/);
            if (start && req.method === 'GET') {
                const p = flows.page(start[1], null);
                if (p.type === 'text')
                    return send(res, p.status, 'Start again', `<p>${esc(p.body)}</p><p><a href="/">Start again</a></p>`);
                res.writeHead(200, headers('text/html; charset=utf-8', { 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${githubWeb}; frame-ancestors 'none'` }));
                return void res.end(p.body);
            }
            if (url.pathname === MANIFEST_CALLBACK_PATH && req.method === 'GET') {
                const r = await flows.callback(url.searchParams.get('state'), url.searchParams.get('code'), null);
                if (r.status !== 200 || !pending)
                    return send(res, r.status === 200 ? 409 : r.status, 'Not made', `<p class="bad">${esc(r.body)}</p><p><a href="/">Start again</a></p>`);
                const v = await flows.wait(pending.id, 0);
                if (!v || v.status !== 'done')
                    return send(res, 409, 'Not made', `<p class="bad">${esc(v && 'error' in v && v.error ? v.error : 'the App setup ended without an App')}</p><p><a href="/">Start again</a></p>`);
                const app = v.app;
                // The client secret last: its file is what ends setup mode.
                installOwnerOnlySecret(o.signinDir, 'client-id', app.clientId);
                installOwnerOnlySecret(o.signinDir, 'public-url', origin);
                if (!existsSync(join(o.signinDir, 'session-secret')))
                    installOwnerOnlySecret(o.signinDir, 'session-secret', randomBytes(32).toString('hex'));
                installOwnerOnlySecret(o.signinDir, SIGNIN_SECRET_FILE, app.clientSecret);
                const owner = pending.owner;
                pending = null;
                send(res, 200, 'The sign-in App is made', `<p class="ok">GitHub made <strong>${esc(app.slug)}</strong>. Its client secret is stored for this hub's user only (0400); its private key isn't kept, since sign-in never uses it.</p>
<div class="card"><p>Setup mode is off now: this page stops answering. To start the hub with sign-in, as root on the machine:</p>
<pre>${esc(o.nextCommand ?? 'dashboards.sh')} --machine-owner ${esc(owner)} &lt;name&gt;...</pre>
<p class="mut">--machine-owner: the GitHub logins that may change the machine from the dashboard (yours, if ${esc(owner)} is an organization). The App's client id and this URL are read from where setup mode stored them.</p></div>`);
                return void setImmediate(() => finish('the sign-in App is made'));
            }
            send(res, 404, 'Not found', '<p><a href="/">Back</a></p>');
        }
        catch (e) {
            if (!res.headersSent)
                send(res, e instanceof FlowError ? 400 : 500, 'Error', `<p class="bad">${esc(String(e.message).split('\n')[0].slice(0, 200))}</p>`);
        }
    });
    // Someone may install the secret by hand (credentials.sh dashboard-signin) meanwhile: then this is over too.
    const watch = setInterval(() => {
        if (setupOver(o.signinDir))
            finish('the sign-in secret exists');
    }, o.checkMs ?? 2_000);
    watch.unref?.();
    await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(o.port ?? 0, host, () => {
            server.off('error', fail);
            ok();
        });
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
        server,
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/`,
        tokenFile: tok.file,
        closed,
        close: (why = 'stopped') => {
            finish(why);
            return closed;
        },
    };
}
//# sourceMappingURL=hub-setup.js.map