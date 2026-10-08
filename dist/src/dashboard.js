// The local dashboard server: static UI plus a small API over the event
// log. It binds to 127.0.0.1, requires a per-install token, reads the log
// read-only, and pushes changes over one SSE stream. Its only write is a
// human answering a decision, recorded as an event like the CLI does.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BRAND } from './brand.js';
import { EventLog } from './events/log.js';
import { inbox, project } from './projection.js';
import { slotStatus } from './slots.js';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
export function dashboardToken(stateDir) {
    const f = join(stateDir, 'dashboard-token');
    if (existsSync(f))
        return readFileSync(f, 'utf8').trim();
    mkdirSync(stateDir, { recursive: true });
    const t = randomBytes(24).toString('base64url');
    writeFileSync(f, t, { mode: 0o600 });
    return t;
}
function readEvents(dbPath, after = 0) {
    if (!existsSync(dbPath))
        return [];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const rows = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(after);
        return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    }
    finally {
        db.close();
    }
}
function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > 64_000)
            throw new Error('body too large');
        chunks.push(c);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
export function startDashboard(opts) {
    const token = dashboardToken(opts.stateDir);
    const webDir = opts.webDir ?? fileURLToPath(new URL('../web/', import.meta.url));
    const viewsFile = join(opts.stateDir, 'dashboard-views.json');
    const clients = new Set();
    let lastId = readEvents(opts.eventsDb).at(-1)?.id ?? 0;
    const authed = (req, url) => {
        const given = url.searchParams.get('t') ?? (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const a = Buffer.from(given);
        const b = Buffer.from(token);
        return a.length === b.length && timingSafeEqual(a, b);
    };
    const state = () => {
        const events = readEvents(opts.eventsDb);
        const p = project(events);
        const slots = slotStatus();
        return {
            brand: { name: BRAND.name, cli: BRAND.cli },
            project: { name: opts.cfg.project.project.name, repo: opts.cfg.project.project.repo, landMode: opts.cfg.project.land_mode, stage: opts.cfg.agents.stage },
            user: opts.user,
            owners: opts.cfg.project.owners,
            budget: opts.cfg.agents.daily_budget_usd,
            slots: { cap: slots.cap, running: slots.agents.length, agents: slots.agents, fullRun: slots.fullRun },
            ...p,
            inbox: inbox(p, opts.user),
        };
    };
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
            if (url.pathname.startsWith('/api/')) {
                if (!authed(req, url))
                    return json(res, 401, { error: 'missing or wrong token; open the URL printed by `dashboard`' });
                if (url.pathname === '/api/state' && req.method === 'GET')
                    return json(res, 200, state());
                if (url.pathname === '/api/events' && req.method === 'GET') {
                    const evs = readEvents(opts.eventsDb, Number(url.searchParams.get('after') ?? 0)).filter((e) => e.type !== 'coordinator.tick');
                    const issue = url.searchParams.get('issue');
                    // One issue's whole history, or the recent tail of everything.
                    return json(res, 200, issue ? evs.filter((e) => e.payload.issue === Number(issue)) : evs.slice(-500));
                }
                if (url.pathname === '/api/stream' && req.method === 'GET') {
                    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
                    const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? lastId);
                    res.write(`retry: 3000\nid: ${Math.max(since, lastId)}\nevent: hello\ndata: {}\n\n`);
                    clients.add(res);
                    req.on('close', () => clients.delete(res));
                    return;
                }
                if (url.pathname === '/api/decide' && req.method === 'POST') {
                    const body = (await readBody(req));
                    const log = new EventLog(opts.eventsDb);
                    try {
                        const q = log.read(0, ['decision.asked']).find((e) => e.payload.id === body.id)?.payload;
                        if (!q)
                            return json(res, 404, { error: `no decision ${body.id}` });
                        if (!body.answer || !q.options.includes(body.answer))
                            return json(res, 400, { error: `answer must be one of ${q.options.join(', ')}` });
                        const answered = log.read(0, ['decision.answered']).some((e) => e.payload.id === body.id);
                        if (answered)
                            return json(res, 409, { error: 'already answered' });
                        const e = log.append('decision.answered', { id: body.id, by: opts.user, answer: body.answer }, opts.user, 'human');
                        return json(res, 200, { ok: true, event: e.id });
                    }
                    finally {
                        log.close();
                    }
                }
                if (url.pathname === '/api/views') {
                    if (req.method === 'GET')
                        return json(res, 200, existsSync(viewsFile) ? JSON.parse(readFileSync(viewsFile, 'utf8')) : []);
                    if (req.method === 'PUT') {
                        const views = await readBody(req);
                        if (!Array.isArray(views) || views.length > 50)
                            return json(res, 400, { error: 'views must be an array (max 50)' });
                        writeFileSync(viewsFile, JSON.stringify(views, null, 2));
                        return json(res, 200, { ok: true });
                    }
                }
                return json(res, 404, { error: 'not found' });
            }
            // Static UI; anything unknown falls back to index.html (client-side routes).
            const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
            let file = resolve(webDir, rel);
            if (!file.startsWith(resolve(webDir) + sep) && file !== resolve(webDir))
                return json(res, 403, { error: 'forbidden' });
            if (!existsSync(file) || !extname(file))
                file = join(webDir, 'index.html');
            if (!existsSync(file)) {
                res.writeHead(503, { 'content-type': 'text/plain' });
                return res.end('dashboard UI not built: run `npm run build:web` in the engine');
            }
            res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-store' : 'max-age=3600' });
            res.end(readFileSync(file));
        }
        catch (e) {
            json(res, 500, { error: e.message });
        }
    });
    // The coordinator writes the log from another process: poll it and fan new events out.
    const poll = setInterval(() => {
        if (!clients.size)
            return;
        const fresh = readEvents(opts.eventsDb, lastId);
        if (!fresh.length)
            return;
        lastId = fresh.at(-1).id;
        const visible = fresh.filter((e) => e.type !== 'coordinator.tick');
        const msg = `id: ${lastId}\nevent: change\ndata: ${JSON.stringify({ lastId, types: [...new Set(visible.map((e) => e.type))] })}\n\n`;
        for (const c of clients)
            c.write(msg);
    }, opts.pollMs ?? 1000);
    const ping = setInterval(() => {
        for (const c of clients)
            c.write(': ping\n\n');
    }, 25_000);
    return new Promise((resolveStart) => {
        server.listen(opts.port ?? 0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolveStart({
                server,
                url: `http://127.0.0.1:${port}/?t=${token}`,
                token,
                close: () => new Promise((r) => {
                    clearInterval(poll);
                    clearInterval(ping);
                    for (const c of clients)
                        c.end();
                    server.close(() => r());
                }),
            });
        });
    });
}
//# sourceMappingURL=dashboard.js.map