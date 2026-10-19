// GitHub Issues backlog over REST. Only the coordinator holds the token;
// agents never see it. Errors are classified (a 403 isn't "missing
// permission" unless it is).
import { execFileSync } from 'node:child_process';
import { redact, redactString, TRACKER } from '../events/redact.js';
import { classifyGitHubError } from '../github/errors.js';
import { BudgetPaused, budgetFor, SECONDARY_DEFAULT_S, type GitHubBudget } from '../github/budget.js';
import { noteGitHubOk } from '../github/seen.js';
import type { Backlog, CommitCheck, Issue, PrReview, PrReviewComment, PullRequest, RerunJobs } from './types.js';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(`GitHub ${status} ${kind}: ${message}`);
  }
}

export function ghToken(): string {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

type Fetch = typeof fetch;

/** How long one GitHub request may take: a request that hangs never holds the coordinator's tick (or its shutdown) for longer. */
export const REQUEST_TIMEOUT_MS = 30_000;

export class GitHubBacklog implements Backlog {
  constructor(
    readonly repo: string,
    private token: () => string | Promise<string> = ghToken,
    private fetchImpl: Fetch = fetch,
    private api = 'https://api.github.com',
    private budget: (token: string) => GitHubBudget = (t) => budgetFor(t),
  ) {}

  /**
   * `raw`: the response body as text (a log), not JSON. Everything sent is redacted first (events/redact.ts): a
   * comment, issue or pull request can carry command output, and on a public repo it's public.
   */
  private async req<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    body = body === undefined ? body : redact(body);
    // The machine's shared budget for this token (src/github/budget.ts): it decides when the call runs, never what it does.
    const token = await this.token();
    const budget = this.budget(token);
    const resource = path === '/graphql' ? 'graphql' : 'core';
    try {
      await budget.take('backlog', resource);
    } catch (e) {
      if (e instanceof BudgetPaused) throw new GitHubError(429, e.kind, e.message, e.retryAfter);
      throw e;
    }
    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const headers = Object.fromEntries(res.headers.entries());
    budget.observe(resource, headers);
    // GitHub took the token: the watchdog's sign that GitHub access works (src/watchdog/probes.ts, github_auth).
    if (res.ok) noteGitHubOk(this.token);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (raw && res.ok) return text as T;
    let json: unknown;
    try {
      json = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      if (res.ok) throw new GitHubError(res.status, 'bad_response', `not JSON: ${text.slice(0, 200)}`);
      json = text;
    }
    if (!res.ok) {
      const c = classifyGitHubError(res.status, headers, json);
      // A secondary limit stops every caller on the token, not just this one; so does a limit known only by Retry-After.
      if (c.kind === 'secondary_rate_limited' || (c.kind === 'rate_limited' && headers['x-ratelimit-reset'] === undefined && c.retryAfter)) budget.pause(c.kind, c.retryAfter ?? SECONDARY_DEFAULT_S);
      // A validation failure says why in errors[] ("Validation Failed" alone says nothing).
      const details = ((json as { errors?: { message?: string }[] } | undefined)?.errors ?? []).map((x) => x?.message).filter(Boolean);
      throw new GitHubError(res.status, c.kind, details.length ? `${c.message}: ${details.join('; ')}` : c.message, c.retryAfter);
    }
    return json as T;
  }

  private toIssue(i: GhIssue): Issue {
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      author: i.user?.login ?? '',
      assignees: (i.assignees ?? []).map((a) => a.login),
      state: i.state === 'closed' ? 'closed' : 'open',
    };
  }

  async list(label: string): Promise<Issue[]> {
    const out: Issue[] = [];
    for (let page = 1; page < 20; page++) {
      const batch = await this.req<GhIssue[]>('GET', `/repos/${this.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`);
      out.push(...batch.filter((i) => !i.pull_request).map((i) => this.toIssue(i)));
      if (batch.length < 100) break;
    }
    return out;
  }

  async openIssues(): Promise<Issue[]> {
    // ONE request, whatever the count (the shared rate limit): the 100 most recently updated open issues.
    const batch = await this.req<GhIssue[]>('GET', `/repos/${this.repo}/issues?state=open&sort=updated&direction=desc&per_page=100`);
    return batch.filter((i) => !i.pull_request).map((i) => this.toIssue(i));
  }

  async closedSince(since: string): Promise<number[]> {
    const out: number[] = [];
    for (let page = 1; page < 20; page++) {
      const batch = await this.req<GhIssue[]>('GET', `/repos/${this.repo}/issues?state=closed&since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=100&page=${page}`);
      out.push(...batch.filter((i) => !i.pull_request).map((i) => i.number));
      if (batch.length < 100) break;
    }
    return out;
  }

  async get(n: number): Promise<Issue> {
    return this.toIssue(await this.req<GhIssue>('GET', `/repos/${this.repo}/issues/${n}`));
  }

  async labelAdders(n: number, label: string): Promise<string[]> {
    const events = await this.req<{ event: string; label?: { name: string }; actor?: { login: string } }[]>('GET', `/repos/${this.repo}/issues/${n}/events?per_page=100`);
    return events.filter((e) => e.event === 'labeled' && e.label?.name === label && e.actor).map((e) => e.actor!.login);
  }

  async addLabels(n: number, labels: string[]) {
    await this.req('POST', `/repos/${this.repo}/issues/${n}/labels`, { labels });
  }

  async removeLabel(n: number, label: string) {
    try {
      await this.req('DELETE', `/repos/${this.repo}/issues/${n}/labels/${encodeURIComponent(label)}`);
    } catch (e) {
      if (!(e instanceof GitHubError && e.kind === 'not_found')) throw e;
    }
  }

  async setAssignees(n: number, logins: string[]) {
    await this.req('POST', `/repos/${this.repo}/issues/${n}/assignees`, { assignees: logins });
  }

  // Issue, comment and PR text drops identifiers too (emails, internal hosts, private IPs, paths: events/redact.ts);
  // req() redacts secrets from everything else it sends. A merge's commit message is left as written (its sign-off).
  async comment(n: number, body: string) {
    await this.req('POST', `/repos/${this.repo}/issues/${n}/comments`, { body: redactString(body, TRACKER) });
  }

  async comments(n: number) {
    const list = await this.req<{ user: { login: string } | null; body: string; created_at?: string }[]>('GET', `/repos/${this.repo}/issues/${n}/comments?per_page=100`);
    return list.map((c) => ({ author: c.user?.login ?? '', body: c.body ?? '', ...(c.created_at ? { at: c.created_at } : {}) }));
  }

  async close(n: number) {
    await this.req('PATCH', `/repos/${this.repo}/issues/${n}`, { state: 'closed', state_reason: 'completed' });
  }

  async createIssue(title: string, body: string, labels: string[]) {
    return (await this.req<{ number: number }>('POST', `/repos/${this.repo}/issues`, { title: redactString(title, TRACKER), body: redactString(body, TRACKER), labels })).number;
  }

  async openPr(head: string, base: string, title: string, body: string, opts: { draft?: boolean } = {}) {
    title = redactString(title, TRACKER);
    body = redactString(body, TRACKER);
    const owner = this.repo.split('/')[0];
    const open = await this.req<GhPull[]>('GET', `/repos/${this.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    if (open[0]) return { url: open[0].html_url, number: open[0].number, draft: Boolean(open[0].draft) };
    let pr: GhPull;
    try {
      pr = await this.req<GhPull>('POST', `/repos/${this.repo}/pulls`, { head, base, title, body, ...(opts.draft ? { draft: true } : {}) });
    } catch (e) {
      // Some plans don't offer drafts on private repos: open an ordinary PR instead.
      if (!(opts.draft && e instanceof GitHubError && e.status === 422 && /draft/i.test(e.message))) throw e;
      pr = await this.req<GhPull>('POST', `/repos/${this.repo}/pulls`, { head, base, title, body });
    }
    return { url: pr.html_url, number: pr.number, draft: Boolean(pr.draft) };
  }

  async pullRequest(n: number): Promise<PullRequest> {
    const p = await this.req<GhPull>('GET', `/repos/${this.repo}/pulls/${n}`);
    return {
      number: p.number,
      url: p.html_url,
      head: p.head.ref,
      headSha: p.head.sha,
      base: p.base?.ref ?? '',
      draft: Boolean(p.draft),
      state: p.merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
      title: p.title ?? '',
      ...(typeof p.body === 'string' ? { body: p.body } : {}),
      mergeable: p.mergeable ?? null,
      mergeableState: p.mergeable_state ?? 'unknown',
      ...(p.merged && typeof p.merge_commit_sha === 'string' && p.merge_commit_sha ? { mergeCommit: p.merge_commit_sha } : {}),
      ...(p.merged && p.merged_by?.login ? { mergedBy: { login: p.merged_by.login, bot: p.merged_by.type === 'Bot' || /\[bot\]$/.test(p.merged_by.login), ...(Number.isSafeInteger(p.merged_by.id) ? { id: p.merged_by.id! } : {}) } } : {}),
      ...(p.merged && typeof p.merged_at === 'string' && p.merged_at ? { mergedAt: p.merged_at } : {}),
      ...(typeof p.additions === 'number' && typeof p.deletions === 'number'
        ? { stats: { additions: p.additions, deletions: p.deletions, files: p.changed_files ?? 0, comments: (p.comments ?? 0) + (p.review_comments ?? 0) } }
        : {}),
    };
  }

  async mergePr(n: number, sha: string, title: string, body?: string): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
    try {
      const r = await this.req<{ sha: string; merged: boolean; message?: string }>('PUT', `/repos/${this.repo}/pulls/${n}/merge`, { merge_method: 'merge', sha, commit_title: title, ...(body !== undefined ? { commit_message: body } : {}) });
      return r.merged ? { ok: true, sha: r.sha } : { ok: false, why: r.message ?? 'not merged' };
    } catch (e) {
      // 405: not mergeable now; 409: the head moved off `sha`. Both are a "not now", never a merge of something else.
      if (e instanceof GitHubError && (e.status === 405 || e.status === 409 || e.status === 422)) return { ok: false, why: e.message };
      throw e;
    }
  }

  async checks(sha: string): Promise<CommitCheck[]> {
    const out: CommitCheck[] = [];
    for (let page = 1; page < 10; page++) {
      const r = await this.req<{ check_runs: { id: number; name: string; status: string; conclusion: string | null; html_url?: string }[] }>('GET', `/repos/${this.repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`);
      out.push(...r.check_runs.map((c) => ({ name: c.name, source: 'check_run' as const, status: c.status, conclusion: c.conclusion, id: c.id, ...(c.html_url ? { url: c.html_url } : {}) })));
      if (r.check_runs.length < 100) break;
    }
    // Commit statuses need their own permission; without it (403) or with none (404), there are just no statuses.
    let statuses: { context: string; state: string; target_url?: string | null }[] = [];
    try {
      statuses = (await this.req<{ statuses: typeof statuses }>('GET', `/repos/${this.repo}/commits/${sha}/status`)).statuses;
    } catch (e) {
      if (!(e instanceof GitHubError && (e.status === 403 || e.status === 404))) throw e;
    }
    for (const s of statuses) {
      out.push({ name: s.context, source: 'status', status: s.state === 'pending' ? 'pending' : 'completed', conclusion: s.state === 'pending' ? null : s.state === 'success' ? 'success' : 'failure', ...(s.target_url ? { url: s.target_url } : {}) });
    }
    return out;
  }

  async requestReview(n: number, logins: string[]) {
    await this.req('POST', `/repos/${this.repo}/pulls/${n}/requested_reviewers`, { reviewers: logins });
  }

  async jobLog(id: number): Promise<{ ok: true; text: string } | { ok: false; why: 'forbidden' | 'not_found' }> {
    // GitHub answers with a redirect to the log file; fetch follows it (and drops the token on the way).
    try {
      return { ok: true, text: await this.req<string>('GET', `/repos/${this.repo}/actions/jobs/${id}/logs`, undefined, true) };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 403 && e.kind !== 'rate_limited' && e.kind !== 'secondary_rate_limited') return { ok: false, why: 'forbidden' };
      if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) return { ok: false, why: 'not_found' };
      throw e;
    }
  }

  async rerunFailedJobs(checkRunIds: number[]): Promise<Map<number, RerunJobs>> {
    const out = new Map<number, RerunJobs>();
    const refused = (e: unknown): RerunJobs | null => {
      if (e instanceof GitHubError && e.status === 403 && e.kind !== 'rate_limited' && e.kind !== 'secondary_rate_limited') return { ok: false, why: 'forbidden', detail: e.message.slice(0, 300) };
      if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) return { ok: false, why: 'not_found', detail: e.message.slice(0, 300) };
      return null;
    };
    // A job's workflow run (GET /actions/jobs/{id}), then each run's failed jobs re-run once.
    const runs = new Map<number, number[]>();
    for (const id of new Set(checkRunIds)) {
      try {
        const job = await this.req<{ run_id: number }>('GET', `/repos/${this.repo}/actions/jobs/${id}`);
        runs.set(job.run_id, [...(runs.get(job.run_id) ?? []), id]);
      } catch (e) {
        const r = refused(e);
        if (!r) throw e;
        out.set(id, r);
      }
    }
    for (const [run, ids] of runs) {
      let r: RerunJobs = { ok: true, run };
      try {
        await this.req<unknown>('POST', `/repos/${this.repo}/actions/runs/${run}/rerun-failed-jobs`, {});
      } catch (e) {
        const x = refused(e);
        if (!x) throw e;
        r = x;
      }
      for (const id of ids) out.set(id, r);
    }
    return out;
  }

  async markReady(n: number) {
    const p = await this.req<GhPull>('GET', `/repos/${this.repo}/pulls/${n}`);
    if (!p.draft) return;
    const r = await this.req<{ errors?: { message: string }[] }>('POST', '/graphql', { query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }', variables: { id: p.node_id } });
    if (r.errors?.length) throw new GitHubError(200, 'graphql', r.errors.map((x) => x.message).join('; '));
  }

  async reviews(n: number): Promise<PrReview[]> {
    const list = await this.req<{ id: number; user: { login: string } | null; state: string; body: string | null; submitted_at?: string }[]>('GET', `/repos/${this.repo}/pulls/${n}/reviews?per_page=100`);
    return list.map((r) => ({ id: r.id, author: r.user?.login ?? '', state: r.state, body: r.body ?? '', at: r.submitted_at ?? '' }));
  }

  async reviewComments(n: number): Promise<PrReviewComment[]> {
    const list = await this.req<{ id: number; pull_request_review_id?: number | null; user: { login: string } | null; body: string | null; path: string; line?: number | null; original_line?: number | null; created_at?: string }[]>('GET', `/repos/${this.repo}/pulls/${n}/comments?per_page=100`);
    return list.map((c) => ({ id: c.id, review: c.pull_request_review_id ?? null, author: c.user?.login ?? '', body: c.body ?? '', path: c.path, line: c.line ?? c.original_line ?? null, at: c.created_at ?? '' }));
  }

  async closedBy(n: number): Promise<string | null> {
    const i = await this.req<{ state: string; closed_by?: { login: string } | null }>('GET', `/repos/${this.repo}/issues/${n}`);
    return i.state === 'closed' ? (i.closed_by?.login ?? null) : null;
  }

  async ensureLabels(labels: { name: string; color: string; description: string }[]): Promise<string[]> {
    const existing = new Set((await this.req<{ name: string }[]>('GET', `/repos/${this.repo}/labels?per_page=100`)).map((l) => l.name));
    const created: string[] = [];
    for (const l of labels) {
      if (existing.has(l.name)) continue;
      await this.req('POST', `/repos/${this.repo}/labels`, l);
      created.push(l.name);
    }
    return created;
  }
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: (string | { name: string })[];
  user: { login: string } | null;
  assignees?: { login: string }[];
  state: string;
  pull_request?: unknown;
}

interface GhPull {
  number: number;
  html_url: string;
  node_id: string;
  head: { ref: string; sha: string };
  base?: { ref: string };
  draft?: boolean;
  state: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  merged_by?: { login?: string; type?: string; id?: number } | null;
  merged_at?: string | null;
  title?: string;
  body?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  // The single-PR endpoint's counts (absent from list endpoints).
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  review_comments?: number;
}
