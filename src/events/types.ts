// Every action is a typed event. Projections (task state, dashboard,
// reports, scorecard) are folds over these; nothing keeps private state.
import { z } from 'zod';

const issue = z.number().int().positive();
const sha = z.string().regex(/^[0-9a-f]{7,40}$/);

const CheckRunSchema = z.strictObject({
  check: z.string(),
  status: z.enum(['pass', 'fail', 'unavailable']),
  exitCode: z.number().nullable(),
});

export const EventSchemas = {
  // backlog and ownership
  'issue.seen': z.strictObject({ issue, title: z.string(), labels: z.array(z.string()), author: z.string(), owner: z.string().nullable(), actionable: z.boolean(), why: z.string() }),
  'contract.agreed': z.strictObject({ issue, done_when: z.array(z.record(z.string(), z.unknown())), by: z.string() }),
  'contract.missing': z.strictObject({ issue, why: z.string() }),
  'issue.claimed': z.strictObject({ issue, instance: z.string(), lease: sha, base: sha, owner: z.string() }),
  'issue.claim_lost': z.strictObject({ issue, instance: z.string(), holder: z.string().nullable() }),
  'issue.released': z.strictObject({ issue, instance: z.string(), why: z.string() }),
  'issue.blocked': z.strictObject({ issue, owner: z.string(), why: z.string() }),
  // runs
  'run.started': z.strictObject({ issue, role: z.string(), model: z.string(), worktree: z.string(), pid: z.number().int(), pgid: z.number().int().nullable(), attempt: z.number().int() }),
  'run.heartbeat': z.strictObject({ issue, role: z.string(), note: z.string() }),
  'run.finished': z.strictObject({
    issue,
    role: z.string(),
    reason: z.enum(['succeeded', 'failed', 'timed_out', 'stalled', 'rate_limited', 'canceled_by_reconciliation', 'budget_exhausted', 'auth_mismatch']),
    detail: z.string(),
  }),
  'run.cost': z.strictObject({ issue, role: z.string(), model: z.string(), usd: z.number().nonnegative(), turns: z.number().int().nonnegative() }),
  // verification
  'repro.frozen': z.strictObject({ issue, path: z.string(), hash: z.string().describe('git blob id of the committed test'), fails_on_base: z.literal(true) }),
  'repro.unavailable': z.strictObject({ issue, why: z.string() }),
  'change.proposed': z.strictObject({ issue, branch: z.string(), base: sha, head: sha, files: z.array(z.string()), lines: z.number().int().nonnegative(), patch_hash: z.string() }),
  'change.rejected': z.strictObject({ issue, why: z.string() }),
  'check.result': z.strictObject({ issue, head: sha, stage: z.string(), checks: z.array(CheckRunSchema) }),
  'eval.verdict': z.strictObject({
    issue,
    head: sha,
    patch_hash: z.string(),
    patch_correct: z.boolean(),
    test_correct: z.boolean(),
    confidence: z.enum(['high', 'medium', 'low']),
    advice: z.string(),
  }),
  'review.level_set': z.strictObject({ issue, head: sha, level: z.enum(['L0', 'L1', 'L2', 'L3']), reasons: z.array(z.string()) }),
  // decisions
  'decision.asked': z.strictObject({ id: z.string(), kind: z.enum(['land', 'question']), issue: issue.nullable(), owner: z.string(), question: z.string(), options: z.array(z.string()), recommendation: z.string(), receipts: z.array(z.string()) }),
  'decision.answered': z.strictObject({ id: z.string(), by: z.string(), answer: z.string() }),
  // landing and deploys
  'land.queued': z.strictObject({ issue, head: sha, level: z.enum(['L0', 'L1', 'L2', 'L3']) }),
  'land.result': z.strictObject({ issue, outcome: z.enum(['landed', 'conflict', 'red', 'rejected', 'error']), landed: sha.nullable(), detail: z.string() }),
  'deploy.requested': z.strictObject({ env: z.string(), sha }),
  'deploy.verified': z.strictObject({ env: z.string(), sha }),
  'deploy.failed': z.strictObject({ env: z.string(), sha, why: z.string() }),
  'baseline.recorded': z.strictObject({ sha, failing: z.array(z.string()) }),
  // guardrails and system
  'guardrail.decision': z.strictObject({ decision: z.enum(['deny', 'ask']), rule: z.string(), agent: z.boolean() }),
  'secret.detected': z.strictObject({ source: z.string(), findings: z.number().int().nonnegative() }),
  'coordinator.started': z.strictObject({ instance: z.string(), pid: z.number().int(), version: z.string() }),
  'coordinator.tick': z.strictObject({ instance: z.string(), dispatched: z.number().int(), reconciled: z.number().int() }),
  'coordinator.error': z.strictObject({ instance: z.string(), where: z.string(), kind: z.string(), message: z.string() }),
  'lesson.proposed': z.strictObject({ issue, worked: z.string(), failed: z.string(), fix: z.string() }),
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
