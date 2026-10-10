import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { DoneWhen } from '../contract.js';
import type { z } from 'zod';

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  assignees: string[];
  state: 'open' | 'closed';
}

/** The tracker, as the coordinator sees it. Only the coordinator writes. */
export interface Backlog {
  list(label: string): Promise<Issue[]>;
  get(n: number): Promise<Issue>;
  /** Logins that added `label` to the issue, oldest first. */
  labelAdders(n: number, label: string): Promise<string[]>;
  addLabels(n: number, labels: string[]): Promise<void>;
  removeLabel(n: number, label: string): Promise<void>;
  setAssignees(n: number, logins: string[]): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  comments(n: number): Promise<{ author: string; body: string }[]>;
  close(n: number): Promise<void>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  /**
   * Open a pull request from a pushed branch, or return the open one for that branch. `draft` asks for a draft
   * (a repo that doesn't support drafts gets an ordinary PR); `headSha` is the commit just pushed.
   */
  openPr(head: string, base: string, title: string, body: string, opts?: { draft?: boolean; headSha?: string }): Promise<{ url: string; number: number; draft: boolean }>;
  /** A pull request's current state. */
  pullRequest(n: number): Promise<PullRequest>;
  /** Every check on a commit: check runs (latest per name) and commit statuses. */
  checks(sha: string): Promise<CommitCheck[]>;
  /** Take a draft PR out of draft. */
  markReady(n: number): Promise<void>;
  /** Merge a PR with a merge commit (never squash), only if its head is still `sha`. Returns the merge commit. */
  mergePr(n: number, sha: string, title: string): Promise<{ ok: true; sha: string } | { ok: false; why: string }>;
  /** Ask these people to review a PR (GitHub notifies them). */
  requestReview(n: number, logins: string[]): Promise<void>;
  /**
   * The log of a check run's job (an Actions job: its id is the check run's). `forbidden`: the credential can't
   * read Actions logs; `not_found`: there is no such log (not an Actions job, or expired).
   */
  jobLog(id: number): Promise<{ ok: true; text: string } | { ok: false; why: 'forbidden' | 'not_found' }>;
  ensureLabels(labels: { name: string; color: string; description: string }[]): Promise<string[]>;
}

export interface PullRequest {
  number: number;
  url: string;
  /** The branch name and its current commit. */
  head: string;
  headSha: string;
  /** The branch it merges into (its actual base, which a conflict fix merges in). */
  base: string;
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
  title: string;
  /** GitHub's merge check: null while it's still computing. */
  mergeable: boolean | null;
  /** clean | unstable | has_hooks | dirty (conflicts) | behind | blocked | draft | unknown */
  mergeableState: string;
}

/** One check on a commit, as GitHub reports it: a check run, or a commit status (completed with its state). */
export interface CommitCheck {
  name: string;
  source: 'check_run' | 'status';
  /** queued | in_progress | completed for check runs; pending | completed for statuses. */
  status: string;
  /** success | failure | cancelled | skipped | neutral | timed_out | action_required | ... ; null until completed. */
  conclusion: string | null;
  /** The check run's id (its job, for a run from Actions), when there is one. */
  id?: number;
  url?: string;
}

