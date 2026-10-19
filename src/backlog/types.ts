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
  /**
   * Issues (not PRs) now closed and last updated at or after `since` (ISO): every one closed since then, and maybe
   * some closed earlier. One listing, however many issues it covers.
   */
  closedSince(since: string): Promise<number[]>;
  /** Logins that added `label` to the issue, oldest first. */
  labelAdders(n: number, label: string): Promise<string[]>;
  addLabels(n: number, labels: string[]): Promise<void>;
  removeLabel(n: number, label: string): Promise<void>;
  setAssignees(n: number, logins: string[]): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  /** An issue's or PR's comments, oldest first; `at`: when it was made (ISO), when the tracker says. */
  comments(n: number): Promise<{ author: string; body: string; at?: string }[]>;
  close(n: number): Promise<void>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  /** WHY (#468): the open issues (not PRs), at most 100, in ONE read: the Issues page's "not picked up" list. Absent: this tracker can't. */
  openIssues?(): Promise<Issue[]>;
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
  /**
   * Merge a PR with a merge commit (never squash), only if its head is still `sha` (GitHub's `sha`, like `gh pr merge
   * --match-head-commit`). `title` and `body` are the merge commit's subject and message. Returns the merge commit.
   */
  mergePr(n: number, sha: string, title: string, body?: string): Promise<{ ok: true; sha: string } | { ok: false; why: string }>;
  /** Ask these people to review a PR (GitHub notifies them). */
  requestReview(n: number, logins: string[]): Promise<void>;
  /**
   * The log of a check run's job (an Actions job: its id is the check run's). `forbidden`: the credential can't
   * read Actions logs; `not_found`: there is no such log (not an Actions job, or expired).
   */
  jobLog(id: number): Promise<{ ok: true; text: string } | { ok: false; why: 'forbidden' | 'not_found' }>;
  /**
   * Re-run, on the same commit, the failed jobs of the Actions workflow runs these check runs' jobs belong to: each
   * workflow run once (POST /actions/runs/{run}/rerun-failed-jobs). Per check run: re-run, or `forbidden` (the
   * credential can't, no Actions: write, or GitHub refuses it now: the run is still going) or `not_found` (not an
   * Actions job). Absent: this tracker can't re-run checks.
   */
  rerunFailedJobs?(checkRunIds: number[]): Promise<Map<number, RerunJobs>>;
  ensureLabels(labels: { name: string; color: string; description: string }[]): Promise<string[]>;
  /** A pull request's submitted reviews, oldest first. */
  reviews(n: number): Promise<PrReview[]>;
  /** A pull request's inline review comments (on lines of its diff), oldest first. Absent: this tracker has none. */
  reviewComments?(n: number): Promise<PrReviewComment[]>;
  /** Who closed an issue or pull request (null: open, or unknown). */
  closedBy(n: number): Promise<string | null>;
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
  /** Its description (Markdown), as the tracker has it: a decision's detail reads its fail-without and never sections. */
  body?: string;
  /** GitHub's merge check: null while it's still computing. */
  mergeable: boolean | null;
  /** clean | unstable | has_hooks | dirty (conflicts) | behind | blocked | draft | unknown */
  mergeableState: string;
  /** A merged PR's merge commit, as GitHub reports it (merge_commit_sha); absent while it isn't merged. */
  mergeCommit?: string;
  /** Who merged it, as GitHub reports it (merged_by): a login, and whether that account is a bot (an App). */
  mergedBy?: { login: string; bot: boolean };
  /** Its size and conversation as the tracker reports them (lines added and removed, files, comments and review comments); absent when it doesn't. */
  stats?: { additions: number; deletions: number; files: number; comments: number };
}

/** A submitted review on a pull request. `state`: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
export interface PrReview {
  id: number;
  author: string;
  state: string;
  body: string;
  at: string;
}

/** An inline review comment: on `path` at `line` (null: the line is gone from the diff), part of review `review`. */
export interface PrReviewComment {
  id: number;
  review: number | null;
  author: string;
  body: string;
  path: string;
  line: number | null;
  at: string;
}

/** What a re-run request got: the workflow run re-run, or why not. */
export type RerunJobs = { ok: true; run: number } | { ok: false; why: 'forbidden' | 'not_found'; detail: string };

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
  { name: 'type:goal', color: 'c5def5', description: 'A goal: split into child issues that depend on each other, not built itself' },
  { name: 'goal:split', color: 'ededed', description: 'This goal was split; its child issues are listed in a comment' },
  { name: 'report', color: 'bfdadc', description: 'Scheduled reports are posted here' },
  { name: 'size:S', color: 'c2e0c6', description: 'Small' },
  { name: 'size:M', color: 'fef2c0', description: 'Medium: plan mode first' },
  { name: 'size:L', color: 'f9d0c4', description: 'Large: plan mode first' },
  { name: 'review:L0', color: 'ededed', description: 'Lands after checks pass' },
  { name: 'review:L1', color: 'ededed', description: 'Lands after the evaluator approves' },
  { name: 'review:L2', color: 'ededed', description: 'Lands after the evaluator approves; owner notified' },
  { name: 'review:L3', color: 'ededed', description: 'Owner must approve before landing' },
  { name: 'couldnt-reproduce', color: 'e4e669', description: "Intake couldn't reproduce this bug from the code; the task's failing test decides" },
] as const;

export type DoneWhenList = z.infer<typeof DoneWhen>;

/**
 * The text of each ```done_when fenced block in a body, Windows (CRLF) line endings read as LF. Every reader of a
 * contract (the coordinator, checkDraftedIssue, the refusal's key) goes through here, so they agree on the blocks and
 * on their text (#643).
 */
