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

/**
 * The dashboard state as a viewer sees it: an allowlist of its keys, and of each task's fields. Costs and spend
 * (tasks' costUsd, spendToday, spendByRole), the budget and agent runs are the owners' and writers' (like
 * /api/runs and /api/throughput), so they are not on it; a key or task field added later stays hidden until allowed.
 */
export const VIEWER_STATE_KEYS: readonly string[] = Object.freeze([
  'brand', 'project', 'user', 'role', 'via', 'owners', 'slots', 'lastId', 'tasks', 'decisions', 'landedToday', 'baseline', 'deploys',
  'coordinator', 'errors', 'activity', 'landQueue', 'batches', 'governor', 'emergency', 'reports', 'inbox', 'prCounts', 'costBasis',
  'canReadIntake', 'canReadThroughput', 'canReadReports', 'canReadRuns', 'canReadDigest', 'canReadLogs', 'canReadMachine', 'canWrite', 'canReadAudit',
]);
export const VIEWER_TASK_FIELDS: readonly string[] = Object.freeze([
  'issue', 'title', 'labels', 'author', 'owner', 'delegate', 'status', 'actionable', 'why', 'level', 'levelReasons', 'doneWhen', 'verdict',
  'attempts', 'head', 'landed', 'deployed', 'repro', 'openDecision', 'blockedReason', 'lastActivity', 'firstSeen', 'eventIds',
]);

const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
const tasksOnly = (ts: unknown) => (Array.isArray(ts) ? ts.map((t) => pick(t as Record<string, unknown>, VIEWER_TASK_FIELDS)) : []);

/** A state as a viewer may have it: only the allowlisted keys; tasks (also the inbox's) with only the allowlisted fields. */
export function stateForViewer(state: Record<string, unknown>): Record<string, unknown> {
  const out = pick(state, VIEWER_STATE_KEYS);
  if ('tasks' in out) out.tasks = tasksOnly(out.tasks);
  if (out.inbox && typeof out.inbox === 'object') {
    const ib = out.inbox as Record<string, unknown>;
    out.inbox = { decisions: ib.decisions, blocked: tasksOnly(ib.blocked), notify: tasksOnly(ib.notify) };
  }
  return out;
}
