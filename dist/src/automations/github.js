// GitHub events for automations, by polling (never a webhook: GitHub can't reach a tailnet-only endpoint, and the
// agent App has none). One poller per instance, shared by every GitHub-triggered automation, so its cost doesn't grow
// with their number: three conditional listings (If-None-Match) every POLL_MS at most, and none while no enabled
// automation listens to GitHub. It holds off while the rate limit's remaining calls are under QUOTA_FLOOR of the limit
// (the instance's GitHub credential may share its hourly limit with other work) and whenever GitHub says to wait.
// The first poll only notes where things are: nothing that happened before the poller started fires anything.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Between two polls, at least. */
export const POLL_MS = 5 * 60_000;
/** Hold off while fewer than this share of the hour's calls are left. */
export const QUOTA_FLOOR = 0.1;
/** The poller's state file, in the coordinator's state directory. */
export const POLL_STATE = 'automations-github.json';
/** A GET with the instance's token: conditional (If-None-Match), so an unchanged listing answers 304. */
export function githubGet(o) {
    const f = o.fetch ?? fetch;
    const api = o.api.replace(/\/+$/, '');
    return async (path, etag) => {
        const res = await f(`${api}${path}`, { headers: { authorization: `Bearer ${await o.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(etag ? { 'if-none-match': etag } : {}) } });
        const headers = {};
        res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        const json = res.status === 200 ? await res.json() : null;
        return { status: res.status, json, etag: res.headers.get('etag'), headers };
    };
}
const isBot = (u) => u?.type === 'Bot' || /\[bot\]$/.test(String(u?.login ?? ''));
const text = (title, body) => `${String(title ?? '')}\n\n${String(body ?? '')}`.trim();
export class GitHubEventsPoller {
    o;
    nextAt = 0;
    constructor(o) {
        this.o = o;
    }
    get file() {
        return join(this.o.stateDir, POLL_STATE);
    }
    read() {
        try {
            return JSON.parse(readFileSync(this.file, 'utf8'));
        }
        catch {
            return { started: false, eventsId: 0, issuesAt: '', commentsAt: '', etags: {} };
        }
    }
    write(s) {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
        renameSync(tmp, this.file);
    }
    /** Whether a poll is due (it never polls more often than POLL_MS, nor before a hold ends). */
    due() {
        return (this.o.now?.() ?? Date.now()) >= this.nextAt;
    }
    /** The events since the last poll (none on the first: it starts from now). Not due: none, and no call. */
    async poll() {
        const now = this.o.now?.() ?? Date.now();
        if (now < this.nextAt)
            return [];
        this.nextAt = now + POLL_MS;
        const s = this.read();
        const out = [];
        const base = `/repos/${this.o.repo}`;
        const call = async (key, path) => {
            const r = await this.o.get(path, s.etags[key] ?? null);
            if (r.etag)
                s.etags[key] = r.etag;
            const remaining = Number(r.headers['x-ratelimit-remaining']);
            const limit = Number(r.headers['x-ratelimit-limit']);
            const retry = Number(r.headers['retry-after']);
            let until = 0;
            if (Number.isFinite(retry) && retry > 0)
                until = now + retry * 1000;
            else if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0 && remaining < limit * QUOTA_FLOOR)
                until = Number(r.headers['x-ratelimit-reset']) * 1000 || now + 3600_000;
            if (until > now) {
                this.nextAt = Math.max(this.nextAt, until);
                this.o.held?.(Number.isFinite(retry) && retry > 0 ? 'GitHub asked to wait' : `under ${QUOTA_FLOOR * 100}% of the hour's GitHub calls left (${remaining} of ${limit})`, new Date(until).toISOString());
            }
            if (r.status === 304)
                return null;
            if (r.status !== 200)
                throw Object.assign(new Error(`GitHub ${r.status} on ${path}`), { status: r.status });
            return Array.isArray(r.json) ? r.json : [];
        };
        // Labels added and PRs merged, newest first: those after the last seen id.
        const events = await call('events', `${base}/issues/events?per_page=100`);
        if (events) {
            const fresh = events.filter((e) => Number(e.id) > s.eventsId);
            if (s.started)
                for (const e of fresh.reverse()) {
                    const issue = (e.issue ?? {});
                    const actor = (e.actor ?? {});
                    const at = String(e.created_at ?? new Date(now).toISOString());
                    if (e.event === 'labeled')
                        out.push({ name: 'issue.labeled', number: Number(issue.number), actor: String(actor.login ?? ''), byBot: isBot(actor), label: String(e.label?.name ?? ''), text: text(issue.title, issue.body), at, key: `event:${e.id}` });
                    else if (e.event === 'merged')
                        out.push({ name: 'pull_request.merged', number: Number(issue.number), actor: String(actor.login ?? ''), byBot: isBot(actor), text: text(issue.title, issue.body), at, key: `event:${e.id}` });
                }
            s.eventsId = Math.max(s.eventsId, ...events.map((e) => Number(e.id) || 0));
        }
        // Issues and PRs opened, newest first: those created after the last poll's newest.
        const issues = await call('issues', `${base}/issues?state=all&sort=created&direction=desc&per_page=50`);
        if (issues) {
            const fresh = issues.filter((i) => String(i.created_at ?? '') > s.issuesAt);
            if (s.started)
                for (const i of fresh.reverse()) {
                    const user = (i.user ?? {});
                    out.push({ name: i.pull_request ? 'pull_request.opened' : 'issue.opened', number: Number(i.number), actor: String(user.login ?? ''), byBot: isBot(user), text: text(i.title, i.body), at: String(i.created_at), key: `opened:${i.number}` });
                }
            s.issuesAt = [s.issuesAt, ...issues.map((i) => String(i.created_at ?? ''))].sort().at(-1);
        }
        // Comments, newest first: those created after the last poll's newest.
        const comments = await call('comments', `${base}/issues/comments?sort=created&direction=desc&per_page=50`);
        if (comments) {
            const fresh = comments.filter((c) => String(c.created_at ?? '') > s.commentsAt);
            if (s.started)
                for (const c of fresh.reverse()) {
                    const user = (c.user ?? {});
                    const n = Number(/\/issues\/(\d+)$/.exec(String(c.issue_url ?? ''))?.[1]);
                    if (n > 0)
                        out.push({ name: 'issue_comment.created', number: n, actor: String(user.login ?? ''), byBot: isBot(user), text: String(c.body ?? ''), at: String(c.created_at), key: `comment:${c.id}` });
                }
            s.commentsAt = [s.commentsAt, ...comments.map((c) => String(c.created_at ?? ''))].sort().at(-1);
        }
        s.started = true;
        this.write(s);
        return out;
    }
}
//# sourceMappingURL=github.js.map