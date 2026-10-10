// Every action is a typed event. Projections (task state, dashboard,
// reports) are folds over these; nothing keeps private state.
import { z } from 'zod';

const issue = z.number().int().positive();
const sha = z.string().regex(/^[0-9a-f]{7,40}$/);

const CheckRunSchema = z.strictObject({
  check: z.string(),
  /** skipped: not run, because an earlier check already failed. */
  status: z.enum(['pass', 'fail', 'unavailable', 'skipped']),
  exitCode: z.number().nullable(),
  /** The end of a failing check's output: why it failed. */
  tail: z.string().max(2000).optional(),
  /** How long the check ran (absent for one that didn't run, and in older events). */
  duration_ms: z.number().int().nonnegative().optional(),
});

export const EventSchemas = {
  // backlog and ownership
  'issue.seen': z.strictObject({ issue, title: z.string(), labels: z.array(z.string()), author: z.string(), owner: z.string().nullable(), actionable: z.boolean(), why: z.string() }),
  'contract.agreed': z.strictObject({ issue, done_when: z.array(z.record(z.string(), z.unknown())), by: z.string() }),
  /** A worker run that failed before doing any work: blocked at once with claude's own report. */
  'run.startup_failed': z.strictObject({ issue, role: z.string(), attempt: z.number().int(), seconds: z.number().int(), turns: z.number().int(), detail: z.string() }),
  /** block_hash: the done_when block judged (contractKey), so an edit to it is checked again. Older events have none. */
  'contract.missing': z.strictObject({ issue, why: z.string(), block_hash: z.string().optional() }),
  'issue.claimed': z.strictObject({ issue, instance: z.string(), lease: sha, base: sha, owner: z.string() }),
  'issue.claim_lost': z.strictObject({ issue, instance: z.string(), holder: z.string().nullable() }),
  'issue.released': z.strictObject({ issue, instance: z.string(), why: z.string() }),
  'issue.blocked': z.strictObject({ issue, owner: z.string(), why: z.string() }),
  /** The worker found nothing to change, and the coordinator's own checks pass on the unchanged base. */
  'issue.no_change': z.strictObject({ issue, owner: z.string(), base: sha, why: z.string(), checks: z.array(CheckRunSchema) }),
  // runs
  'run.started': z.strictObject({ issue, role: z.string(), model: z.string(), worktree: z.string(), pid: z.number().int(), pgid: z.number().int().nullable(), attempt: z.number().int() }),
  'run.heartbeat': z.strictObject({ issue, role: z.string(), note: z.string() }),
  'run.finished': z.strictObject({
    issue,
    role: z.string(),
    reason: z.enum(['succeeded', 'failed', 'timed_out', 'stalled', 'rate_limited', 'canceled_by_reconciliation', 'budget_exhausted', 'auth_mismatch']),
    detail: z.string(),
  }),
  /** A run waited at least a second for its Claude login (one claude per login at a time). `issue` null: not an issue's run. */
  'run.lock_waited': z.strictObject({ issue: issue.nullable(), role: z.string(), model: z.string(), wait_ms: z.number().int().nonnegative() }),
  /** A run's try failed on a transient error and is retried after `wait_ms`; `cause` is the classified kind. */
  'run.transient_retry': z.strictObject({
    issue: issue.nullable(),
    role: z.string(),
    model: z.string(),
    attempt: z.number().int().positive(),
    cause: z.enum(['token_refresh', 'rate_limit', 'overloaded', 'server_error', 'network', 'other']),
    wait_ms: z.number().int().nonnegative(),
    detail: z.string(),
  }),
  /** The owner changed an instance setting (policy.yaml) from the dashboard. */
  'settings.changed': z.strictObject({ key: z.string(), from: z.unknown(), to: z.unknown(), by: z.string(), at: z.string() }),
  /** The coordinator picked up the instance's settings (policy.yaml changed); `error`: they were refused and the repo's values apply. */
  'settings.applied': z.strictObject({ settings: z.record(z.string(), z.unknown()), error: z.string().nullable() }),
  'run.cost': z.strictObject({ issue: issue.nullable(), role: z.string(), model: z.string(), usd: z.number().nonnegative(), turns: z.number().int().nonnegative() }),
  // verification
  'repro.frozen': z.strictObject({ issue, path: z.string(), hash: z.string().describe('git blob id of the committed test'), fails_on_base: z.literal(true) }),
  'repro.unavailable': z.strictObject({ issue, why: z.string() }),
  'change.proposed': z.strictObject({ issue, branch: z.string(), base: sha, head: sha, files: z.array(z.string()), lines: z.number().int().nonnegative(), patch_hash: z.string() }),
  'change.rejected': z.strictObject({ issue, why: z.string() }),
  /** A change hit the push limits: at stage 'change' (before verifying; the worker is told) or 'push' (refused at the push). */
  'push.refused': z.strictObject({ issue, head: sha, stage: z.enum(['change', 'push']), reasons: z.array(z.string()) }),
  'check.result': z.strictObject({ issue, head: sha, stage: z.string(), checks: z.array(CheckRunSchema) }),
  'eval.verdict': z.strictObject({
    issue,
    head: sha,
    patch_hash: z.string(),
    patch_correct: z.boolean(),
    test_correct: z.boolean(),
    confidence: z.enum(['high', 'medium', 'low']),
    advice: z.string(),
    /** Changed files the evaluator didn't read; any means the change goes to a human. */
    unread: z.array(z.string()).optional(),
    /** The evaluator's binding design-level flag; absent (an older or failed verdict) counts as doubt. */
    design_change: z.boolean().optional(),
    design_reason: z.string().optional(),
  }),
  'review.level_set': z.strictObject({ issue, head: sha, level: z.enum(['L0', 'L1', 'L2', 'L3']), reasons: z.array(z.string()) }),
  // decisions
  'decision.asked': z.strictObject({ id: z.string(), kind: z.enum(['land', 'question']), issue: issue.nullable(), owner: z.string(), question: z.string(), options: z.array(z.string()), recommendation: z.string(), receipts: z.array(z.string()) }),
  'decision.answered': z.strictObject({ id: z.string(), by: z.string(), answer: z.string() }),
  // landing and deploys
  'land.queued': z.strictObject({ issue, head: sha, level: z.enum(['L0', 'L1', 'L2', 'L3']) }),
  'land.result': z.strictObject({ issue, outcome: z.enum(['landed', 'pr_opened', 'conflict', 'red', 'rejected', 'error', 'deferred']), landed: sha.nullable(), detail: z.string() }),
  /** PR mode: a pull request the harness opened, and its watch. */
  'pr.opened': z.strictObject({ issue, number: z.number().int().positive(), url: z.string(), head: sha, draft: z.boolean() }),
  'pr.status': z.strictObject({
    issue,
    number: z.number().int().positive(),
    head: sha,
    ready: z.boolean(),
    reasons: z.array(z.string()),
    checks: z.array(z.strictObject({ name: z.string(), outcome: z.enum(['pass', 'fail', 'pending', 'cancelled', 'skipped', 'missing']) })),
  }),
  'pr.ready': z.strictObject({ issue, number: z.number().int().positive(), head: sha }),
  'pr.unready': z.strictObject({ issue, number: z.number().int().positive(), head: sha, why: z.string() }),
  'pr.closed': z.strictObject({ issue, number: z.number().int().positive(), merged: z.boolean() }),
  /** A CI fix run on a PR whose required check failed at `head`; `lease` is its claim. */
  'ci_fix.started': z.strictObject({ issue, number: z.number().int().positive(), head: sha, checks: z.array(z.string()), attempt: z.number().int().positive(), lease: sha }),
  /** pushed: a fix is on the branch at `head`; no_push: it ended without one (ci_fix.gave_up says why); interrupted: the coordinator restarted. */
  'ci_fix.finished': z.strictObject({ issue, number: z.number().int().positive(), outcome: z.enum(['pushed', 'no_push', 'interrupted']), head: sha.nullable(), detail: z.string() }),
  /** An eval of instructions the change touches, base vs head (base null: new instructions). `error`: it couldn't run. */
  'instructions.eval': z.strictObject({
    issue,
    head: sha,
    target: z.string(),
    base: z.strictObject({ passed: z.number().int(), total: z.number().int() }).nullable(),
    result: z.strictObject({ passed: z.number().int(), total: z.number().int() }).nullable(),
    dropped: z.boolean(),
    incomplete: z.boolean(),
    changes: z.array(z.strictObject({ id: z.string(), title: z.string(), base: z.string(), head: z.string() })),
    cost_usd: z.number().nonnegative(),
    error: z.string().optional(),
  }),
  /** The merge policy's call on a ready PR at `head`: merge it (auto) or wait for a human, and why. */
  'merge.decided': z.strictObject({ issue, number: z.number().int().positive(), head: sha, auto: z.boolean(), reasons: z.array(z.string()) }),
  /** Auto-merged: a merge commit `sha` of the evaluated `head`. */
  'merge.done': z.strictObject({ issue, number: z.number().int().positive(), head: sha, sha, url: z.string(), title: z.string() }),
  'merge.failed': z.strictObject({ issue, number: z.number().int().positive(), head: sha, why: z.string() }),
  /** The default branch's required checks on an auto-merge's commit. */
  'merge.main_result': z.strictObject({ issue, number: z.number().int().positive(), sha, outcome: z.enum(['green', 'red']), failed: z.array(z.string()) }),
  /** Auto-merge stopped for this instance (until the operator clears it); `revert` is the revert PR, if one was opened. */
  'merge.stopped': z.strictObject({ reason: z.string(), number: z.number().int().positive().nullable(), sha: sha.nullable(), revert: z.string().nullable() }),
  'merge.resumed': z.strictObject({ detail: z.string() }),
  /** No more fix runs on this PR; the owner is asked to look. */
  /** The combined-state check started: the default branch moved and touched what this PR touches (overlap). */
  'light_check.started': z.strictObject({ issue, number: z.number().int().positive(), head: sha, main_sha: sha, overlap: z.array(z.string()) }),
  /** merge: the fast tier passed on the combination; hold: it failed (a human decides); conflict: they don't merge. */
  'light_check.finished': z.strictObject({ issue, number: z.number().int().positive(), head: sha, main_sha: sha, overlap: z.array(z.string()), outcome: z.enum(['merge', 'hold', 'conflict']), wait_ms: z.number().int().nonnegative(), detail: z.string() }),
  /** GitHub reports a harness PR as conflicting with its base (recorded once per head). */
  'conflict_fix.detected': z.strictObject({ issue, number: z.number().int().positive(), head: sha, base_sha: sha }),
  'conflict_fix.started': z.strictObject({ issue, number: z.number().int().positive(), head: sha, base_sha: sha, strategy: z.literal('merge'), attempt: z.number().int().positive(), lease: sha }),
  /**
   * How a conflict fix ended. pushed: the resolved branch is on the PR (head); waits_owner and reasons: why it
   * then waits for a human. gave_up: no (more) fixes, the owner is asked. interrupted: a restart cut it short.
   */
  'conflict_fix.finished': z.strictObject({
    issue,
    number: z.number().int().positive(),
    base_sha: sha.nullable(),
    strategy: z.literal('merge'),
    outcome: z.enum(['pushed', 'no_push', 'gave_up', 'interrupted']),
    head: sha.nullable(),
    files: z.array(z.string()),
    waits_owner: z.boolean(),
    reasons: z.array(z.string()),
    detail: z.string(),
  }),
  'ci_fix.gave_up': z.strictObject({ issue, number: z.number().int().positive(), head: sha, reason: z.string() }),
  'land.batch': z.strictObject({ id: z.string(), issues: z.array(issue), tip: sha, outcome: z.enum(['started', 'landed', 'red', 'split', 'deferred']), detail: z.string() }),
  'deploy.requested': z.strictObject({ env: z.string(), sha }),
  'deploy.verified': z.strictObject({ env: z.string(), sha }),
  'deploy.failed': z.strictObject({ env: z.string(), sha, why: z.string() }),
  'baseline.recorded': z.strictObject({ sha, failing: z.array(z.string()) }),
  // guardrails and system
  'guardrail.decision': z.strictObject({ decision: z.enum(['deny', 'ask']), rule: z.string(), agent: z.boolean() }),
  'secret.detected': z.strictObject({ source: z.string(), findings: z.number().int().nonnegative() }),
  'coordinator.started': z.strictObject({ instance: z.string(), pid: z.number().int(), version: z.string() }),
  /** At start: state/ closed to other users (paths tightened, first 20 named) and old task files removed. */
  'state.tidied': z.strictObject({ tightened: z.number().int(), paths: z.array(z.string()), removed_tasks: z.number().int() }),
  'coordinator.tick': z.strictObject({ instance: z.string(), dispatched: z.number().int(), reconciled: z.number().int() }),
  'report.posted': z.strictObject({ day: z.string(), slot: z.string(), issue: z.number().int().nullable() }),
  'emergency.stop': z.strictObject({ by: z.string(), reason: z.string(), running: z.number().int() }),
  'emergency.resume': z.strictObject({ instance: z.string() }),
  'nightly.queued': z.strictObject({ day: z.string(), jobs: z.array(z.string()) }),
  'governor.hold': z.strictObject({ reason: z.string(), load: z.number().nullable(), free_disk_pct: z.number().nullable() }),
  'governor.release': z.strictObject({ load: z.number().nullable(), free_disk_pct: z.number().nullable() }),
  /** A ready task waits: it would change a hotspot file a running task changes too (`by`). Recorded once per wait. */
  'hotspot.held': z.strictObject({ issue, by: issue, files: z.array(z.string()), reason: z.string() }),
  /** A held task started (or stopped being ready): how long it waited, on which files. */
  'hotspot.released': z.strictObject({ issue, waited_ms: z.number().int().nonnegative(), files: z.array(z.string()), started: z.boolean() }),
  'coordinator.error': z.strictObject({ instance: z.string(), where: z.string(), kind: z.string(), message: z.string() }),
} as const;

export type EventType = keyof typeof EventSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof EventSchemas)[T]>;

export interface StoredEvent<T extends EventType = EventType> {
  id: number;
  ts: string;
  type: T;
  actor: string;
  source: 'coordinator' | 'github' | 'agent' | 'human';
  payload: EventPayload<T>;
}
