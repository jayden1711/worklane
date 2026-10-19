// The GitHub calls the main watch makes (src/main-watch.ts), one REST request each, with the instance's own token.
// The watch decides when to call: at most one of these a minute.
import { roleFromPermission, validLogin, type Role } from '../dashboard-auth.js';
import type { CheckRunAt, Compared, MainWatchApi, MergedPull, StatusAt, WorkflowAt } from '../main-watch.js';
import type { WorkflowSource } from '../check-source.js';

/** Pages of 100 check runs or statuses read for one commit (#727); past them the merge isn't judged yet. */
const PAGES_MAX = 10;

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

  /** How far `head` is ahead of and behind `base` (one commit listed at most: only the counts are read). */
  async compare(base: string, head: string): Promise<Compared> {
    const r = await this.json<{ status: string; ahead_by: number; behind_by: number }>(`/repos/${this.repo}/compare/${base}...${head}?per_page=1`, `the compare of ${base.slice(0, 8)}...${head.slice(0, 8)}`);
    return { status: r.status, aheadBy: r.ahead_by, behindBy: r.behind_by };
  }

  /**
   * The check runs on `sha`: the first page of 100 as main read it, then (#727) every later page while a page is full,
   * whatever total_count says, marked `extra` (only a pinned name is judged with them). Past PAGES_MAX pages it throws:
   * a run unread could be a pinned check's failure, so the merge isn't judged yet (the watch asks again).
   */
  async checkRuns(sha: string): Promise<CheckRunAt[]> {
    type Run = { id?: number; html_url?: string | null; name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null; app?: { id?: number } | null; check_suite?: { id?: number } | null };
    const out: CheckRunAt[] = [];
    for (let page = 1; ; page++) {
      if (page > PAGES_MAX) throw new Error(`more than ${PAGES_MAX} pages of check runs on ${sha.slice(0, 8)}: not judged`);
      const r = await this.json<{ check_runs: Run[] }>(`/repos/${this.repo}/commits/${sha}/check-runs?filter=all&per_page=100${page > 1 ? `&page=${page}` : ''}`, `the check runs on ${sha.slice(0, 8)}`);
      out.push(
        ...r.check_runs.map((c) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          startedAt: c.started_at ?? null,
          completedAt: c.completed_at ?? null,
          ...(typeof c.id === 'number' ? { id: c.id } : {}),
          ...(typeof c.html_url === 'string' ? { url: c.html_url } : {}),
          ...(typeof c.app?.id === 'number' ? { app: c.app.id } : {}),
          ...(typeof c.check_suite?.id === 'number' ? { suite: c.check_suite.id } : {}),
          ...(page > 1 ? { extra: true as const } : {}),
        })),
      );
      if (r.check_runs.length < 100) return out;
    }
  }

  /** #727: the Actions workflow runs for `sha` (one page of 100) by check suite id; null when Actions can't be read. */
  async runSources(sha: string): Promise<Record<string, WorkflowSource> | null> {
    const res = await this.get(`/repos/${this.repo}/actions/runs?head_sha=${sha}&per_page=100`);
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} reading the workflow runs on ${sha.slice(0, 8)}`);
    const out: Record<string, WorkflowSource> = {};
    for (const w of ((await res.json()) as { workflow_runs?: { id?: number; html_url?: string; check_suite_id?: number; path?: string; head_sha?: string; repository?: { full_name?: string } }[] }).workflow_runs ?? []) {
      if (typeof w.id === 'number' && typeof w.html_url === 'string' && typeof w.check_suite_id === 'number' && typeof w.path === 'string' && typeof w.head_sha === 'string' && typeof w.repository?.full_name === 'string') out[String(w.check_suite_id)] = { run: w.id, url: w.html_url, path: w.path, repo: w.repository.full_name, sha: w.head_sha };
    }
    return out;
  }

  /** The statuses on `sha`, newest first: the first page of 100 as main read it, then (#727) later pages as checkRuns reads them. */
  async statuses(sha: string): Promise<StatusAt[]> {
    const out: StatusAt[] = [];
    for (let page = 1; ; page++) {
      if (page > PAGES_MAX) throw new Error(`more than ${PAGES_MAX} pages of statuses on ${sha.slice(0, 8)}: not judged`);
      const res = await this.get(`/repos/${this.repo}/commits/${sha}/statuses?per_page=100${page > 1 ? `&page=${page}` : ''}`);
      // Statuses need their own permission; without it, there are just none to count.
      if (res.status === 403 || res.status === 404) return out;
      if (!res.ok) throw new Error(`GitHub ${res.status} reading the statuses on ${sha.slice(0, 8)}`);
      const list = (await res.json()) as { context: string; state: string; created_at: string }[];
      out.push(...list.map((s) => ({ context: s.context, state: s.state, createdAt: s.created_at, ...(page > 1 ? { extra: true as const } : {}) })));
      if (list.length < 100) return out;
    }
  }

  async role(login: string): Promise<Role | null> {
    if (!validLogin(login)) return null;
    const res = await this.get(`/repos/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} reading @${login}'s permission`);
    const j = (await res.json()) as { permission?: unknown; role_name?: unknown };
    return roleFromPermission(j.role_name) ?? roleFromPermission(j.permission);
  }

  /**
   * The repo's Actions workflows (one page of 100): each one's name, file and state. Null when the token may not read
   * Actions (403) or GitHub has none to show (404): the caller then says nothing about them.
   */
  async workflows(): Promise<WorkflowAt[] | null> {
    const res = await this.get(`/repos/${this.repo}/actions/workflows?per_page=100`);
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} reading the Actions workflows`);
    const j = (await res.json()) as { workflows?: unknown };
    if (!Array.isArray(j.workflows)) return null;
    return (j.workflows as { name?: unknown; path?: unknown; state?: unknown }[]).flatMap((w) => (w && typeof w.name === 'string' && typeof w.path === 'string' && typeof w.state === 'string' ? [{ name: w.name, path: w.path, state: w.state }] : []));
  }

  /**
   * Who pushed `sha`: the actor of the branch's push (or force-push) that ended at it, from the repo's activity;
   * else the commit's GitHub author. Logins only (an email is never read). Null when neither answers.
   */
  async pusher(branch: string, sha: string): Promise<{ login: string; from: 'activity' | 'commit' } | null> {
    const ok = (l: unknown): l is string => typeof l === 'string' && validLogin(l);
    try {
      const res = await this.get(`/repos/${this.repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=50`);
      if (res.ok) {
        const list = (await res.json()) as { after?: string; activity_type?: string; actor?: { login?: unknown } | null }[];
        const hit = Array.isArray(list) ? list.find((a) => a.after === sha && (a.activity_type === 'push' || a.activity_type === 'force_push')) : undefined;
        if (ok(hit?.actor?.login)) return { login: hit.actor.login, from: 'activity' };
      }
    } catch {
      // the commit's author, below
    }
    try {
      const res = await this.get(`/repos/${this.repo}/commits/${sha}`);
      if (!res.ok) return null;
      const c = (await res.json()) as { author?: { login?: unknown } | null; committer?: { login?: unknown } | null };
      const login = ok(c.author?.login) ? c.author.login : ok(c.committer?.login) ? c.committer.login : null;
      return login ? { login, from: 'commit' } : null;
    } catch {
      return null;
    }
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
  commits?: number;
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
  ...(typeof p.commits === 'number' ? { commits: p.commits } : {}),
});
