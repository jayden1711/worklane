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
});

export const EventSchemas = {
  // backlog and ownership
  'issue.seen': z.strictObject({ issue, title: z.string(), labels: z.array(z.string()), author: z.string(), owner: z.string().nullable(), actionable: z.boolean(), why: z.string() }),
  'contract.agreed': z.strictObject({ issue, done_when: z.array(z.record(z.string(), z.unknown())), by: z.string() }),
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
  'coordinator.tick': z.strictObject({ instance: z.string(), dispatched: z.number().int(), reconciled: z.number().int() }),
  'report.posted': z.strictObject({ day: z.string(), slot: z.string(), issue: z.number().int().nullable() }),
  'emergency.stop': z.strictObject({ by: z.string(), reason: z.string(), running: z.number().int() }),
  'emergency.resume': z.strictObject({ instance: z.string() }),
  'nightly.queued': z.strictObject({ day: z.string(), jobs: z.array(z.string()) }),
  'governor.hold': z.strictObject({ reason: z.string(), load: z.number().nullable(), free_disk_pct: z.number().nullable() }),
  'governor.release': z.strictObject({ load: z.number().nullable(), free_disk_pct: z.number().nullable() }),
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
