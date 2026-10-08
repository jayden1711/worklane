// Check outcomes. Only an explicit pass is green: cancelled, skipped,
// neutral, timed out, stale, missing or unknown are never counted as passing.
// A "hold" (waiting on a decision, a lock or a running check) is neither a
// pass nor a failure.

export type Outcome = 'pass' | 'fail' | 'hold';

/** GitHub check-run / commit-status fields as the API returns them. */
export interface GitHubCheck {
  name: string;
  status?: string | null; // queued | in_progress | completed | waiting | requested | pending
  conclusion?: string | null; // success | failure | neutral | cancelled | skipped | timed_out | action_required | stale | startup_failure | null
  state?: string | null; // commit statuses: success | failure | error | pending
}

export function classifyGitHubCheck(c: GitHubCheck): Outcome {
  if (c.state !== undefined && c.state !== null && c.status === undefined) {
    if (c.state === 'success') return 'pass';
    if (c.state === 'pending') return 'hold';
    return 'fail';
  }
  if (c.status !== 'completed') {
    return ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(c.status ?? '') ? 'hold' : 'fail';
  }
  if (c.conclusion === 'success') return 'pass';
  if (c.conclusion === 'action_required') return 'hold';
  return 'fail';
}

export interface GateResult {
  outcome: Outcome;
  failed: string[];
  held: string[];
  missing: string[];
}

/**
 * Combine checks for a gate. Every required check must be present and pass;
 * a required check that never reported is a failure, not a pass.
 */
export function gate(required: string[], checks: GitHubCheck[]): GateResult {
  const byName = new Map<string, Outcome[]>();
  for (const c of checks) {
    const list = byName.get(c.name) ?? [];
    list.push(classifyGitHubCheck(c));
    byName.set(c.name, list);
  }
  const failed: string[] = [];
  const held: string[] = [];
  const missing: string[] = [];
  for (const name of required) {
    const outcomes = byName.get(name);
    if (!outcomes || outcomes.length === 0) missing.push(name);
    else if (outcomes.includes('fail')) failed.push(name);
    else if (outcomes.includes('hold')) held.push(name);
  }
  // Non-required checks can still fail a gate, but never pass one.
  for (const [name, outcomes] of byName) {
    if (!required.includes(name) && outcomes.includes('fail')) failed.push(name);
  }
  const outcome: Outcome = failed.length || missing.length ? 'fail' : held.length ? 'hold' : 'pass';
  return { outcome, failed, held, missing };
}

/** Count outcomes for reports and the scorecard. Holds are never failures. */
export function tally(outcomes: Outcome[]): Record<Outcome, number> {
  const t: Record<Outcome, number> = { pass: 0, fail: 0, hold: 0 };
  for (const o of outcomes) t[o]++;
  return t;
}
