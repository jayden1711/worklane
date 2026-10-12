// The stuck-run guard on the coordinator's side: which runs it watches, in which mode (the instance's setting, from
// the policy), and every verdict recorded as a run.stuck event. The detector itself is stuck.ts; the runner applies
// it to the stream and stops the run only in mode 'on'. Ships in dry-run: verdicts are logged, nothing is stopped.
import type { EventPayload } from '../events/types.js';
import type { RunRequest } from '../runner.js';
import type { StuckMode } from '../stuck.js';

/** The roles the guard watches: the worker and the evaluators. */
export const STUCK_ROLES: ReadonlySet<string> = new Set(['worker', 'evaluator-verdict', 'evaluator-repro']);

/** The guard's option for a run, or nothing when it doesn't apply (another role, the guard off, or set by the caller). */
export function stuckOption(req: RunRequest, mode: StuckMode, who: { issue: number | null; role: string }, runId: () => string | null, emit: (p: EventPayload<'run.stuck'>) => void): Pick<RunRequest, 'stuck'> {
  if (req.stuck || mode === 'off' || !STUCK_ROLES.has(req.role)) return {};
  return {
    stuck: {
      mode,
      onVerdict: (v, action) => emit({ issue: who.issue, role: who.role, run: runId(), kind: v.kind, mode, action, tool: v.tool, input: v.input.slice(0, 300), repeats: v.repeats, failures: v.failures }),
    },
  };
}

/** What the worker is told on its next attempt after a stuck stop. */
export function stuckFeedback(detail: string): string[] {
  return [`Your previous attempt was stopped because it kept repeating the same failing call (${detail.replace(/^stopped as stuck: /, '')}). Try a different approach rather than repeating it.`];
}
