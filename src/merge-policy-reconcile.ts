// The engine's merge, made idempotent across a crash (#733). The merge flow records `merge.attempted` right before
// GitHub's merge API call (mergeOurs, the one door every merge goes through), and `merge.done`, `merge.failed` or
// `merge.deferred` once the call answers. A crash in between leaves an attempt with no outcome. On the PR watch's next
// look at that PR, this decides what the attempt was:
//   - merged: GitHub reports the PR merged into the default branch at exactly the attempted head, by a bot (the engine
//     merges as its GitHub App; a person's merge is never its own), its merge_commit_sha a merge commit of that head
//     (second parent) on the branch whose message carries the engine's own merge line for that head.
//     Then `merge.done` is recorded after the fact (`reconciled: true`), and the main watch counts it as the engine's.
//   - failed: the PR is still open, or closed unmerged. The call never merged it: `merge.failed`, so a later merge of
//     that head by anyone else is never taken for this attempt.
//   - nothing: anything else (another head, another kind of merge or message, another base, no merge commit, no
//     attempt at all). Nothing is recorded: the main watch judges the commit exactly as it did before.
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

/** A commit as git reads it: its parents, and its whole message. */
export interface CommitFacts {
  parents: string[];
  message: string;
}

export type Reconciled = { act: 'done'; sha: string } | { act: 'failed'; why: string } | { act: 'none'; why: string };

/**
 * What an open attempt was, from GitHub's PR as read now and git's merge commit (`commit`, read only when it is
 * needed; null: git doesn't have it). See the top of this file.
 */
export function reconcileMerge(o: { attempt: OpenAttempt | null; pr: Pick<PullRequest, 'state' | 'headSha' | 'base' | 'mergeCommit' | 'mergedBy'>; branch: string; product: string; commit: (sha: string) => CommitFacts | null }): Reconciled {
  const a = o.attempt;
  if (!a) return { act: 'none', why: 'no merge attempt of the engine is open on it' };
  const at = a.head.slice(0, 8);
  if (o.pr.state === 'open') return { act: 'failed', why: `the merge call at ${at} ended without an answer, and the PR is still open: not merged` };
  if (o.pr.state !== 'merged') return { act: 'failed', why: `the merge call at ${at} ended without an answer, and the PR was closed without merging` };
  if (o.pr.headSha !== a.head) return { act: 'none', why: `merged at ${o.pr.headSha.slice(0, 8)}, not at the attempted head ${at}` };
  if (o.pr.base !== o.branch) return { act: 'none', why: `merged into ${o.pr.base}, not ${o.branch}` };
  // The engine merges as its GitHub App, a bot: a person's merge (or one GitHub names no one for) is never its own.
  if (!o.pr.mergedBy?.bot) return { act: 'none', why: `merged by ${o.pr.mergedBy ? `@${o.pr.mergedBy.login}, a person` : 'no one GitHub names'}, not a bot as the engine's App is` };
  const sha = o.pr.mergeCommit;
  if (!sha || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return { act: 'none', why: 'GitHub reports no merge commit for it' };
  const c = o.commit(sha);
  if (!c) return { act: 'none', why: `its merge commit ${sha.slice(0, 8)} isn't on ${o.branch}` };
  if (c.parents.length !== 2 || c.parents[1] !== a.head) return { act: 'none', why: `${sha.slice(0, 8)} is not a merge commit of the attempted head ${at}` };
  const line = mergeMessage({ title: '', number: a.number, head: a.head, product: o.product }).body;
  if (!c.message.split('\n').some((l) => l.trim() === line)) return { act: 'none', why: `${sha.slice(0, 8)} doesn't carry the engine's merge message for ${at}` };
  return { act: 'done', sha };
}
