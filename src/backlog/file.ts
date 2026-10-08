// A file-backed backlog with GitHub's semantics, for tests, the example
// project, and running without a tracker. One JSON file holds issues and
// their label history.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CiStatus, Backlog, Issue } from './types.js';

interface FileState {
  issues: (Issue & { labelEvents: { label: string; actor: string }[]; comments: { author: string; body: string }[] })[];
  labels: string[];
  prs?: { head: string; base: string; title: string; body: string; url: string }[];
  ci?: Record<string, CiStatus>;
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

  /** Test helper: a human comments on an issue. */
  humanComment(n: number, author: string, body: string) {
    this.edit(n, (i) => i.comments.push({ author, body }));
  }

  async list(label: string) {
    return this.load().issues.filter((i) => i.state === 'open' && i.labels.includes(label)).map(strip);
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
  async comment(n: number, body: string) {
    this.edit(n, (i) => i.comments.push({ author: this.actor, body }));
  }
  async comments(n: number) {
    return this.load().issues.find((x) => x.number === n)?.comments ?? [];
  }
  async close(n: number) {
    this.edit(n, (i) => (i.state = 'closed'));
  }
  async createIssue(title: string, body: string, labels: string[]) {
    return this.open({ title, body, author: this.actor, labels });
  }
  async openPr(head: string, base: string, title: string, body: string) {
    const s = this.load();
    const url = `file://pr/${(s.prs?.length ?? 0) + 1}`;
    (s.prs ??= []).push({ head, base, title, body, url });
    this.save(s);
    return url;
  }
  async ciStatus(sha: string): Promise<CiStatus> {
    return this.load().ci?.[sha] ?? { state: 'none', failing: [] };
  }
  /** Tests and demos: set CI's result for a commit. */
  setCi(sha: string, status: CiStatus) {
    const s = this.load();
    (s.ci ??= {})[sha] = status;
    this.save(s);
  }
  prs() {
    return this.load().prs ?? [];
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
  const { labelEvents: _e, comments: _c, ...rest } = i;
  return rest;
}
