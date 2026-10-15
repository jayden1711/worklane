import { summarize } from './projection.js';
/** Event type -> the payload fields a viewer sees. Only the task's progress, its decisions, PRs and deploys. */
export const VIEWER_EVENTS = Object.freeze({
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
    // PR batches: their status only, never their runs, tiers, commits or why a PR came back.
    'pr_batch.queued': ['issue', 'number'],
    'pr_batch.step': ['id', 'step'],
    'deploy.requested': ['issue', 'env', 'sha'],
    'deploy.verified': ['issue', 'env', 'sha'],
    'deploy.failed': ['issue', 'env', 'sha', 'why'],
    // A test run's outcome: each tier's pass or fail (results holds { tier, ok } only), never its log or summary.
    'testrun.finished': ['id', 'sha', 'kind', 'prs', 'ok', 'outcome', 'results'],
    // How the default branch is guarded (GitHub, the main watch, off): the mode only, never why or what it found.
    'main_watch.mode': ['mode'],
});
export const viewerMaySee = (type) => Object.hasOwn(VIEWER_EVENTS, type);
/** An event as a viewer sees it: only allowlisted types, with only their allowlisted fields; null otherwise. */
export function forViewer(e) {
    if (!viewerMaySee(e.type))
        return null;
    const p = e.payload;
    const payload = Object.fromEntries(VIEWER_EVENTS[e.type].filter((k) => Object.hasOwn(p, k)).map((k) => [k, p[k]]));
    return { ...e, payload };
}
export const forViewers = (events) => events.map(forViewer).filter((e) => e !== null);
/** The Activity feed as a viewer sees it: the same shape as the projection's, built from the filtered events only. */
export function viewerActivity(events) {
    return forViewers(events)
        .slice(-200)
        .reverse()
        .map((e) => ({ id: e.id, ts: e.ts, type: e.type, actor: e.actor, issue: typeof e.payload.issue === 'number' ? e.payload.issue : null, summary: summarize(e) }));
}
/**
 * The dashboard state as a viewer sees it: an allowlist of its keys, and of each task's fields. Costs and spend
 * (tasks' costUsd, spendToday, spendByRole), the budget and agent runs are the owners' and writers' (like
 * /api/runs and /api/throughput), so they are not on it; a key or task field added later stays hidden until allowed.
 */
export const VIEWER_STATE_KEYS = Object.freeze([
    'brand', 'project', 'user', 'role', 'via', 'owners', 'slots', 'lastId', 'tasks', 'decisions', 'landedToday', 'baseline', 'deploys',
    'coordinator', 'activity', 'landQueue', 'batches', 'governor', 'emergency', 'reports', 'inbox', 'prCounts', 'costBasis', 'protection',
    'canReadIntake', 'canReadThroughput', 'canReadReports', 'canReadRuns', 'canReadDigest', 'canReadLogs', 'canReadMachine', 'canWrite', 'canReadAudit',
]);
export const VIEWER_TASK_FIELDS = Object.freeze([
    'issue', 'title', 'labels', 'author', 'owner', 'delegate', 'status', 'actionable', 'why', 'level', 'levelReasons', 'doneWhen', 'verdict',
    'attempts', 'head', 'landed', 'deployed', 'repro', 'openDecision', 'blockedReason', 'lastActivity', 'firstSeen', 'eventIds',
]);
/** A decision's fields a viewer sees: the question and its answer, never its receipts (run and agent detail). */
export const VIEWER_DECISION_FIELDS = Object.freeze(['id', 'kind', 'issue', 'owner', 'question', 'options', 'recommendation', 'askedAt', 'answer', 'canAnswer']);
/** A batch as a viewer sees it: its status and what is in it, never its detail (test output, culprits' tiers) or commit. */
export const VIEWER_BATCH_FIELDS = Object.freeze(['id', 'kind', 'issues', 'prs', 'outcome', 'at']);
/** The default branch's protection as a viewer sees it: GitHub enforced, the main watch, or off. */
export const VIEWER_PROTECTION_FIELDS = Object.freeze(['mode']);
/** The machine's slots as a viewer sees them: how many are in use and how many there are, not which agents hold them. */
export const VIEWER_SLOT_FIELDS = Object.freeze(['cap', 'running']);
/**
 * A watchdog incident as a viewer sees it (GET /api/health/incidents): that something broke, its fixed title, where
 * and since when; never its detail, its key, what was tried or the fix (paths, units, commits, errors).
 */
export const VIEWER_INCIDENT_FIELDS = Object.freeze(['id', 'kind', 'instance', 'severity', 'title', 'since', 'resolvedAt']);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
const each = (keys) => (xs) => (Array.isArray(xs) ? xs.map((x) => pick(x, keys)) : []);
const tasksOnly = each(VIEWER_TASK_FIELDS);
const decisionsOnly = each(VIEWER_DECISION_FIELDS);
const batchesOnly = each(VIEWER_BATCH_FIELDS);
/** Incidents with only the fields a viewer may see. */
export const incidentsForViewer = each(VIEWER_INCIDENT_FIELDS);
/**
 * A state as a viewer may have it: only the allowlisted keys; tasks and decisions (also the inbox's) with only
 * their allowlisted fields; the slots as counts; the coordinator's errors as a count, never their text.
 */
export function stateForViewer(state) {
    const out = pick(state, VIEWER_STATE_KEYS);
    if ('tasks' in out)
        out.tasks = tasksOnly(out.tasks);
    if ('decisions' in out)
        out.decisions = decisionsOnly(out.decisions);
    if ('batches' in out)
        out.batches = batchesOnly(out.batches);
    if (out.slots && typeof out.slots === 'object')
        out.slots = pick(out.slots, VIEWER_SLOT_FIELDS);
    if (out.inbox && typeof out.inbox === 'object') {
        const ib = out.inbox;
        out.inbox = { decisions: decisionsOnly(ib.decisions), blocked: tasksOnly(ib.blocked), notify: tasksOnly(ib.notify) };
    }
    // How the default branch is guarded: the mode only, never the commits checked or an alert's detail.
    if (out.protection && typeof out.protection === 'object')
        out.protection = pick(out.protection, VIEWER_PROTECTION_FIELDS);
    // Only the errors still current (src/projection.ts CoordinatorErrors), each as often as it happened; never the earlier ones.
    if (Array.isArray(state.errors))
        out.errorCount = state.errors.reduce((n, e) => n + (typeof e?.count === 'number' ? e.count : 1), 0);
    return out;
}
//# sourceMappingURL=viewer-events.js.map