import { EventLog } from '../events/log.js';
import { ASK_EVENTS, AskError, asks, asksFrom, mayAnswerAsk } from './asks.js';
import { requestRootStep } from './root-steps.js';
import { MACHINE_EVENTS, machineRequests } from '../machine-requests.js';
import { readSecretBody, secretsDir, storeSecret } from './secrets.js';
import { useSetupLink } from './links.js';
const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
};
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > 16_000)
            throw new AskError('body too large');
        chunks.push(c);
    }
    try {
        const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        return v && typeof v === 'object' ? v : {};
    }
    catch {
        throw new AskError('the body must be JSON');
    }
}
/** Handle a setup-console route; false when the path isn't one. */
export async function handleAskRoute(req, res, url, ctx) {
    if (url.pathname !== '/api/asks' && !url.pathname.startsWith('/api/asks/'))
        return false;
    const who = ctx.session(req, ctx.instance);
    if (!who || !who.role) {
        // Drain (unread) any body, a secret included, without looking at it.
        req.resume();
        send(res, 403, { error: 'no role on this instance' });
        return true;
    }
    if (url.pathname === '/api/asks' && req.method === 'GET') {
        const log = new EventLog(ctx.eventsDb);
        try {
            const all = asksFrom(log.read(0, [...ASK_EVENTS]));
            // A root step waiting on the coordinator shows its machine request (pending, running, or how it ended).
            const reqs = machineRequests(log.read(0, [...MACHINE_EVENTS]));
            send(res, 200, { role: who.role, login: who.login, asks: all.map((a) => ({ ...a, canAnswer: a.status === 'open' && mayAnswerAsk(a, who.role), request: reqs.filter((r) => r.ask === a.id).at(-1) ?? null })) });
        }
        finally {
            log.close();
        }
        return true;
    }
    // A one-time link from Discord: bound to this person's login and to one ask; used up by any presentation.
    if (url.pathname === '/api/asks/link' && req.method === 'POST') {
        if (!who.csrfOk) {
            req.resume();
            send(res, 403, { error: 'missing or wrong CSRF token' });
            return true;
        }
        const log = new EventLog(ctx.eventsDb);
        try {
            const body = await readJson(req);
            const r = useSetupLink(log, { token: typeof body.token === 'string' ? body.token : '', login: who.login, role: who.role });
            send(res, r.ok ? 200 : r.status, r.ok ? { ok: true, ask: r.ask } : { error: r.error });
        }
        catch (e) {
            // Never the body (it holds the token): a fixed message.
            send(res, e instanceof AskError ? e.status : 500, { error: e instanceof AskError ? e.message : "the link couldn't be checked" });
        }
        finally {
            log.close();
        }
        return true;
    }
    const m = url.pathname.match(/^\/api\/asks\/(ask-[0-9a-f]{12})\/(answer|secret|run)$/);
    if (!m || req.method !== 'POST') {
        req.resume();
        send(res, 404, { error: 'not found' });
        return true;
    }
    const [, id, what] = m;
    if (!who.csrfOk) {
        req.resume();
        send(res, 403, { error: 'missing or wrong CSRF token' });
        return true;
    }
    // A secret is the owner's to paste: refuse anyone else before the body is even read.
    if ((what === 'secret' || what === 'run') && who.role !== 'owner') {
        req.resume();
        send(res, 403, { error: `only the owner may ${what === 'secret' ? 'paste a secret' : 'run a root step'}; @${who.login} (${who.role}) may not` });
        return true;
    }
    const log = new EventLog(ctx.eventsDb);
    try {
        let ask;
        if (what === 'secret') {
            const value = await readSecretBody(req);
            ask = storeSecret(log, id, { by: who.login, role: who.role, value, dir: secretsDir(asks(log).get(id)?.instance ?? ctx.instance, ctx.secretsHome), ...(ctx.secretRules ? { rules: ctx.secretRules } : {}) });
        }
        else if (what === 'run') {
            req.resume();
            const requester = { login: who.login, breakGlass: who.breakGlass === true, deviceOk: who.deviceOk === true };
            ask = requestRootStep(log, id, { by: who.login, role: who.role, requester, ...(ctx.machineOwnersFile ? { ownersFile: ctx.machineOwnersFile } : {}) }).ask;
        }
        else {
            const body = await readJson(req);
            ask = asks(log).answer(id, { by: who.login, role: who.role, answer: String(body.answer ?? '') });
        }
        send(res, 200, { ok: true, ask });
    }
    catch (e) {
        if (e instanceof AskError)
            send(res, e.status, { error: e.message });
        // Anything else on the secret route gets a fixed message: an unexpected error could carry the body.
        else
            send(res, 500, { error: what === 'secret' ? "the secret couldn't be stored" : String(e.message).slice(0, 300) });
    }
    finally {
        log.close();
    }
    return true;
}
//# sourceMappingURL=routes.js.map