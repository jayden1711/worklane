// Linear source (docs/intake.md 2.8): open issues in one team carrying one label, read by polling Linear's GraphQL API
// on the intake timer (Linear's webhooks need a public HTTPS address; this machine has none and opens no port). Each
// pull reads in two steps, so a creator who isn't an allowed sender has nothing of their issue fetched but its id:
// 1. list the labelled issues' ids, creators' ids and whether a bot or an app made them;
// 2. fetch the title and description of only the issues whose creator is in linear.allowed_senders.
// A dropped issue is remembered by its id (linear-skipped.json, the coordinator's, 0600), so it is counted once. A
// taken issue is a report, through the same pipeline as a chat message; its replies are comments on it. Nothing here
// changes the Linear issue otherwise: no state, label or assignee. The API key lives only in memory here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactString } from '../events/redact.js';
import { writeOwnerOnly } from '../os/index.js';
import { LINEAR_ID } from './report.js';
import { privateDir, seen } from './store.js';
/** Linear's GraphQL API. INVARIANT: a constant; no config, environment variable or request names another host. */
export const LINEAR_API = 'https://api.linear.app/graphql';
/** The longest reply posted as a comment. */
export const LINEAR_REPLY_CHARS = 500;
const MAX_TEXT = 4000;
/** Pages of 50 listed per pull at most. */
const MAX_PAGES = 4;
/** Dropped issue ids remembered. */
const MAX_SKIPPED = 5000;
const SKIPPED_FILE = 'linear-skipped.json';
export class LinearError extends Error {
    retryAfterMs;
    constructor(message, retryAfterMs) {
        super(message);
        this.retryAfterMs = retryAfterMs;
    }
}
/** Remove every occurrence of the key from a message (and so from anything a server echoed back). */
export const scrubKey = (text, key) => (key ? text.split(key).join('[key]') : text);
/**
 * One GraphQL request with the API key (Linear wants the bare key in Authorization, no "Bearer"). A rate limit is a
 * LinearError with when to come back; any other failure a LinearError with the key scrubbed out.
 */
