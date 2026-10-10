// Is a pull request the harness opened ready to merge? Pure logic over what
// GitHub reports, so the watcher, the merge policy and the tests share one
// answer. Fails closed: no required checks configured, a check missing,
// cancelled, skipped or still running, a head that isn't the commit the
// evaluator approved, or no approval at all, and it is not ready.
import type { CommitCheck } from './backlog/types.js';

export type CheckOutcome = 'pass' | 'fail' | 'pending' | 'cancelled' | 'skipped' | 'missing';

export interface RequiredCheck {
  name: string;
  outcome: CheckOutcome;
  /** The check run's id (its Actions job), for fetching the log of a failure. */
  id?: number;
  url?: string;
}

function outcomeOf(c: CommitCheck): CheckOutcome {
  if (c.status !== 'completed') return 'pending';
  if (c.conclusion === 'success') return 'pass';
  if (c.conclusion === 'cancelled') return 'cancelled';
  // Neutral counts as not passed: the harness only trusts an explicit success.
  if (c.conclusion === 'skipped' || c.conclusion === 'neutral') return 'skipped';
  // failure, timed_out, action_required, startup_failure, stale, or anything new.
  return 'fail';
}

/** Each required check's outcome on a commit; a check run wins over a status of the same name. */
export function requiredOutcomes(required: string[], checks: CommitCheck[]): RequiredCheck[] {
  return required.map((name) => {
    const c = checks.find((x) => x.name === name && x.source === 'check_run') ?? checks.find((x) => x.name === name);
    if (!c) return { name, outcome: 'missing' as const };
    return { name, outcome: outcomeOf(c), ...(c.id !== undefined ? { id: c.id } : {}), ...(c.url ? { url: c.url } : {}) };
  });
}

export interface Readiness {
  ready: boolean;
  /** Why it isn't ready (empty when it is). */
  reasons: string[];
  checks: RequiredCheck[];
  /** The required checks that failed (not pending, cancelled or skipped): what a CI fix run would look at. */
  failed: RequiredCheck[];
}

export function readiness(o: { required: string[]; checks: CommitCheck[]; head: string; evaluated: { head: string; approved: boolean } | null }): Readiness {
  const checks = requiredOutcomes(o.required, o.checks);
  const reasons: string[] = [];
  if (!o.required.length) reasons.push('no required checks are configured (required_checks in config.yaml), so nothing is ever marked ready');
  if (!o.evaluated) reasons.push('no evaluator verdict');
  else {
    if (!o.evaluated.approved) reasons.push('the evaluator did not approve the change');
    if (o.evaluated.head !== o.head) reasons.push(`the head ${o.head.slice(0, 8)} is not the commit the evaluator approved (${o.evaluated.head.slice(0, 8)})`);
  }
  for (const c of checks) if (c.outcome !== 'pass') reasons.push(`${c.name}: ${c.outcome}`);
  return { ready: reasons.length === 0, reasons, checks, failed: checks.filter((c) => c.outcome === 'fail') };
}