function doneWhenBlocks(body: string): string[] {
  return [...body.replace(/\r\n/g, '\n').matchAll(/```done_when\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
}

/** Identifies the ```done_when block(s) an intake decision was about: a hash of their text, or "none". */
export function contractKey(body: string): string {
  const blocks = doneWhenBlocks(body);
  return blocks.length ? createHash('sha256').update(blocks.join('\0')).digest('hex').slice(0, 16) : 'none';
}

/**
 * The ```done_when fenced block in an issue body, validated. A body with more than one is refused: which block is the
 * contract would otherwise depend on who reads it (#643: a decoy above a draft's Deliverable).
 */
export function parseContract(body: string): { ok: true; done_when: DoneWhenList } | { ok: false; why: string } {
  const blocks = doneWhenBlocks(body);
  if (!blocks.length) return { ok: false, why: 'no ```done_when block in the issue body' };
  if (blocks.length > 1) return { ok: false, why: `${blocks.length} \`\`\`done_when blocks in the issue body; it needs exactly one` };
  let raw: unknown;
  try {
    raw = parseYaml(blocks[0]!);
  } catch (e) {
    return { ok: false, why: `done_when is not valid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  const r = DoneWhen.min(1).safeParse(raw);
  if (!r.success) return { ok: false, why: `done_when invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  return { ok: true, done_when: r.data };
}

/** The five parts of every issue the harness drafts itself (intake, chat, gardener, corrections). */
export const ISSUE_PARTS = ['Outcome', 'Sources', 'Constraints', 'Deliverable', 'Review point'] as const;
export type IssuePart = (typeof ISSUE_PARTS)[number];

/** How a drafting agent is told to write the body (src/roles.ts says the same in the chat role; a test keeps them in step). */
export const DRAFT_FORMAT =
  'five parts, each starting a line with its bold label: **Outcome:** one sentence. **Sources:** where to look, nowhere else. **Constraints:** what to leave alone. **Deliverable:** a closed ```done_when block, commands as YAML block scalars ("- command: |"). **Review point:** the expected review level (L0 to L3) and what would make it wait for the owner.';

/**
 * The text of each part in an issue body, labelled `**Outcome:**` (or `**Outcome**:`) at the start of a line, or as
 * a heading (`## Outcome`). A part runs to the next part's label; labels inside code fences don't count. null: absent.
 */
export function issueParts(body: string): Record<IssuePart, string | null> {
  const out = Object.fromEntries(ISSUE_PARTS.map((p) => [p, null])) as Record<IssuePart, string | null>;
  const names = new Map(ISSUE_PARTS.map((p) => [p.toLowerCase(), p]));
  let current: IssuePart | null = null;
  let fence = false;
  const parts: Partial<Record<IssuePart, string[]>> = {};
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^\s*(?:\*\*([^*]+?):?\*\*:?|#{1,6}\s+([^#]+?):?\s*#*\s*$)\s*(.*)$/.exec(line);
    const name = m ? names.get((m[1] ?? m[2] ?? '').trim().toLowerCase()) : undefined;
    if (name) {
      current = name;
      parts[name] = [m![3] ?? ''];
    } else if (current) parts[current]!.push(line);
  }
  for (const p of ISSUE_PARTS) if (parts[p]) out[p] = parts[p]!.join('\n').trim();
  return out;
}

/**
 * Can an issue the harness drafted itself be filed? A title; all five parts, none empty; the Outcome one sentence on
 * one line; the Deliverable a ```done_when block parseContract accepts, and the body's only one, its commands YAML
 * block scalars (`- command: |`, which keeps quoting and colons inside commands from breaking the block); the Review
 * point naming a review level (L0 to L3).
 */
export function checkDraftedIssue(title: string, body: string): { ok: true; done_when: DoneWhenList } | { ok: false; why: string } {
  if (!title.trim()) return { ok: false, why: 'the draft has no title' };
  const parts = issueParts(body);
  const missing = ISSUE_PARTS.filter((p) => !parts[p]);
  if (missing.length) return { ok: false, why: `the draft needs all five parts (${ISSUE_PARTS.join(', ')}); missing or empty: ${missing.join(', ')}` };
  if (parts.Outcome!.includes('\n')) return { ok: false, why: 'the Outcome must be one sentence on one line' };
  const c = parseContract(parts.Deliverable!);
  if (!c.ok) return { ok: false, why: `Deliverable: ${c.why}` };
  const block = doneWhenBlocks(parts.Deliverable!)[0]!;
  const inline = block.split('\n').filter((l) => /^\s*-?\s*command:\s*\S/.test(l) && !/^\s*-?\s*command:\s*[|>][-+]?\s*$/.test(l));
  if (inline.length) return { ok: false, why: `commands must be YAML block scalars ("- command: |"), not inline: ${inline[0]!.trim()}` };
  if (!/\bL[0-3]\b/.test(parts['Review point']!)) return { ok: false, why: 'the Review point must name the expected review level (L0 to L3) and what would make it wait for the owner' };
  // INVARIANT (#643): what passes here is what the coordinator reads: the whole body through its own parser, so a
  // second block anywhere (a decoy in Sources) is refused, never format-checked in one place and run from another.
  return parseContract(body);
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

/** Who may answer a decision: its owner, or one of the project's writers. GitHub logins are case-insensitive. */
export function mayAnswer(owner: string, user: string, owners: { writers: string[] }): boolean {
  const u = user.toLowerCase();
  return !!u && (owner.toLowerCase() === u || owners.writers.some((w) => w.toLowerCase() === u));
}
