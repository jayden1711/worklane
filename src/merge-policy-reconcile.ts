// The engine's merge, made idempotent across a crash (#733). The merge flow records `merge.attempted` right before
// GitHub's merge API call (mergeOurs, the one door every merge goes through), and `merge.done`, `merge.failed` or
// `merge.deferred` once the call answers. A crash in between leaves an attempt with no outcome. On the PR watch's next
// look at that PR, this decides what the attempt was:
//   - merged: GitHub reports the PR merged into the default branch at exactly the attempted head, by exactly the
//     engine's own App: merged_by is its bot user, the same numeric id and login the App's credentials resolve
//     (appBotIdentity; never commit_identity, which instance.yaml can set). Its merge_commit_sha is a merge commit of
//     that head (second parent) on the branch whose message carries the engine's own merge line for that head, and
//     GitHub says when it merged (merged_at), the time the main watch judges its checks at.
//     Then `merge.done` is recorded after the fact (`reconciled: true`), and the main watch counts it as the engine's.
//   - failed: the PR is still open, or closed unmerged. The call never merged it: `merge.failed`, so a later merge of
//     that head by anyone else is never taken for this attempt.
//   - nothing: anything else (another head, another merger or no App identity known, another kind of merge or message,
//     another base, no merge commit or time, no attempt at all). Nothing is recorded: the main watch judges the commit
//     exactly as it did before, so it stays unaccounted (the stop, and the owner's review).
// Pure: the merge flow and the tests share it. Append-only: nothing here rewrites an event.
import type { PullRequest } from './backlog/types.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import { mergeMessage } from './merge-policy-train.js';

/** The events an attempt and its outcome are read from. */
export const ATTEMPT_EVENTS = ['merge.attempted', 'merge.done', 'merge.failed', 'merge.deferred'] as const;

/** An attempt with no outcome yet, and when it was recorded. */
export type OpenAttempt = EventPayload<'merge.attempted'> & { at: string };

/**
 * PR `number`'s attempt with no outcome after it: its latest `merge.attempted`, unless a `merge.done`, `merge.failed`
 * or `merge.deferred` of that PR came after it. Null: none.
 */
export function openAttempt(events: readonly StoredEvent[], number: number): OpenAttempt | null {
  let open: OpenAttempt | null = null;
  for (const e of events) {
    const p = e.payload as { number?: number };
    if (p.number !== number) continue;
    if (e.type === 'merge.attempted') open = { ...(e.payload as EventPayload<'merge.attempted'>), at: e.ts };
    else if (e.type === 'merge.done' || e.type === 'merge.failed' || e.type === 'merge.deferred') open = null;
  }
  return open;
}

/**
 * How many of PR `number`'s merge tries at `head` failed: each `merge.attempted` whose outcome was a `merge.failed`
 * (the call refused, or found still open on the next look). A `merge.failed` with no attempt open before it (a hold:
 * not mergeable cleanly, auto-merge stopped, the combined gate) is not a try, and never counts.
 */
export function failedTries(events: readonly StoredEvent[], number: number, head: string): number {
  let open = false;
  let failed = 0;
  for (const e of events) {
    const p = e.payload as { number?: number; head?: string };
    if (p.number !== number) continue;
    if (e.type === 'merge.attempted') open = p.head === head;
    else if (e.type === 'merge.failed') {
      if (open && p.head === head) failed++;
      open = false;
    } else if (e.type === 'merge.done' || e.type === 'merge.deferred') open = false;
  }
  return failed;
}

/** A commit as git reads it: its parents, and its whole message. */
export interface CommitFacts {
  parents: string[];
  message: string;
}

/** The engine's own App bot user (appBotIdentity): its login and numeric id. Null: not known (a token install, or the lookup failed). */
export type EngineBot = { login: string; id: number } | null;

export type Reconciled = { act: 'done'; sha: string; mergedAt: string } | { act: 'failed'; why: string } | { act: 'none'; why: string };

/**
 * What an open attempt was, from GitHub's PR as read now and git's merge commit (`commit`, read only when it is
 * needed; null: git doesn't have it). `engine`: the App's bot user. See the top of this file.
 */
export function reconcileMerge(o: { attempt: OpenAttempt | null; pr: Pick<PullRequest, 'state' | 'headSha' | 'base' | 'mergeCommit' | 'mergedBy' | 'mergedAt'>; branch: string; product: string; engine: EngineBot; commit: (sha: string) => CommitFacts | null }): Reconciled {
  const a = o.attempt;
  if (!a) return { act: 'none', why: 'no merge attempt of the engine is open on it' };
  const at = a.head.slice(0, 12);
  if (o.pr.state === 'open') return { act: 'failed', why: `the merge call at ${at} ended without an answer, and the PR is still open: not merged` };
  if (o.pr.state !== 'merged') return { act: 'failed', why: `the merge call at ${at} ended without an answer, and the PR was closed without merging` };
  if (o.pr.headSha !== a.head) return { act: 'none', why: `merged at ${o.pr.headSha.slice(0, 12)}, not at the attempted head ${at}` };
  if (o.pr.base !== o.branch) return { act: 'none', why: `merged into ${o.pr.base}, not ${o.branch}` };
  // Only the engine's own App merged it: its bot user's id and login, as the App's credentials resolve them. No identity
  // known, or a merger GitHub gives no id for: never the engine's.
  const by = o.pr.mergedBy;
  if (!o.engine) return { act: 'none', why: "the engine's App identity is not known (a token install, or its lookup failed), so no merge is taken for its own" };
  if (!by || by.id === undefined || by.id !== o.engine.id || by.login !== o.engine.login) return { act: 'none', why: `merged by ${by ? `@${by.login}${by.id !== undefined ? ` (id ${by.id})` : ' (no id)'}` : 'no one GitHub names'}, not the engine's App @${o.engine.login} (id ${o.engine.id})` };
  const mergedAt = o.pr.mergedAt;
  if (!mergedAt || !Number.isFinite(Date.parse(mergedAt))) return { act: 'none', why: 'GitHub reports no time it merged' };
  const sha = o.pr.mergeCommit;
  if (!sha || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return { act: 'none', why: 'GitHub reports no merge commit for it' };
  const c = o.commit(sha);
  if (!c) return { act: 'none', why: `its merge commit ${sha.slice(0, 12)} isn't on ${o.branch}` };
  if (c.parents.length !== 2 || c.parents[1] !== a.head) return { act: 'none', why: `${sha.slice(0, 12)} is not a merge commit of the attempted head ${at}` };
  const line = mergeMessage({ title: '', number: a.number, head: a.head, product: o.product }).body;
  if (!c.message.split('\n').some((l) => l.trim() === line)) return { act: 'none', why: `${sha.slice(0, 12)} doesn't carry the engine's merge message for ${at}` };
  return { act: 'done', sha, mergedAt };
}