export async function linearQuery(o, query, variables = {}) {
    const fail = (m, retry) => new LinearError(scrubKey(m, o.apiKey), retry);
    let r;
    try {
        // INVARIANT: the key goes in the Authorization header only, never in a URL or a body.
        r = await (o.fetch ?? fetch)(LINEAR_API, { method: 'POST', headers: { authorization: o.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
    }
    catch (e) {
        throw fail(`could not reach Linear: ${e.name}`);
    }
    let body = {};
    try {
        body = (await r.json());
    }
    catch {
        // not JSON: handled below by the status
    }
    const limited = r.status === 429 || (body.errors ?? []).some((e) => e.extensions?.code === 'RATELIMITED');
    if (limited) {
        const reset = Number(r.headers.get('x-ratelimit-requests-reset'));
        const now = o.now?.() ?? Date.now();
        throw fail('Linear rate limit reached', Number.isFinite(reset) && reset > now ? reset - now : 60 * 60_000);
    }
    if (!r.ok || body.errors?.length || !body.data) {
        const why = body.errors?.[0]?.message;
        throw fail(`Linear refused the request (HTTP ${r.status}${typeof why === 'string' ? `: ${why.slice(0, 200)}` : ''})`);
    }
    return body.data;
}
/** Text for a Linear comment (markdown) with markdown's active characters escaped, links left whole. */
export function escapeLinearMarkdown(text) {
    const parts = text.split(/(https?:\/\/[^\s)]+)/g);
    return parts.map((p, i) => (i % 2 ? p : p.replace(/([\\`*_[\]<>!#|~@])/g, '\\$1'))).join('');
}
const LIST = `query IntakeList($team: ID!, $label: ID!, $after: String) {
  issues(first: 50, after: $after, orderBy: createdAt, filter: { team: { id: { eq: $team } }, labels: { id: { eq: $label } }, state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { id creator { id app } botActor { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const FETCH = `query IntakeFetch($ids: [ID!]!) {
  issues(first: 50, filter: { id: { in: $ids } }) {
    nodes { id identifier title description creator { id app name displayName } }
  }
}`;
const COMMENT = `mutation IntakeReply($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;
export class LinearIntake {
    o;
    name = 'linear';
    nextAt = 0;
    /** Issues seen and dropped, counted only: `bot` (no creator, an app or an integration), `sender` (not allowed). */
    droppedBy = { bot: 0, sender: 0 };
    /** The GraphQL queries sent, by name (tests read it: the fetch step is never sent for a creator who isn't allowed). */
    sent = [];
    constructor(o) {
        this.o = o;
    }
    q(name, query, variables) {
        this.sent.push(name);
        return linearQuery({ apiKey: this.o.apiKey, ...(this.o.fetch ? { fetch: this.o.fetch } : {}), ...(this.o.now ? { now: this.o.now } : {}) }, query, variables);
    }
    skipFile = () => join(this.o.stateDir, 'intake', SKIPPED_FILE);
    skipped() {
        try {
            const v = existsSync(this.skipFile()) ? JSON.parse(readFileSync(this.skipFile(), 'utf8')) : [];
            return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
        }
        catch {
            return [];
        }
    }
    skip(ids) {
        if (!ids.length)
            return;
        privateDir(join(this.o.stateDir, 'intake'));
        writeOwnerOnly(this.skipFile(), JSON.stringify([...this.skipped(), ...ids].slice(-MAX_SKIPPED)));
    }
    // INVARIANT: one listing per poll_minutes at most, and none before a rate limit's reset, whatever the intake
    // timer's pace.
    async take() {
        const now = this.o.now?.() ?? Date.now();
        if (now < this.nextAt)
            return [];
        const cfg = this.o.config();
        this.nextAt = now + cfg.poll_minutes * 60_000;
        if (!cfg.team || !cfg.label)
            return [];
        try {
            return await this.pull(cfg, now);
        }
        catch (e) {
            if (e instanceof LinearError && e.retryAfterMs)
                this.nextAt = Math.max(this.nextAt, now + e.retryAfterMs);
            throw e;
        }
    }
    async pull(cfg, now) {
        const allowed = new Set(cfg.allowed_senders);
        const skipped = new Set(this.skipped());
        const wanted = [];
        const drop = [];
        let after = null;
        for (let page = 0; page < MAX_PAGES; page++) {
            const d = await this.q('list', LIST, { team: cfg.team, label: cfg.label, after });
            for (const n of d.issues?.nodes ?? []) {
                const id = typeof n.id === 'string' && LINEAR_ID.test(n.id) ? n.id : null;
                if (!id || skipped.has(id) || seen(this.o.stateDir, { source: 'linear', sourceId: id }))
                    continue;
                const creator = n.creator && typeof n.creator.id === 'string' ? n.creator.id : null;
                // No creator (deleted, an integration, a system process), an app user or a bot actor: not a person's report.
                if (!creator || n.creator?.app === true || (n.botActor !== null && n.botActor !== undefined)) {
                    this.droppedBy.bot++;
                    drop.push(id);
                }
                else if (!allowed.has(creator)) {
                    // Not an allowed sender: dropped on the creator's id alone; nothing else of the issue is ever fetched.
                    this.droppedBy.sender++;
                    drop.push(id);
                }
                else
                    wanted.push(id);
            }
            const info = d.issues?.pageInfo;
            if (info?.hasNextPage !== true || typeof info.endCursor !== 'string')
                break;
            after = info.endCursor;
        }
        this.skip(drop);
        const out = [];
        const at = new Date(now).toISOString();
        for (let i = 0; i < wanted.length; i += 50) {
            const d = await this.q('fetch', FETCH, { ids: wanted.slice(i, i + 50) });
            for (const n of d.issues?.nodes ?? []) {
                const id = typeof n.id === 'string' && wanted.includes(n.id) ? n.id : null;
                const creator = n.creator && typeof n.creator.id === 'string' ? n.creator.id : null;
                // Checked again: the issue's creator as fetched, not only as listed.
                if (!id || !creator || n.creator?.app === true || !allowed.has(creator))
                    continue;
                const title = typeof n.title === 'string' ? n.title : '';
                const description = typeof n.description === 'string' ? n.description : '';
                const name = [n.creator?.displayName, n.creator?.name].find((x) => typeof x === 'string' && x.trim().length >= 2);
                out.push({
                    source: 'linear',
                    sourceId: id,
                    sender: { source: 'linear', id: creator, ...(typeof name === 'string' ? { name: name.trim().slice(0, 100) } : {}) },
                    text: redactString(`${title}\n\n${description}`).slice(0, MAX_TEXT),
                    receivedAt: at,
                    thread: { kind: 'channel', id },
                });
            }
        }
        return out;
    }
    /** One comment on the report's own issue, at most LINEAR_REPLY_CHARS, markdown escaped. Nothing else is changed. */
    async reply(thread, text) {
        if (!LINEAR_ID.test(thread.id))
            return false;
        const d = await this.q('comment', COMMENT, { issueId: thread.id, body: escapeLinearMarkdown(text.slice(0, LINEAR_REPLY_CHARS)) });
        return d.commentCreate?.success === true;
    }
    source() {
        return { name: this.name, take: () => this.take(), reply: (t, text) => this.reply(t, text) };
    }
}
//# sourceMappingURL=linear.js.map