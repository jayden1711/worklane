// The GitHub calls merge posts make (src/merge-posts.ts), one REST request each, with the instance's own token.
// Merge posts decide when to call: at most one of these per MERGE_POSTS_CALL_MS.
import type { MergePostsApi, MergePull } from '../merge-posts.js';

type Fetch = typeof fetch;

export class GitHubMergePostsApi implements MergePostsApi {
  constructor(
    private readonly repo: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: Fetch = fetch,
    private readonly api = 'https://api.github.com',
  ) {}

  private async json<T>(path: string, what: string): Promise<T> {
    const res = await this.fetchImpl(`${this.api.replace(/\/+$/, '')}${path}`, {
      headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} reading ${what}`);
    return (await res.json()) as T;
  }

  async commitPulls(sha: string): Promise<MergePull[]> {
    const prs = await this.json<GhPull[]>(`/repos/${this.repo}/commits/${sha}/pulls?per_page=100`, `the PRs of ${sha.slice(0, 8)}`);
    return prs.map(toPull);
  }

  async pull(n: number): Promise<MergePull> {
    return toPull(await this.json<GhPull>(`/repos/${this.repo}/pulls/${n}`, `PR #${n}`));
  }
}

interface GhPull {
  number: number;
  html_url: string;
  title?: string | null;
  body?: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  merged_by?: { login?: string } | null;
  base: { ref: string };
}

/** Only the login of who merged it is kept: never an email, or anything else about them. */
const toPull = (p: GhPull): MergePull => ({
  number: p.number,
  url: p.html_url,
  title: p.title ?? '',
  body: p.body ?? null,
  mergedAt: p.merged_at,
  mergeCommit: p.merge_commit_sha,
  mergedBy: p.merged_by?.login ?? null,
  base: p.base.ref,
});
