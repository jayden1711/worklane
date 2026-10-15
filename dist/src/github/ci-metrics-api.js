/** A job log is read up to this many characters (its end, where a runner prints its results). */
export const JOB_LOG_CHARS = 20_000_000;
export class GitHubCiMetricsApi {
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
    async get(path, what) {
        // A job log redirects to a signed download URL on another host; fetch drops the token on that cross-origin hop.
        const res = await this.fetchImpl(`${this.api.replace(/\/+$/, '')}${path}`, {
            headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
        if (!res.ok)
            throw new Error(`GitHub ${res.status} reading ${what}`);
        return res;
    }
    async checkRuns(sha) {
        const r = (await (await this.get(`/repos/${this.repo}/commits/${sha}/check-runs?filter=all&per_page=100`, `the check runs on ${sha.slice(0, 8)}`)).json());
        return r.check_runs.map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, startedAt: c.started_at ?? null, completedAt: c.completed_at ?? null, app: c.app?.slug ?? null }));
    }
    async jobLog(id) {
        const text = await (await this.get(`/repos/${this.repo}/actions/jobs/${id}/logs`, `the log of job ${id}`)).text();
        return text.length > JOB_LOG_CHARS ? text.slice(-JOB_LOG_CHARS) : text;
    }
}
//# sourceMappingURL=ci-metrics-api.js.map