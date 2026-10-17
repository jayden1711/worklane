import type { EventPayload } from '../events/types.js';
import type { RunRequest } from '../runner.js';
import type { StuckMode } from '../stuck.js';
/** The roles the guard watches: the worker and the evaluators. */
export declare const STUCK_ROLES: ReadonlySet<string>;
/** The guard's option for a run, or nothing when it doesn't apply (another role, the guard off, or set by the caller). */
export declare function stuckOption(req: RunRequest, mode: StuckMode, who: {
    issue: number | null;
    role: string;
}, runId: () => string | null, emit: (p: EventPayload<'run.stuck'>) => void): Pick<RunRequest, 'stuck'>;
/** What the worker is told on its next attempt after a stuck stop. */
export declare function stuckFeedback(detail: string): string[];
