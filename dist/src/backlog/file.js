// A file-backed backlog with GitHub's semantics, for tests, the example
// project, and running without a tracker. One JSON file holds issues and
// their label history.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactString } from '../events/redact.js';
export class FileBacklog {
    path;
    actor;
    constructor(path, actor = 'coordinator') {
        this.path = path;
        this.actor = actor;
    }
    load() {
        if (!existsSync(this.path))
            return { issues: [], labels: [] };
        return JSON.parse(readFileSync(this.path, 'utf8'));
    }
    save(s) {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(s, null, 2));
    }
    edit(n, fn) {
        const s = this.load();
        const i = s.issues.find((x) => x.number === n);
        if (!i)
            throw new Error(`issue #${n} not found`);
        fn(i);
        this.save(s);
    }
    /** Test/seed helper: open an issue as `author`, optionally labeling it as `labeler`. */
    open(issue) {
        const s = this.load();
        const number = (s.issues.at(-1)?.number ?? 0) + 1;
        const labels = issue.labels ?? [];
        s.issues.push({
            number,
            title: issue.title,
            body: issue.body,
            author: issue.author,
            assignees: issue.assignees ?? [],
            state: 'open',
            labels,
            labelEvents: labels.map((label) => ({ label, actor: issue.labeler ?? issue.author })),
            comments: [],
        });
        this.save(s);
        return number;
    }
    /** Test helper: a human edits an issue's body. */
    editBody(n, body) {
        this.edit(n, (i) => {
            i.body = body;
        });
    }
    /** Test helper: a human comments on an issue (now, or at `at`). */
    humanComment(n, author, body, at = new Date().toISOString()) {
        this.edit(n, (i) => i.comments.push({ author, body, at }));
    }
    async list(label) {
        return this.load().issues.filter((i) => !i.pr && i.state === 'open' && i.labels.includes(label)).map(strip);
    }
    async openIssues() {
        return this.load().issues.filter((i) => !i.pr && i.state === 'open').map(strip);
    }
    /** No update times here: every closed issue (a superset, as the contract allows). */
    async closedSince(_since) {
        return this.load().issues.filter((i) => !i.pr && i.state === 'closed').map((i) => i.number);
    }
    async get(n) {
        const i = this.load().issues.find((x) => x.number === n);
        if (!i)
            throw new Error(`issue #${n} not found`);
        return strip(i);
    }
    async labelAdders(n, label) {
        return (this.load().issues.find((x) => x.number === n)?.labelEvents ?? []).filter((e) => e.label === label).map((e) => e.actor);
    }
    async addLabels(n, labels) {
        this.edit(n, (i) => {
            for (const l of labels)
                if (!i.labels.includes(l)) {
                    i.labels.push(l);
                    i.labelEvents.push({ label: l, actor: this.actor });
                }
        });
    }
    async removeLabel(n, label) {
        this.edit(n, (i) => (i.labels = i.labels.filter((l) => l !== label)));
    }
    async setAssignees(n, logins) {
        this.edit(n, (i) => (i.assignees = [...new Set([...i.assignees, ...logins])]));
    }
    // What the harness writes is redacted first (events/redact.ts), as the GitHub backlog does for everything it sends.
    async comment(n, body) {
        this.edit(n, (i) => i.comments.push({ author: this.actor, body: redactString(body), at: new Date().toISOString() }));
    }
    async comments(n) {
        return this.load().issues.find((x) => x.number === n)?.comments ?? [];
    }
    async close(n) {
        this.edit(n, (i) => (i.state = 'closed'));
    }
    async createIssue(title, body, labels) {
        return this.open({ title: redactString(title), body: redactString(body), author: this.actor, labels });
    }
    async openPr(head, base, title, body, opts = {}) {
        title = redactString(title);
        body = redactString(body);
        const s = this.load();
        const existing = s.issues.find((i) => i.pr?.head === head && i.state === 'open');
        if (existing)
            return { url: existing.pr.url, number: existing.number, draft: existing.pr.draft };
        const number = (s.issues.at(-1)?.number ?? 0) + 1;
        const url = `file://pr/${number}`;
        s.issues.push({ number, title, body, author: this.actor, assignees: [], state: 'open', labels: [], labelEvents: [], comments: [], pr: { head, base, url, headSha: opts.headSha ?? '', draft: Boolean(opts.draft), merged: false } });
        this.save(s);
        return { url, number, draft: Boolean(opts.draft) };
    }
    async pullRequest(n) {
        const i = this.load().issues.find((x) => x.number === n && x.pr);
        if (!i)
            throw new Error(`pull request #${n} not found`);
        const state = i.pr.mergeableState ?? 'clean';
        const stats = i.pr.stats ? { stats: { ...i.pr.stats, comments: i.comments.length } } : {};
        return { number: n, url: i.pr.url, head: i.pr.head, headSha: i.pr.headSha, base: i.pr.base, draft: i.pr.draft, state: i.pr.merged ? 'merged' : i.state, title: i.title, body: i.body, mergeable: state === 'unknown' ? null : state !== 'dirty', mergeableState: state, ...stats };
    }
    /** Test hook: re-running a check run's failed Actions jobs (a file backlog has no Actions: absent, nothing re-runs). */
    rerunFailedJobs;
    /** Test hook: how a merge happens (e.g. a real merge commit on a test remote); returns the merge commit. */
    mergeWith;
    async mergePr(n, sha, title, body) {
        const i = this.load().issues.find((x) => x.number === n && x.pr);
        if (!i || i.state !== 'open')
            return { ok: false, why: 'not open' };
        if (i.pr.headSha !== sha)
            return { ok: false, why: `head is ${i.pr.headSha}, not ${sha}` };
        if ((i.pr.mergeableState ?? 'clean') === 'dirty')
            return { ok: false, why: 'merge conflict' };
        // Strict branch protection: GitHub's 405 for a branch behind its base.
        if (i.pr.mergeableState === 'behind')
            return { ok: false, why: 'Head branch is not up to date with the base branch' };
        const mergeSha = this.mergeWith ? this.mergeWith({ number: n, head: i.pr.head, headSha: sha, base: i.pr.base }) : sha.replace(/^./, 'f');
        this.edit(n, (x) => {
            Object.assign(x.pr, { merged: true, mergeSha, mergeTitle: title, ...(body !== undefined ? { mergeBody: body } : {}) });
            x.state = 'closed';
        });
        return { ok: true, sha: mergeSha };
    }
    async checks(sha) {
        return this.load().checks?.[sha] ?? [];
    }
    async markReady(n) {
        this.edit(n, (i) => {
            if (i.pr)
                i.pr.draft = false;
        });
    }
    async requestReview(n, logins) {
        this.edit(n, (i) => {
            if (i.pr)
                i.pr.reviewers = [...new Set([...(i.pr.reviewers ?? []), ...logins])];
        });
    }
    async jobLog(id) {
        const log = this.load().logs?.[String(id)];
        if (log === undefined)
            return { ok: false, why: 'not_found' };
        if (log === 403)
            return { ok: false, why: 'forbidden' };
        return { ok: true, text: log };
    }
    /** Test helper: a job's log, or 403 for a credential that can't read Actions logs. */
    setJobLog(id, log) {
        const s = this.load();
        (s.logs ??= {})[String(id)] = log;
        this.save(s);
    }
    /** Test helper: the pull requests, oldest first. */
    prs() {
        return this.load()
            .issues.filter((i) => i.pr)
            .map((i) => ({ number: i.number, title: i.title, body: i.body, labels: i.labels, state: i.state, comments: i.comments, ...i.pr }));
    }
    /** Test helper: change a pull request as GitHub would (a push moves headSha; a merge or close ends it). */
    setPr(n, patch) {
        this.edit(n, (i) => {
            const { state, ...rest } = patch;
            Object.assign(i.pr, rest);
            if (state)
                i.state = state;
            if (patch.merged)
                i.state = 'closed';
        });
    }
    /** Test helper: a review submitted on a pull request. */
    addReview(n, r) {
        this.edit(n, (i) => {
            const list = (i.pr.reviews ??= []);
            list.push({ id: n * 1000 + list.length + 1, at: r.at ?? new Date().toISOString(), author: r.author, state: r.state, body: r.body });
        });
    }
    async reviews(n) {
        return this.load().issues.find((x) => x.number === n)?.pr?.reviews ?? [];
    }
    /** Test helper: an inline comment in a submitted review (`review`: its id, from addReview). */
    addReviewComment(n, c) {
        this.edit(n, (i) => {
            const list = (i.pr.reviewComments ??= []);
            list.push({ id: n * 100_000 + list.length + 1, at: c.at ?? new Date().toISOString(), review: c.review, author: c.author, body: c.body, path: c.path, line: c.line });
        });
    }
    async reviewComments(n) {
        return this.load().issues.find((x) => x.number === n)?.pr?.reviewComments ?? [];
    }
    async closedBy(n) {
        const i = this.load().issues.find((x) => x.number === n);
        return i && i.state === 'closed' ? (i.pr?.closedBy ?? null) : null;
    }
    /** Test helper: the checks GitHub reports on a commit. */
    setChecks(sha, checks) {
        const s = this.load();
        (s.checks ??= {})[sha] = checks;
        this.save(s);
    }
    async ensureLabels(labels) {
        const s = this.load();
        const created = labels.map((l) => l.name).filter((l) => !s.labels.includes(l));
        s.labels.push(...created);
        this.save(s);
        return created;
    }
}
function strip(i) {
    const { labelEvents: _e, comments: _c, pr: _p, ...rest } = i;
    return rest;
}
//# sourceMappingURL=file.js.map