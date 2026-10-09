import { parse as parseYaml } from 'yaml';
import { DoneWhen } from '../stopgate.js';
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
  /** Open a pull request from a pushed branch; returns its URL. */
  openPr(head: string, base: string, title: string, body: string): Promise<string>;
  /** Open pull requests waiting on this person's review. */
  prsAwaitingReview(login: string): Promise<number>;
  /** CI on a commit: the overall state and the checks that failed. */
  ciStatus(sha: string): Promise<CiStatus>;
  ensureLabels(labels: { name: string; color: string; description: string }[]): Promise<string[]>;
}

export interface CiStatus {
  state: 'success' | 'failure' | 'pending' | 'none';
  failing: { name: string; url: string }[];
}

export const LABELS = [
  { name: 'triage', color: 'd4c5f9', description: 'New; not yet approved for work' },
  { name: 'ready', color: '0e8a16', description: 'Approved by a writer; has a done_when contract' },
  { name: 'agent:working', color: 'fbca04', description: 'Claimed by an agent (see the claim comment)' },
  { name: 'in-review', color: '1d76db', description: 'Change proposed; verifying or awaiting approval' },
  { name: 'needs:decision', color: 'b60205', description: 'Waiting on a decision from the owner' },
  { name: 'money-path', color: '5319e7', description: 'Touches money-path code: extra verification' },
  { name: 'blocked', color: '000000', description: 'Cannot proceed; see the latest comment' },
  { name: 'type:investigation', color: 'c5def5', description: 'Read-only: findings and evidence, no code change' },
  { name: 'red', color: 'e11d21', description: 'A new failure on main, attributed to the change that caused it' },
  { name: 'ci', color: 'c5def5', description: 'CI is red on main' },
  { name: 'qa', color: 'fef2c0', description: 'Found by the QA playtester on a test deployment' },
  { name: 'incident', color: 'b60205', description: 'A deployment check failed; see the monitor comment' },
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
