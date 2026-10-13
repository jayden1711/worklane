// A file-backed backlog with GitHub's semantics, for tests, the example
// project, and running without a tracker. One JSON file holds issues and
// their label history.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactString } from '../events/redact.js';
import type { Backlog, CommitCheck, Issue, PrReview, PrReviewComment, PullRequest, RerunJobs } from './types.js';

interface FilePr {
  head: string;
  base: string;
  url: string;
  headSha: string;
  draft: boolean;
  merged: boolean;
  reviewers?: string[];
  /** GitHub's mergeable_state; clean unless a test says otherwise. */
  mergeableState?: string;
  /** The merge commit, once merged. */
  mergeSha?: string;
  mergeTitle?: string;
  mergeBody?: string;
  /** Submitted reviews (tests set them). */
  reviews?: PrReview[];
  /** Inline review comments (tests set them). */
  reviewComments?: PrReviewComment[];
  /** Who closed it (tests set it). */
  closedBy?: string;
  /** Lines added and removed, and files (tests set them); with them, the PR reports stats, its comments counted. */
  stats?: { additions: number; deletions: number; files: number };
}

interface FileState {
  // As on GitHub, a pull request is an issue too (same numbering, labels and comments), with `pr` set.
  issues: (Issue & { labelEvents: { label: string; actor: string }[]; comments: { author: string; body: string; at?: string }[]; pr?: FilePr })[];
  labels: string[];
  /** Checks per commit sha (tests set them). */
  checks?: Record<string, CommitCheck[]>;
  /** Job logs by check run id (tests set them); 403 = the credential can't read them. */
  logs?: Record<string, string | 403>;
}

export class FileBacklog implements Backlog {
  constructor(readonly path: string, readonly actor = 'coordinator') {}

