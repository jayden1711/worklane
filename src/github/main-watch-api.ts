// The GitHub calls the main watch makes (src/main-watch.ts), one REST request each, with the instance's own token.
// The watch decides when to call: at most one of these a minute.
import { roleFromPermission, validLogin, type Role } from '../dashboard-auth.js';
import type { CheckRunAt, MainWatchApi, MergedPull, StatusAt } from '../main-watch.js';

type Fetch = typeof fetch;

export class GitHubMainWatchApi implements MainWatchApi {
  constructor(
    private readonly repo: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: Fetch = fetch,
    private readonly api = 'https://api.github.com',
  ) {}

  private async get(path: string): Promise<Response> {
    return this.fetchImpl(`${this.api.replace(/\/+$/, '')}${path}`, {
      headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
  }

  private async json<T>(path: string, what: string): Promise<T> {
    const res = await this.get(path);
    if (!res.ok) throw new Error(`GitHub ${res.status} reading ${what}`);
    return (await res.json()) as T;
  }

  async protection(branch: string): Promise<'enforced' | 'none'> {
    const res = await this.get(`/repos/${this.repo}/branches/${encodeURIComponent(branch)}/protection`);
    // 404: no protection; 403: the plan has none to give (a private repo on GitHub Free), or we may not read it.
    if (res.status === 404 || res.status === 403) return 'none';
    if (!res.ok) throw new Error(`GitHub ${res.status} reading ${branch}'s protection`);
    return 'enforced';
  }

  async commitPulls(sha: string): Promise<MergedPull[]> {
    const prs = await this.json<GhPull[]>(`/repos/${this.repo}/commits/${sha}/pulls?per_page=100`, `the PRs of ${sha.slice(0, 8)}`);
    return prs.map(toPull);
  }

  async pull(n: number): Promise<MergedPull> {
    return toPull(await this.json<GhPull>(`/repos/${this.repo}/pulls/${n}`, `PR #${n}`));
  }

  async checkRuns(sha: string): Promise<CheckRunAt[]> {
    const r = await this.json<{ check_runs: { name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }[] }>(`/repos/${this.repo}/commits/${sha}/check-runs?filter=all&per_page=100`, `the check runs on ${sha.slice(0, 8)}`);
    return r.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, startedAt: c.started_at ?? null, completedAt: c.completed_at ?? null }));
  }

  async statuses(sha: string): Promise<StatusAt[]> {
    const res = await this.get(`/repos/${this.repo}/commits/${sha}/statuses?per_page=100`);
    // Statuses need their own permission; without it, there are just none to count.
    if (res.status === 403 || res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub ${res.status} reading the statuses on ${sha.slice(0, 8)}`);
    return ((await res.json()) as { context: string; state: string; created_at: string }[]).map((s) => ({ context: s.context, state: s.state, createdAt: s.created_at }));
  }

  async role(login: string): Promise<Role | null> {
    if (!validLogin(login)) return null;
    const res = await this.get(`/repos/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} reading @${login}'s permission`);
    const j = (await res.json()) as { permission?: unknown; role_name?: unknown };
    return roleFromPermission(j.role_name) ?? roleFromPermission(j.permission);
  }
}

interface GhPull {
  number: number;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  merged_by?: { login?: string; type?: string } | null;
  head: { sha: string };
  base: { ref: string };
}

const toPull = (p: GhPull): MergedPull => ({
  number: p.number,
  url: p.html_url,
  mergedAt: p.merged_at,
  mergeCommit: p.merge_commit_sha,
  mergedBy: p.merged_by?.login ?? null,
  mergedByBot: p.merged_by?.type === 'Bot' || /\[bot\]$/.test(p.merged_by?.login ?? ''),
  head: p.head.sha,
  base: p.base.ref,
});
