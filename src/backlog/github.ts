// GitHub Issues backlog over REST. Only the coordinator holds the token;
// agents never see it. Errors are classified (a 403 isn't "missing
// permission" unless it is).
import { execFileSync } from 'node:child_process';
import { classifyGitHubError } from '../github/errors.js';
import type { Backlog, Issue } from './types.js';

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

export class GitHubBacklog implements Backlog {
  constructor(
    readonly repo: string,
    private token: () => string = ghToken,
    private fetchImpl: Fetch = fetch,
    private api = 'https://api.github.com',
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const c = classifyGitHubError(res.status, Object.fromEntries(res.headers.entries()), json);
      throw new GitHubError(res.status, c.kind, c.message, c.retryAfter);
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

  async comment(n: number, body: string) {
    await this.req('POST', `/repos/${this.repo}/issues/${n}/comments`, { body });
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