  private load(): FileState {
    if (!existsSync(this.path)) return { issues: [], labels: [] };
    return JSON.parse(readFileSync(this.path, 'utf8')) as FileState;
  }
  private save(s: FileState) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(s, null, 2));
  }
  private edit(n: number, fn: (i: FileState['issues'][number]) => void) {
    const s = this.load();
    const i = s.issues.find((x) => x.number === n);
    if (!i) throw new Error(`issue #${n} not found`);
    fn(i);
    this.save(s);
  }

  /** Test/seed helper: open an issue as `author`, optionally labeling it as `labeler`. */
  open(issue: Omit<Issue, 'number' | 'state' | 'assignees' | 'labels'> & { labels?: string[]; labeler?: string; assignees?: string[] }): number {
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
  editBody(n: number, body: string) {
    this.edit(n, (i) => {
      i.body = body;
    });
  }

  /** Test helper: a human comments on an issue (now, or at `at`). */
  humanComment(n: number, author: string, body: string, at = new Date().toISOString()) {
    this.edit(n, (i) => i.comments.push({ author, body, at }));
  }

  async list(label: string) {
    return this.load().issues.filter((i) => !i.pr && i.state === 'open' && i.labels.includes(label)).map(strip);
  }
  /** No update times here: every closed issue (a superset, as the contract allows). */
  async closedSince(_since: string) {
    return this.load().issues.filter((i) => !i.pr && i.state === 'closed').map((i) => i.number);
  }
  async get(n: number) {
    const i = this.load().issues.find((x) => x.number === n);
    if (!i) throw new Error(`issue #${n} not found`);
    return strip(i);
  }
  async labelAdders(n: number, label: string) {
    return (this.load().issues.find((x) => x.number === n)?.labelEvents ?? []).filter((e) => e.label === label).map((e) => e.actor);
  }
  async addLabels(n: number, labels: string[]) {
    this.edit(n, (i) => {
      for (const l of labels) if (!i.labels.includes(l)) {
        i.labels.push(l);
        i.labelEvents.push({ label: l, actor: this.actor });
      }
    });
  }
  async removeLabel(n: number, label: string) {
    this.edit(n, (i) => (i.labels = i.labels.filter((l) => l !== label)));
  }
  async setAssignees(n: number, logins: string[]) {
    this.edit(n, (i) => (i.assignees = [...new Set([...i.assignees, ...logins])]));
  }
  // What the harness writes is redacted first (events/redact.ts), as the GitHub backlog does for everything it sends.
  async comment(n: number, body: string) {
    this.edit(n, (i) => i.comments.push({ author: this.actor, body: redactString(body), at: new Date().toISOString() }));
  }
  async comments(n: number) {
    return this.load().issues.find((x) => x.number === n)?.comments ?? [];
  }
  async close(n: number) {
    this.edit(n, (i) => (i.state = 'closed'));
  }
  async createIssue(title: string, body: string, labels: string[]) {
    return this.open({ title: redactString(title), body: redactString(body), author: this.actor, labels });
  }
  async openPr(head: string, base: string, title: string, body: string, opts: { draft?: boolean; headSha?: string } = {}) {
    title = redactString(title);
    body = redactString(body);
    const s = this.load();
    const existing = s.issues.find((i) => i.pr?.head === head && i.state === 'open');
    if (existing) return { url: existing.pr!.url, number: existing.number, draft: existing.pr!.draft };
    const number = (s.issues.at(-1)?.number ?? 0) + 1;
    const url = `file://pr/${number}`;
    s.issues.push({ number, title, body, author: this.actor, assignees: [], state: 'open', labels: [], labelEvents: [], comments: [], pr: { head, base, url, headSha: opts.headSha ?? '', draft: Boolean(opts.draft), merged: false } });
    this.save(s);
    return { url, number, draft: Boolean(opts.draft) };
  }
  async pullRequest(n: number): Promise<PullRequest> {
    const i = this.load().issues.find((x) => x.number === n && x.pr);
    if (!i) throw new Error(`pull request #${n} not found`);
    const state = i.pr!.mergeableState ?? 'clean';
    const stats = i.pr!.stats ? { stats: { ...i.pr!.stats, comments: i.comments.length } } : {};
    return { number: n, url: i.pr!.url, head: i.pr!.head, headSha: i.pr!.headSha, base: i.pr!.base, draft: i.pr!.draft, state: i.pr!.merged ? 'merged' : i.state, title: i.title, mergeable: state === 'unknown' ? null : state !== 'dirty', mergeableState: state, ...stats };
  }
  /** Test hook: re-running a check run's failed Actions jobs (a file backlog has no Actions: absent, nothing re-runs). */
  rerunFailedJobs?: (checkRunIds: number[]) => Promise<Map<number, RerunJobs>>;
  /** Test hook: how a merge happens (e.g. a real merge commit on a test remote); returns the merge commit. */
  mergeWith?: (pr: { number: number; head: string; headSha: string; base: string }) => string;
  async mergePr(n: number, sha: string, title: string, body?: string): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
    const i = this.load().issues.find((x) => x.number === n && x.pr);
    if (!i || i.state !== 'open') return { ok: false, why: 'not open' };
    if (i.pr!.headSha !== sha) return { ok: false, why: `head is ${i.pr!.headSha}, not ${sha}` };
    if ((i.pr!.mergeableState ?? 'clean') === 'dirty') return { ok: false, why: 'merge conflict' };
    // Strict branch protection: GitHub's 405 for a branch behind its base.
    if (i.pr!.mergeableState === 'behind') return { ok: false, why: 'Head branch is not up to date with the base branch' };
    const mergeSha = this.mergeWith ? this.mergeWith({ number: n, head: i.pr!.head, headSha: sha, base: i.pr!.base }) : sha.replace(/^./, 'f');
    this.edit(n, (x) => {
      Object.assign(x.pr!, { merged: true, mergeSha, mergeTitle: title, ...(body !== undefined ? { mergeBody: body } : {}) });
      x.state = 'closed';
    });
    return { ok: true, sha: mergeSha };
  }
  async checks(sha: string) {
    return this.load().checks?.[sha] ?? [];
  }
  async markReady(n: number) {
    this.edit(n, (i) => {
      if (i.pr) i.pr.draft = false;
    });
  }
  async requestReview(n: number, logins: string[]) {
    this.edit(n, (i) => {
      if (i.pr) i.pr.reviewers = [...new Set([...(i.pr.reviewers ?? []), ...logins])];
    });
  }
  async jobLog(id: number): Promise<{ ok: true; text: string } | { ok: false; why: 'forbidden' | 'not_found' }> {
    const log = this.load().logs?.[String(id)];
    if (log === undefined) return { ok: false, why: 'not_found' };
    if (log === 403) return { ok: false, why: 'forbidden' };
    return { ok: true, text: log };
  }
  /** Test helper: a job's log, or 403 for a credential that can't read Actions logs. */
  setJobLog(id: number, log: string | 403) {
    const s = this.load();
    (s.logs ??= {})[String(id)] = log;
    this.save(s);
  }
  /** Test helper: the pull requests, oldest first. */
  prs() {
    return this.load()
      .issues.filter((i) => i.pr)
      .map((i) => ({ number: i.number, title: i.title, body: i.body, labels: i.labels, state: i.state, comments: i.comments, ...i.pr! }));
  }
  /** Test helper: change a pull request as GitHub would (a push moves headSha; a merge or close ends it). */
  setPr(n: number, patch: Partial<Pick<FilePr, 'headSha' | 'draft' | 'merged' | 'mergeableState' | 'closedBy' | 'stats'>> & { state?: 'open' | 'closed' }) {
    this.edit(n, (i) => {
      const { state, ...rest } = patch;
      Object.assign(i.pr!, rest);
      if (state) i.state = state;
      if (patch.merged) i.state = 'closed';
    });
  }
  /** Test helper: a review submitted on a pull request. */
  addReview(n: number, r: Omit<PrReview, 'id' | 'at'> & { at?: string }) {
    this.edit(n, (i) => {
      const list = (i.pr!.reviews ??= []);
      list.push({ id: n * 1000 + list.length + 1, at: r.at ?? new Date().toISOString(), author: r.author, state: r.state, body: r.body });
    });
  }
  async reviews(n: number): Promise<PrReview[]> {
    return this.load().issues.find((x) => x.number === n)?.pr?.reviews ?? [];
  }
  /** Test helper: an inline comment in a submitted review (`review`: its id, from addReview). */
  addReviewComment(n: number, c: Omit<PrReviewComment, 'id' | 'at'> & { at?: string }) {
    this.edit(n, (i) => {
      const list = (i.pr!.reviewComments ??= []);
      list.push({ id: n * 100_000 + list.length + 1, at: c.at ?? new Date().toISOString(), review: c.review, author: c.author, body: c.body, path: c.path, line: c.line });
    });
  }
  async reviewComments(n: number): Promise<PrReviewComment[]> {
    return this.load().issues.find((x) => x.number === n)?.pr?.reviewComments ?? [];
  }
  async closedBy(n: number): Promise<string | null> {
    const i = this.load().issues.find((x) => x.number === n);
    return i && i.state === 'closed' ? (i.pr?.closedBy ?? null) : null;
  }
  /** Test helper: the checks GitHub reports on a commit. */
  setChecks(sha: string, checks: CommitCheck[]) {
    const s = this.load();
    (s.checks ??= {})[sha] = checks;
    this.save(s);
  }
  async ensureLabels(labels: { name: string }[]) {
    const s = this.load();
    const created = labels.map((l) => l.name).filter((l) => !s.labels.includes(l));
    s.labels.push(...created);
    this.save(s);
    return created;
  }
}

function strip(i: FileState['issues'][number]): Issue {
  const { labelEvents: _e, comments: _c, pr: _p, ...rest } = i;
  return rest;
}
