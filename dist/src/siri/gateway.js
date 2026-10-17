// The hub's Siri gateway (docs/siri.md): a listener of its own, on loopback (SIRI_GATEWAY_PORT), that `tailscale
// serve --https=8443` publishes on the tailnet, and that answers exactly three requests from a phone's Shortcut:
//   POST /tell       {"text": "..."}   a spoken idea, for the Inbox
//   POST /ask        {"text": "..."}   a spoken question, answered aloud at a viewer's level
//   GET  /ask/<id>                     the answer, while it was still being thought about
// Each answer is JSON {"speech", "done", "id"?}: the Shortcut speaks `speech` whatever happened.
//
// Why it can't be more than that:
// - It is its own server, with its own handler: no session, cookie, CSRF, static file or forwarding of the sign-in
//   port is reachable here, and nothing of this is reachable there.
// - It is built with each instance's Siri gateway token file only (startSiriGateway takes no dashboard token, and
//   this module never reads one): those tokens work on an instance's /api/siri/... routes and nowhere else. It calls
//   exactly SIRI_ROUTES on the instance the device token names.
// - A request counts only from the tailnet: the connection must be tailscaled's (the kernel says which uid opened it)
//   with serve's X-Forwarded-For naming one Tailscale address, which `tailscale whois` turns into a node
//   (src/console/terminal-devices.ts identifyDevice, as for the owner terminal). Tailscale-User-* headers are never
//   read. A token binds to the first node that uses it (src/siri/tokens.ts).
// - Ten refused tokens from one node in ten minutes lock that node out for fifteen.
// Refusals made here, before any instance is asked, go to the hub's own siri-audit.jsonl; the instance audits the rest.
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { assertLoopbackHost } from '../dashboard-auth.js';
import { identifyDevice } from '../console/terminal-devices.js';
import { SIRI_DEVICE_HEADER, SIRI_NODE_HEADER, SIRI_ROUTES, speak } from './instance.js';
import { TOKEN } from './tokens.js';
/** The gateway's loopback port, beside the hub's (4399) and the break-glass (4398). tailscale serve publishes it on 8443. */
export const SIRI_GATEWAY_PORT = 4397;
/** The tailnet HTTPS port tailscale serve publishes the gateway on. */
export const SIRI_TAILNET_PORT = 8443;
/** Bad tokens from one node before it is locked out, the window they count in, and how long the lockout lasts. */
export const LOCKOUT = { fails: 10, windowMs: 10 * 60_000, forMs: 15 * 60_000 };
/** How long the gateway waits for an instance (which itself answers within its 8 s wait). */
const UPSTREAM_MS = 12_000;
function readGatewayToken(file) {
    try {
        const t = readFileSync(file, 'utf8').trim();
        return /^[A-Za-z0-9_-]{16,128}$/.test(t) ? t : null;
    }
    catch {
        return null;
    }
}
async function readBody(req, max) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > max)
            return null;
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}
/** One of the three routes, or null. */
export function gatewayRoute(method, path) {
    if (method === 'POST' && path === '/tell')
        return { upstream: SIRI_ROUTES.tell, method: 'POST' };
    if (method === 'POST' && path === '/ask')
        return { upstream: SIRI_ROUTES.ask, method: 'POST' };
    const m = /^\/ask\/([0-9]{13}-[a-f0-9]{8})$/.exec(path);
    if (method === 'GET' && m)
        return { upstream: `${SIRI_ROUTES.ask}/${m[1]}`, method: 'GET' };
    return null;
}
export async function startSiriGateway(o) {
    const host = o.host ?? '127.0.0.1';
    assertLoopbackHost(host);
    const now = o.now ?? Date.now;
    const byName = new Map(o.instances.map((i) => [i.name, i]));
    const L = o.lockout ?? LOCKOUT;
    const fails = new Map();
    const locked = new Map();
    const audit = (detail) => {
        try {
            appendFileSync(o.auditFile, `${JSON.stringify({ at: new Date(now()).toISOString(), ...detail })}\n`, { mode: 0o600 });
        }
        catch {
            // the audit is best effort here; the instance's own audit is the record of anything that reached it
        }
    };
    const failed = (node) => {
        const t = now();
        const xs = (fails.get(node) ?? []).filter((x) => t - x < L.windowMs);
        xs.push(t);
        fails.set(node, xs);
        if (xs.length >= L.fails) {
            locked.set(node, t + L.forMs);
            fails.delete(node);
            audit({ kind: 'locked_out', node, minutes: L.forMs / 60_000 });
        }
    };
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            // A token never travels in a URL: any query at all is refused, before anything else is read.
            if (url.search)
                return speak(res, 400, 'A Siri request has no query.');
            const route = gatewayRoute(req.method, url.pathname);
            if (!route)
                return speak(res, 404, 'Siri can only tell or ask.');
            // From the tailnet only: a connection tailscaled made, and the node Tailscale says it is.
            const dev = identifyDevice(req, { allow: [], ...(o.whois ? { whois: o.whois } : {}), ...(o.peerUid ? { peerUid: o.peerUid } : {}) });
            if (!dev.ok) {
                audit({ kind: 'refused', why: dev.why });
                return speak(res, 403, 'This only answers from your tailnet.');
            }
            const node = dev.device;
            if (!node.stableId) {
                audit({ kind: 'refused', node: node.name, why: 'Tailscale gave no stable node id' });
                return speak(res, 403, "Tailscale couldn't say which device this is.");
            }
            const until = locked.get(node.stableId);
            if (until && now() < until)
                return speak(res, 429, 'Too many wrong tokens from this device. Try again later.');
            if (until)
                locked.delete(node.stableId);
            const token = (req.headers.authorization ?? '').replace(/^Bearer /, '').trim();
            const m = TOKEN.exec(token);
            const inst = m ? byName.get(m[1]) : undefined;
            if (!m || !inst) {
                failed(node.stableId);
                audit({ kind: 'refused', node: node.name, why: m ? 'the token names no instance on this hub' : 'not a Siri device token' });
                return speak(res, 401, "That device isn't allowed. Make a new token on the dashboard.");
            }
            const gw = readGatewayToken(inst.gatewayTokenFile);
            if (!gw) {
                audit({ kind: 'refused', node: node.name, instance: inst.name, why: "can't read the instance's Siri gateway token" });
                return speak(res, 502, "The project isn't answering Siri right now.");
            }
            const body = route.method === 'POST' ? await readBody(req, 32_000) : Buffer.alloc(0);
            if (body === null)
                return speak(res, 413, 'That was too long.');
            const up = await new Promise((done) => {
                const r = request({
                    host: '127.0.0.1',
                    port: inst.port,
                    path: route.upstream,
                    method: route.method,
                    timeout: UPSTREAM_MS,
                    // Built here, whole: the gateway's token, the device's token and the node. Nothing the phone sent is passed
                    // on but its token and its body; never a login, a cookie or a console-device mark.
                    headers: { authorization: `Bearer ${gw}`, [SIRI_DEVICE_HEADER]: token, [SIRI_NODE_HEADER]: JSON.stringify({ id: node.stableId, name: node.name }), 'content-type': 'application/json', 'content-length': String(body.length) },
                }, (res2) => {
                    const chunks = [];
                    res2.on('data', (c) => chunks.push(c));
                    res2.on('end', () => done({ status: res2.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8') }));
                    res2.on('error', () => done(null));
                });
                r.on('timeout', () => r.destroy());
                r.on('error', () => done(null));
                r.end(body);
            });
            if (!up)
                return speak(res, 502, "The project isn't answering Siri right now.");
            if (up.status === 401)
                failed(node.stableId);
            let v = {};
            try {
                v = JSON.parse(up.text);
            }
            catch {
                // not an answer: said as a failure below
            }
            const speech = typeof v.speech === 'string' ? v.speech : 'The request failed.';
            return speak(res, up.status, speech, { done: v.done !== false, ...(typeof v.id === 'string' && /^[0-9]{13}-[a-f0-9]{8}$/.test(v.id) ? { id: v.id } : {}) });
        }
        catch {
            if (!res.headersSent)
                speak(res, 500, 'The request failed.');
            else
                res.end();
        }
    });
    const port = await new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(o.port ?? 0, host, () => {
            server.off('error', fail);
            const a = server.address();
            done(typeof a === 'object' && a ? a.port : 0);
        });
    });
    return {
        server,
        url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
        close: () => new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
        }),
    };
}
//# sourceMappingURL=gateway.js.map