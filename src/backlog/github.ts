// GitHub Issues backlog over REST. Only the coordinator holds the token;
// agents never see it. Errors are classified (a 403 isn't "missing
// permission" unless it is).
import { execFileSync } from 'node:child_process';
import { redact, redactString, TRACKER } from '../events/redact.js';
import { classifyGitHubError } from '../github/errors.js';
import { BudgetPaused, budgetFor, SECONDARY_DEFAULT_S, type GitHubBudget } from '../github/budget.js';
import { noteGitHubOk } from '../github/seen.js';
import type { Backlog, CommitCheck, Issue, PrReview, PrReviewComment, PullRequest, RerunJobs } from './types.js';
import { ACTIONS_APP_ID, githubCheckApps, type GithubCheckApps, type WorkflowSource } from '../check-source.js';

/** GitHub's default page size for a commit's combined status (the first page main read is that size). */
const STATUS_PAGE_DEFAULT = 30;
/** Pages of the combined status read for one commit (#727); past them it isn't judged. */
const STATUS_PAGES_MAX = 10;

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
    const suites = new Map<CommitCheck, number>();
    for (let page = 1; page < 10; page++) {
      const r = await this.req<{ check_runs: { id: number; name: string; status: string; conclusion: string | null; html_url?: string; app?: { id?: number; slug?: string } | null; check_suite?: { id?: number } | null }[] }>('GET', `/repos/${this.repo}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`);
      for (const c of r.check_runs) {
        const app = c.app?.id;
        const check: CommitCheck = { name: c.name, source: 'check_run', status: c.status, conclusion: c.conclusion, id: c.id, ...(c.html_url ? { url: c.html_url } : {}), ...(typeof app === 'number' ? { app } : {}) };
        // An Actions run is told by its App's id, as the main watch tells it (src/check-source.ts ACTIONS_APP_ID).
        if (app === ACTIONS_APP_ID && typeof c.check_suite?.id === 'number') suites.set(check, c.check_suite.id);
        out.push(check);
      }
      if (r.check_runs.length < 100) break;
    }
    // #727: which workflow run, in which repo and for which commit, posted each Actions check (its suite's run).
    if (suites.size) {
      if (![...suites.values()].every((s) => this.suiteRuns.has(s))) await this.workflowRuns(sha);
      for (const [check, suite] of suites) check.workflow = this.suiteRuns.get(suite) ?? null;
    }
    // Commit statuses need their own permission; without it (403) or with none (404), there are just no statuses.
    let statuses: { context: string; state: string; target_url?: string | null; extra?: true }[] = [];
    try {
      statuses = await this.statusPages(sha);
    } catch (e) {
      if (!(e instanceof GitHubError && (e.status === 403 || e.status === 404))) throw e;
    }
    for (const s of statuses) {
      out.push({ name: s.context, source: 'status', status: s.state === 'pending' ? 'pending' : 'completed', conclusion: s.state === 'pending' ? null : s.state === 'success' ? 'success' : 'failure', ...(s.target_url ? { url: s.target_url } : {}), ...(s.extra ? { extra: true as const } : {}) });
    }
    return out;
  }

  /**
   * The combined status's contexts on `sha`: the first page as main read it (GitHub's default page size), then, #727,
   * every later page while a page is full and total_count doesn't say it was the last (a page with no total_count is
   * never taken as the last), marked `extra` (only a pinned name is judged with them). Past STATUS_PAGES_MAX pages it
   * throws: a status unread could be a pinned check's failure, so the commit isn't judged (it waits).
   */
  private async statusPages(sha: string): Promise<{ context: string; state: string; target_url?: string | null; extra?: true }[]> {
    type Page = { total_count?: number; statuses: { context: string; state: string; target_url?: string | null }[] };
    const first = await this.req<Page>('GET', `/repos/${this.repo}/commits/${sha}/status`);
    const all: { context: string; state: string; target_url?: string | null; extra?: true }[] = [...first.statuses];
    let page = first;
    for (let n = 2; page.statuses.length >= STATUS_PAGE_DEFAULT && !(typeof page.total_count === 'number' && page.total_count <= all.length); n++) {
      if (n > STATUS_PAGES_MAX) throw new Error(`more than ${STATUS_PAGES_MAX} pages of commit statuses on ${sha.slice(0, 8)}: not judged`);
      page = await this.req<Page>('GET', `/repos/${this.repo}/commits/${sha}/status?page=${n}`);
      all.push(...page.statuses.map((s) => ({ ...s, extra: true as const })));
    }
    return all;
  }

  /** A check suite's workflow run never changes: kept, so a commit's runs are listed once per new suite. */
  private readonly suiteRuns = new Map<number, WorkflowSource>();

  /** Keeps each Actions workflow run for `sha` by its check suite (one page of 100); none when Actions can't be read. */
  private async workflowRuns(sha: string): Promise<void> {
    let r: { workflow_runs: { id?: number; html_url?: string; check_suite_id?: number; path?: string; head_sha?: string; repository?: { full_name?: string } }[] };
    try {
      r = await this.req('GET', `/repos/${this.repo}/actions/runs?head_sha=${sha}&per_page=100`);
    } catch (e) {
      // No Actions: read (403) or none (404): a workflow-pinned check then has no source, so it counts as missing.
      if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) return;
      throw e;
    }
    if (this.suiteRuns.size > 5000) this.suiteRuns.clear();
    for (const w of r.workflow_runs) {
      if (typeof w.id === 'number' && typeof w.html_url === 'string' && typeof w.check_suite_id === 'number' && typeof w.path === 'string' && typeof w.head_sha === 'string' && typeof w.repository?.full_name === 'string') {
        this.suiteRuns.set(w.check_suite_id, { run: w.id, url: w.html_url, path: w.path, repo: w.repository.full_name, sha: w.head_sha });
      }
    }
  }

  /** #727: the App each required check needs on `branch`, as classic protection (get a branch) and rulesets name it. */
  async checkApps(branch: string): Promise<GithubCheckApps> {
    const b = encodeURIComponent(branch);
    const protection = await this.req<unknown>('GET', `/repos/${this.repo}/branches/${b}`);
    let rules: unknown = [];
    try {
      rules = await this.req<unknown>('GET', `/repos/${this.repo}/rules/branches/${b}?per_page=100`);
    } catch (e) {
      // No rulesets on this plan (403), or none to read (404): classic protection alone names the Apps.
      if (!(e instanceof GitHubError && (e.status === 403 || e.status === 404))) throw e;
    }
    return githubCheckApps(protection, rules);
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
