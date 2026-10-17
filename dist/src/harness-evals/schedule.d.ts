/** The engine's own root (dist/src/harness-evals/ is three levels down). */
export declare const ENGINE_ROOT: string;
/** The commit of the engine running this code, or null when it can't tell. */
export declare function engineSha(root?: string): string | null;
/** Did src/ change between two commits, in the first of these clones that has both? null: none can tell. */
export declare function srcChanged(from: string, to: string, clones: string[]): boolean | null;
export declare const WEEK_MS: number;
/** When the nightly window opens if tests.yaml sets no nightly_at. */
export declare const DEFAULT_EVAL_AT = "03:00";
/**
 * Whether a run is due now, and why. Past the nightly time today with no run yet today; then a change first (the
 * engine is not the last run's and src/ changed since it, or nothing tells), else weekly (none in the last 7 days).
 * The first run of all is a weekly one (a change needs a run before it to compare with), unless weekly runs are off.
 */
export declare function harnessEvalDue(o: {
    now: Date;
    at: string | undefined;
    weekly: boolean;
    onChange: boolean;
    /** Day (YYYY-MM-DD, local) of the last run, of any trigger. */
    lastRunDay: string | null;
    /** When the last weekly run ended (ISO). */
    lastWeekly: string | null;
    /** The engine the last run evaluated. */
    lastEngine: string | null;
    engine: string | null;
    changed: (from: string, to: string) => boolean | null;
}): 'weekly' | 'change' | null;
