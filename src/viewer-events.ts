// What a viewer (read on the instance's repo) may see of the event log: an
// allowlist of event types and, for each, the payload fields. Anything not on
// it is hidden from viewers, so a new event type stays hidden until someone
// decides it is safe to show. Runs and agents (prompts, feeds, commands,
// output, paths, costs, research) are never on it: they are the owners' and
// writers', like the runs routes.
import type { StoredEvent } from './events/types.js';
import { summarize } from './projection.js';

/** Event type -> the payload fields a viewer sees. Only the task's progress, its decisions, PRs and deploys. */
export const VIEWER_EVENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'issue.seen': ['issue', 'title', 'labels', 'author', 'owner', 'actionable', 'why'],
  'contract.agreed': ['issue', 'by'],
  'contract.missing': ['issue', 'why'],
  'issue.claimed': ['issue', 'instance', 'owner'],
  // The block's reason is on the task for everyone already (blockedReason).
  'issue.blocked': ['issue', 'owner', 'why'],
  'issue.retry': ['issue', 'attempt', 'kind', 'gave_up'],
  'review.level_set': ['issue', 'level'],
  'decision.asked': ['id', 'kind', 'issue', 'owner', 'question', 'options', 'recommendation'],
  'decision.answered': ['id', 'by', 'answer'],
  'plan.decided': ['issue', 'decision', 'answer', 'by'],
  'land.queued': ['issue', 'level'],
  'land.result': ['issue', 'outcome', 'landed'],
  'pr.opened': ['issue', 'number', 'url', 'draft'],
  'pr.ready': ['issue', 'number'],
  'pr.closed': ['issue', 'number', 'merged'],
  'merge.done': ['issue', 'number', 'url', 'title'],
  'deploy.requested': ['issue', 'env', 'sha'],
  'deploy.verified': ['issue', 'env', 'sha'],
  'deploy.failed': ['issue', 'env', 'sha', 'why'],
});

export const viewerMaySee = (type: string) => Object.hasOwn(VIEWER_EVENTS, type);

/** An event as a viewer sees it: only allowlisted types, with only their allowlisted fields; null otherwise. */
export function forViewer(e: StoredEvent): StoredEvent | null {
  if (!viewerMaySee(e.type)) return null;
  const p = e.payload as Record<string, unknown>;
  const payload = Object.fromEntries(VIEWER_EVENTS[e.type]!.filter((k) => Object.hasOwn(p, k)).map((k) => [k, p[k]]));
  return { ...e, payload } as StoredEvent;
}

export const forViewers = (events: StoredEvent[]): StoredEvent[] => events.map(forViewer).filter((e): e is StoredEvent => e !== null);

/** The Activity feed as a viewer sees it: the same shape as the projection's, built from the filtered events only. */
export function viewerActivity(events: StoredEvent[]) {
  return forViewers(events)
    .slice(-200)
    .reverse()
    .map((e) => ({ id: e.id, ts: e.ts, type: e.type, actor: e.actor, issue: typeof (e.payload as { issue?: unknown }).issue === 'number' ? (e.payload as { issue: number }).issue : null, summary: summarize(e) }));
}
