import type { EventPayload, EventType } from './events/types.js';
import type { MetricEvent } from './merge-metrics.js';
/** At most one GitHub API call per this long. */
export declare const CI_METRICS_CALL_MS = 60000;
/** Merged PRs this many days back are measured. */
export declare const CI_LOOKBACK_DAYS = 30;
/** The default branch's CI jobs are read for slow tests at most this often. */
export declare const SLOW_TESTS_EVERY_MS: number;
/** A merge commit's CI is read once it is at least this old (its jobs have finished). */
export declare const SLOW_TESTS_SETTLE_MS: number;
/** At most this many Actions jobs' logs per commit. */
export declare const MAX_JOBS = 10;
/** A merged PR's check runs are asked at most this many times before it is recorded as not measurable. */
export declare const CI_METRICS_TRIES = 3;
export interface CiCheckRun {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
    /** The app that made it (`github-actions` for an Actions job), or null. */
    app: string | null;
}
/** The calls the metrics make: one REST request each (github/ci-metrics-api.ts). */
export interface CiMetricsApi {
    checkRuns(sha: string): Promise<CiCheckRun[]>;
    /** An Actions job's log, as text. */
    jobLog(id: number): Promise<string>;
}
/**
 * A head's CI wall-clock from its check runs: the first one's start to the last required check's completion (every
 * check's when `required` is empty). Not measurable (wall_ms null, and why) when a required check never completed.
 */
export declare function prWallClock(runs: CiCheckRun[], required: string[]): Pick<EventPayload<'ci.pr_timing'>, 'wall_ms' | 'first_started' | 'last_completed' | 'why'>;
export interface CiMetricsDeps {
    api: CiMetricsApi;
    /** The event log's events of the types this reads. */
    events: (types: string[]) => MetricEvent[];
    emit: <T extends EventType>(type: T, payload: EventPayload<T>) => void;
    /** config.yaml required_checks, as loaded now. */
    required: () => string[];
    now?: () => number;
}
export declare class CiMetrics {
    private readonly d;
    private lastCall;
    private tries;
    /** The Actions jobs of a commit still to read, one log per call. */
    private jobs;
    constructor(d: CiMetricsDeps);
    private now;
    /** One GitHub call at most, when one is due: a job log queued, else a merged PR's timing, else the day's slow tests. */
    step(): Promise<void>;
}