export const LABELS = [
  { name: 'triage', color: 'd4c5f9', description: 'New; not yet approved for work' },
  { name: 'ready', color: '0e8a16', description: 'Approved by a writer; has a done_when contract' },
  { name: 'agent:working', color: 'fbca04', description: 'Claimed by an agent (see the claim comment)' },
  { name: 'in-review', color: '1d76db', description: 'Change proposed; verifying or awaiting approval' },
  { name: 'needs:decision', color: 'b60205', description: 'Waiting on a decision from the owner' },
  { name: 'money-path', color: '5319e7', description: 'Touches money-path code: extra verification' },
  { name: 'blocked', color: '000000', description: 'Cannot proceed; see the latest comment' },
  { name: 'merge-ready', color: '0e8a16', description: 'Required checks passed on the commit the evaluator approved' },
  { name: 'ci-failing', color: 'b60205', description: 'A required check fails and CI fix runs stopped; see the latest comment' },
  { name: 'needs-owner', color: 'd93f0b', description: 'Waits for the owner to review and merge; the latest comment says why' },
  { name: 'type:investigation', color: 'c5def5', description: 'Read-only: findings and evidence, no code change' },
  { name: 'report', color: 'bfdadc', description: 'Scheduled reports are posted here' },
  { name: 'size:S', color: 'c2e0c6', description: 'Small' },
  { name: 'size:M', color: 'fef2c0', description: 'Medium: plan mode first' },
  { name: 'size:L', color: 'f9d0c4', description: 'Large: plan mode first' },
  { name: 'review:L0', color: 'ededed', description: 'Lands after checks pass' },
  { name: 'review:L1', color: 'ededed', description: 'Lands after the evaluator approves' },
  { name: 'review:L2', color: 'ededed', description: 'Lands after the evaluator approves; owner notified' },
  { name: 'review:L3', color: 'ededed', description: 'Owner must approve before landing' },
] as const;

export type DoneWhenList = z.infer<typeof DoneWhen>;

/** The ```done_when fenced block in an issue body, validated. */
/** Identifies the ```done_when block an intake decision was about: a hash of its text, or "none". */
export function contractKey(body: string): string {
  const m = body.match(/```done_when\s*\n([\s\S]*?)\n```/);
  return m ? createHash('sha256').update(m[1]!.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16) : 'none';
}

export function parseContract(body: string): { ok: true; done_when: DoneWhenList } | { ok: false; why: string } {
  const m = body.match(/```done_when\s*\n([\s\S]*?)\n```/);
  if (!m) return { ok: false, why: 'no ```done_when block in the issue body' };
  let raw: unknown;
  try {
    raw = parseYaml(m[1]!);
  } catch (e) {
    return { ok: false, why: `done_when is not valid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  const r = DoneWhen.min(1).safeParse(raw);
  if (!r.success) return { ok: false, why: `done_when invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  return { ok: true, done_when: r.data };
}

export interface Actionability {
  actionable: boolean;
  why: string;
}

/**
 * Only issues opened by a writer, or marked ready by a writer, are
 * actionable; outsiders' issues stay in triage however they're labeled.
 */
export async function actionable(issue: Issue, writers: string[], backlog: Backlog): Promise<Actionability> {
  if (issue.state !== 'open') return { actionable: false, why: 'closed' };
  if (!issue.labels.includes('ready')) return { actionable: false, why: 'not labeled ready' };
  const w = new Set(writers.map((x) => x.toLowerCase()));
  if (w.has(issue.author.toLowerCase())) return { actionable: true, why: `opened by writer ${issue.author}` };
  const adders = await backlog.labelAdders(issue.number, 'ready');
  const approver = adders.find((a) => w.has(a.toLowerCase()));
  return approver ? { actionable: true, why: `ready added by writer ${approver}` } : { actionable: false, why: `opened by ${issue.author} (not a writer) and no writer added ready` };
}

/** The owner for an issue: an assignee who is a writer, else the first matching area, else the default. */
export function ownerFor(issue: Issue, paths: string[], owners: { default: string; writers: string[]; areas: { owner: string; paths: string[]; labels: string[] }[] }, match: (glob: string, path: string) => boolean): string {
  const writers = new Set(owners.writers.map((w) => w.toLowerCase()));
  const assigned = issue.assignees.find((a) => writers.has(a.toLowerCase()));
  if (assigned) return assigned;
  for (const area of owners.areas) {
    if (area.labels.some((l) => issue.labels.includes(l))) return area.owner;
    if (paths.some((p) => area.paths.some((g) => match(g, p)))) return area.owner;
  }
  return owners.default;
}
