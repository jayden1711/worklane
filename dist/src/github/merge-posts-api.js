export class GitHubMergePostsApi {
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
    async json(path, what) {
        const res = await this.fetchImpl(`${this.api.replace(/\/+$/, '')}${path}`, {
            headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
        if (!res.ok)
            throw new Error(`GitHub ${res.status} reading ${what}`);
        return (await res.json());
    }
    async commitPulls(sha) {
        const prs = await this.json(`/repos/${this.repo}/commits/${sha}/pulls?per_page=100`, `the PRs of ${sha.slice(0, 8)}`);
        return prs.map(toPull);
    }
    async pull(n) {
        return toPull(await this.json(`/repos/${this.repo}/pulls/${n}`, `PR #${n}`));
    }
}
/** Only the login of who merged it is kept: never an email, or anything else about them. */
const toPull = (p) => ({
    number: p.number,
    url: p.html_url,
    title: p.title ?? '',
    body: p.body ?? null,
    mergedAt: p.merged_at,
    mergeCommit: p.merge_commit_sha,
    mergedBy: p.merged_by?.login ?? null,
    base: p.base.ref,
});
//# sourceMappingURL=merge-posts-api.js.map