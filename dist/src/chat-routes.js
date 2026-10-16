import { ChatError } from './chat.js';
import { AttachmentError } from './chat-attachments.js';
import { askInConversation, attachmentViews, ConversationError, createConversation, createProject, deleteConversation, deleteProject, listConversations, listProjects, openConversation, projectFor, projectView, sharers, turnFor, updateConversation, updateProject } from './chat-conversations.js';
import { isOwner, isWriter } from './dashboard-auth.js';
const turnView = (t, c) => {
    const owner = isOwner(c.who.role);
    const f = { v: 1, id: t.id, at: t.at, ...(t.state === 'answered' && t.answer ? { state: 'answered', answer: t.answer } : t.state === 'refused' ? { state: 'refused', why: t.why ?? '' } : { state: 'pending' }) };
    return { by: t.by, text: t.text, attachments: attachmentViews(c.stateDir, t.attachments ?? []), ...c.answerFor(f, owner), owner, filed: c.filed(t.id) };
};
/** Handles a conversations or Projects route; false for any other path. */
export async function handleConversationRoute(req, res, url, c) {
    const p = url.pathname;
    if (!/^\/api\/chat\/(conversations|projects)(\/|$)/.test(p))
        return false;
    const { login: by, role } = c.who;
    if (!isWriter(role)) {
        req.resume();
        c.json(res, 403, { error: `conversations and projects are for the instance's owners and writers (admin or write on its repo); @${by} is a ${role}` });
        return true;
    }
    const send = (status, b) => (c.json(res, status, b), true);
    const body = async () => (req.method === 'GET' || req.method === 'HEAD' ? {} : ((await c.readBody(req)) ?? {}));
    const q = url.searchParams;
    const sharer = await sharers(c.stateDir, c.roleOf);
    try {
        if (p === '/api/chat/conversations') {
            if (req.method === 'GET')
                return send(200, listConversations(c.stateDir, by, sharer, { cursor: q.get('cursor'), limit: q.get('limit'), ...(q.get('project') ? { project: q.get('project') } : {}) }));
            if (req.method === 'POST') {
                const b = await body();
                const conv = createConversation({ stateDir: c.stateDir, by, sharer, title: b.title, project: b.project });
                c.audit('chat.conversation_created', { id: conv.id, project: conv.project });
                return send(200, { conversation: conv });
            }
        }
        const conv = p.match(/^\/api\/chat\/conversations\/([^/]+)(?:\/(messages)|\/turns\/([^/]+)\/(file-issue))?$/);
        if (conv) {
            const id = conv[1];
            if (conv[2] && req.method === 'POST') {
                const b = await body();
                const picked = c.pick?.(b.pick) ?? null;
                if (picked && 'error' in picked)
                    return send(400, { error: picked.error });
                const asked = askInConversation({ stateDir: c.stateDir, id, by, text: b.text, attachments: b.attachments, ...(b.key !== undefined ? { key: b.key } : {}), ...(picked ?? {}), caps: c.caps });
                c.audit('chat.asked', { id: asked.id, conversation: id });
                return send(200, asked);
            }
            if (conv[4] && req.method === 'POST') {
                const t = turnFor(c.stateDir, id, conv[3], by);
                const r = await c.fileDraft(t.id, t.state === 'answered' ? (t.answer ?? null) : null);
                return send(r.status, r.body);
            }
            if (!conv[2] && !conv[4]) {
                if (req.method === 'GET') {
                    const o = openConversation(c.stateDir, id, by, sharer);
                    return send(200, { ...o, turns: o.turns.map((t) => turnView(t, c)) });
                }
                if (req.method === 'PATCH') {
                    const b = await body();
                    const next = updateConversation({ stateDir: c.stateDir, id, by, sharer, title: b.title, project: b.project });
                    c.audit('chat.conversation_changed', { id, project: next.project });
                    return send(200, { conversation: next });
                }
                if (req.method === 'DELETE') {
                    deleteConversation({ stateDir: c.stateDir, id, by });
                    c.audit('chat.conversation_deleted', { id });
                    return send(200, { ok: true });
                }
            }
        }
        if (p === '/api/chat/projects') {
            if (req.method === 'GET')
                return send(200, listProjects(c.stateDir, by, sharer, { cursor: q.get('cursor'), limit: q.get('limit') }));
            if (req.method === 'POST') {
                const proj = createProject({ stateDir: c.stateDir, by, owner: isOwner(role), input: await body(), caps: c.caps });
                c.audit('chat.project_created', { id: proj.id, shared: proj.shared, files: proj.files });
                return send(200, { project: projectView(c.stateDir, proj) });
            }
        }
        const proj = p.match(/^\/api\/chat\/projects\/([^/]+)$/);
        if (proj) {
            const id = proj[1];
            if (req.method === 'GET')
                return send(200, { project: projectView(c.stateDir, projectFor(c.stateDir, id, by, sharer)) });
            if (req.method === 'PATCH') {
                const next = updateProject({ stateDir: c.stateDir, id, by, owner: isOwner(role), sharer, input: await body(), caps: c.caps });
                c.audit('chat.project_changed', { id, shared: next.shared, files: next.files });
                return send(200, { project: projectView(c.stateDir, next) });
            }
            if (req.method === 'DELETE') {
                deleteProject({ stateDir: c.stateDir, id, by, sharer });
                c.audit('chat.project_deleted', { id });
                return send(200, { ok: true });
            }
        }
        return send(405, { error: `${req.method} isn't allowed on ${p}` });
    }
    catch (e) {
        if (e instanceof ConversationError)
            return send(e.status, { error: e.message });
        if (e instanceof AttachmentError)
            return send(e.status, { error: e.message });
        if (e instanceof ChatError)
            return send(400, { error: e.message });
        throw e;
    }
}
//# sourceMappingURL=chat-routes.js.map