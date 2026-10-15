// The GitHub calls the main watch makes (src/main-watch.ts), one REST request each, with the instance's own token.
// The watch decides when to call: at most one of these a minute.
import { roleFromPermission, validLogin } from '../dashboard-auth.js';
export class GitHubMainWatchApi {
    repo;
    token;
    fetchImpl;
    api;
    constructor(repo, token, fetchImpl = fetch, api = 'https://api.github.com') {
        this.repo = repo;
        this.token = token;
        this.fetchImpl = fetchImpl;
        this.api = api;
    }
    async get(path) {
        return this.fetchImpl(`${this.api.replace(/\/+$/, '')}${path}`, {
            headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
    }
    async json(path, what) {
        const res = await this.get(path);
        if (!res.ok)
            throw new Error(`GitHub ${res.status} reading ${what}`);
        return (await res.json());
    }
    async protection(branch) {
        const res = await this.get(`/repos/${this.repo}/branches/${encodeURIComponent(branch)}/protection`);
        // 404: no protection; 403: the plan has none to give (a private repo on GitHub Free), or we may not read it.
        if (res.status === 404 || res.status === 403)
            return 'none';
        if (!res.ok)
            throw new Error(`GitHub ${res.status} reading ${branch}'s protection`);
        return 'enforced';
    }
    async commitPulls(sha) {
        const prs = await this.json(`/repos/${this.repo}/commits/${sha}/pulls?per_page=100`, `the PRs of ${sha.slice(0, 8)}`);
        return prs.map(toPull);
    }
    async pull(n) {
        return toPull(await this.json(`/repos/${this.repo}/pulls/${n}`, `PR #${n}`));
    }
    /** How far `head` is ahead of and behind `base` (one commit listed at most: only the counts are read). */
    async compare(base, head) {
        const r = await this.json(`/repos/${this.repo}/compare/${base}...${head}?per_page=1`, `the compare of ${base.slice(0, 8)}...${head.slice(0, 8)}`);
        return { status: r.status, aheadBy: r.ahead_by, behindBy: r.behind_by };
    }
    async checkRuns(sha) {
        const r = await this.json(`/repos/${this.repo}/commits/${sha}/check-runs?filter=all&per_page=100`, `the check runs on ${sha.slice(0, 8)}`);
        return r.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, startedAt: c.started_at ?? null, completedAt: c.completed_at ?? null }));
    }
    async statuses(sha) {
        const res = await this.get(`/repos/${this.repo}/commits/${sha}/statuses?per_page=100`);
        // Statuses need their own permission; without it, there are just none to count.
        if (res.status === 403 || res.status === 404)
            return [];
        if (!res.ok)
            throw new Error(`GitHub ${res.status} reading the statuses on ${sha.slice(0, 8)}`);
        return (await res.json()).map((s) => ({ context: s.context, state: s.state, createdAt: s.created_at }));
    }
    async role(login) {
        if (!validLogin(login))
            return null;
        const res = await this.get(`/repos/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`);
        if (res.status === 404)
            return null;
        if (!res.ok)
            throw new Error(`GitHub ${res.status} reading @${login}'s permission`);
        const j = (await res.json());
        return roleFromPermission(j.role_name) ?? roleFromPermission(j.permission);
    }
    /**
     * Who pushed `sha`: the actor of the branch's push (or force-push) that ended at it, from the repo's activity;
     * else the commit's GitHub author. Logins only (an email is never read). Null when neither answers.
     */
    async pusher(branch, sha) {
        const ok = (l) => typeof l === 'string' && validLogin(l);
        try {
            const res = await this.get(`/repos/${this.repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=50`);
            if (res.ok) {
                const list = (await res.json());
                const hit = Array.isArray(list) ? list.find((a) => a.after === sha && (a.activity_type === 'push' || a.activity_type === 'force_push')) : undefined;
                if (ok(hit?.actor?.login))
                    return { login: hit.actor.login, from: 'activity' };
            }
        }
        catch {
            // the commit's author, below
        }
        try {
            const res = await this.get(`/repos/${this.repo}/commits/${sha}`);
            if (!res.ok)
                return null;
            const c = (await res.json());
            const login = ok(c.author?.login) ? c.author.login : ok(c.committer?.login) ? c.committer.login : null;
            return login ? { login, from: 'commit' } : null;
        }
        catch {
            return null;
        }
    }
}
const toPull = (p) => ({
    number: p.number,
    url: p.html_url,
    mergedAt: p.merged_at,
    mergeCommit: p.merge_commit_sha,
    mergedBy: p.merged_by?.login ?? null,
    mergedByBot: p.merged_by?.type === 'Bot' || /\[bot\]$/.test(p.merged_by?.login ?? ''),
    head: p.head.sha,
    base: p.base.ref,
    ...(typeof p.commits === 'number' ? { commits: p.commits } : {}),
});
//# sourceMappingURL=main-watch-api.js.map