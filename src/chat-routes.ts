// The dashboard's routes for chat conversations and Projects (src/chat-conversations.ts), per instance:
//   GET    /api/chat/conversations?cursor=&limit=&project=     this person's conversations, a page at a time
//   POST   /api/chat/conversations                             { title?, project? }
//   GET    /api/chat/conversations/<id>                         one conversation, every turn (only its own files read)
//   PATCH  /api/chat/conversations/<id>                         { title?, project? }
//   DELETE /api/chat/conversations/<id>                         deleted outright
//   POST   /api/chat/conversations/<id>/messages                { text, attachments?, key? } -> { id }
//   POST   /api/chat/conversations/<id>/turns/<turn>/file-issue the answer's draft, through the same confirm flow
//   GET    /api/chat/projects?cursor=&limit=                    the person's Projects and the shared ones they may see
//   POST   /api/chat/projects                                   { name, instructions?, files?, shared? }
//   GET | PATCH | DELETE /api/chat/projects/<id>
// Owners and writers only: a viewer (or anyone whose role is gone) is refused every one of them (403). A message's
// text is only ever in a body, never in a URL; the audit records ids only.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChatError, type ChatAnswer, type ChatAnswerFile } from './chat.js';
import { AttachmentError, type AttachmentCaps } from './chat-attachments.js';
import { askInConversation, attachmentViews, ConversationError, createConversation, createProject, deleteConversation, deleteProject, listConversations, listProjects, openConversation, projectFor, projectView, sharers, turnFor, updateConversation, updateProject, type ConversationTurn } from './chat-conversations.js';
import { isOwner, isWriter, type Role, type RoleOf } from './dashboard-auth.js';

export interface ConversationRouteContext {
  stateDir: string;
  who: { login: string; role: Role };
  /** People's roles on the instance (a shared Project needs its creator to be an owner still); absent: this machine's owner alone. */
  roleOf: RoleOf | undefined;
  /** The chat attachments' caps (src/chat-attachments.ts), for a message's files and a Project's. */
  caps: AttachmentCaps;
  readBody: (req: IncomingMessage) => Promise<unknown>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  audit: (action: string, detail: Record<string, unknown>) => void;
  /** As the single-shot chat: what this person may see of an answer (an owner whole; others without drafts or proposals). */
  answerFor: (f: ChatAnswerFile, owner: boolean) => ChatAnswerFile;
  /** Whether a turn's draft was filed, and its number. */
  filed: (id: string) => { number: number } | null;
  /** The single-shot chat's own filing of a draft (owner only, checked again, once): the same confirm flow. */
  fileDraft: (id: string, answer: ChatAnswer | null) => Promise<{ status: number; body: unknown }>;
}

const turnView = (t: ConversationTurn, c: ConversationRouteContext) => {
  const owner = isOwner(c.who.role);
  const f = { v: 1, id: t.id, at: t.at, ...(t.state === 'answered' && t.answer ? { state: 'answered' as const, answer: t.answer } : t.state === 'refused' ? { state: 'refused' as const, why: t.why ?? '' } : { state: 'pending' as const }) } as ChatAnswerFile;
  return { by: t.by, text: t.text, attachments: attachmentViews(c.stateDir, t.attachments ?? []), ...c.answerFor(f, owner), owner, filed: c.filed(t.id) };
};

/** Handles a conversations or Projects route; false for any other path. */
export async function handleConversationRoute(req: IncomingMessage, res: ServerResponse, url: URL, c: ConversationRouteContext): Promise<boolean> {
  const p = url.pathname;
  if (!/^\/api\/chat\/(conversations|projects)(\/|$)/.test(p)) return false;
  const { login: by, role } = c.who;
  if (!isWriter(role)) {
    req.resume();
    c.json(res, 403, { error: `conversations and projects are for the instance's owners and writers (admin or write on its repo); @${by} is a ${role}` });
    return true;
  }
  const send = (status: number, b: unknown) => (c.json(res, status, b), true);
  const body = async () => (req.method === 'GET' || req.method === 'HEAD' ? {} : (((await c.readBody(req)) as Record<string, unknown> | null) ?? {}));
  const q = url.searchParams;
  const sharer = await sharers(c.stateDir, c.roleOf);
  try {
    if (p === '/api/chat/conversations') {
      if (req.method === 'GET') return send(200, listConversations(c.stateDir, by, sharer, { cursor: q.get('cursor'), limit: q.get('limit'), ...(q.get('project') ? { project: q.get('project') } : {}) }));
      if (req.method === 'POST') {
        const b = await body();
        const conv = createConversation({ stateDir: c.stateDir, by, sharer, title: b.title, project: b.project });
        c.audit('chat.conversation_created', { id: conv.id, project: conv.project });
        return send(200, { conversation: conv });
      }
    }
    const conv = p.match(/^\/api\/chat\/conversations\/([^/]+)(?:\/(messages)|\/turns\/([^/]+)\/(file-issue))?$/);
    if (conv) {
      const id = conv[1]!;
      if (conv[2] && req.method === 'POST') {
        const b = await body();
        const asked = askInConversation({ stateDir: c.stateDir, id, by, text: b.text, attachments: b.attachments, ...(b.key !== undefined ? { key: b.key } : {}), caps: c.caps });
        c.audit('chat.asked', { id: asked.id, conversation: id });
        return send(200, asked);
      }
      if (conv[4] && req.method === 'POST') {
        const t = turnFor(c.stateDir, id, conv[3]!, by);
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
      if (req.method === 'GET') return send(200, listProjects(c.stateDir, by, sharer, { cursor: q.get('cursor'), limit: q.get('limit') }));
      if (req.method === 'POST') {
        const proj = createProject({ stateDir: c.stateDir, by, owner: isOwner(role), input: await body(), caps: c.caps });
        c.audit('chat.project_created', { id: proj.id, shared: proj.shared, files: proj.files });
        return send(200, { project: projectView(c.stateDir, proj) });
      }
    }
    const proj = p.match(/^\/api\/chat\/projects\/([^/]+)$/);
    if (proj) {
      const id = proj[1]!;
      if (req.method === 'GET') return send(200, { project: projectView(c.stateDir, projectFor(c.stateDir, id, by, sharer)) });
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
  } catch (e) {
    if (e instanceof ConversationError) return send(e.status, { error: e.message });
    if (e instanceof AttachmentError) return send(e.status, { error: e.message });
    if (e instanceof ChatError) return send(400, { error: e.message });
    throw e;
  }
}
