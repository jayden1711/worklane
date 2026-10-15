import { z } from 'zod';
import type { StoredEvent } from './events/types.js';
/** The label on an optimization task: it routes the build to the strongest model (src/model-routing.ts). */
export declare const OPTIMIZE_LABEL = "optimize";
/** A `targets` entry standing for the slowest test the metrics recorded (testrun.durations, ci.test_durations). */
export declare const SLOWEST_TESTS = "slowest_tests";
/** The event types item 27's metrics record per-test durations in; read by name, so an older log simply has none. */
export declare const DURATION_EVENTS: readonly ["testrun.durations", "ci.test_durations"];
/** The smallest improvement that counts, as a fraction of the baseline median, whatever the spread. */
export declare const MIN_GAIN = 0.01;
declare const benchmark: z.ZodObject<{
    name: z.ZodString;
    command: z.ZodString;
    repeats: z.ZodDefault<z.ZodNumber>;
    metric: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"wall_ms">, z.ZodObject<{
        pattern: z.ZodString;
        unit: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>]>>;
    lower_is_better: z.ZodDefault<z.ZodBoolean>;
    profile: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** benchmarks.yaml in the config folder: the project's declared benchmarks. No framework: a command and a number. */
export declare const BenchmarksConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    benchmarks: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        command: z.ZodString;
        repeats: z.ZodDefault<z.ZodNumber>;
        metric: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"wall_ms">, z.ZodObject<{
            pattern: z.ZodString;
            unit: z.ZodDefault<z.ZodString>;
        }, z.core.$strict>]>>;
        lower_is_better: z.ZodDefault<z.ZodBoolean>;
        profile: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type BenchmarksConfig = z.infer<typeof BenchmarksConfig>;
export type Benchmark = z.infer<typeof benchmark>;
/** config.yaml `optimize`: the weekly pass, off by default. */
export declare const OptimizeConfig: z.ZodPrefault<z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    weekday: z.ZodDefault<z.ZodNumber>;
    at: z.ZodDefault<z.ZodString>;
    budget_usd: z.ZodDefault<z.ZodNumber>;
    max_prs: z.ZodDefault<z.ZodNumber>;
    targets: z.ZodDefault<z.ZodArray<z.ZodString>>;
    slow_test_command: z.ZodOptional<z.ZodString>;
    repeats: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>>;
export type OptimizeConfig = z.infer<typeof OptimizeConfig>;
/** A target the pass can pick: a declared benchmark, or one slow test. */
export interface Target {
    /** `bench:<name>` or `test:<test name>`: what attempts are recorded by. */
    key: string;
    label: string;
    command: string;
    repeats: number;
    metric: Benchmark['metric'];
    unit: string;
    lowerIsBetter: boolean;
    profile?: string;
}
/** The errors in an optimize config against the benchmarks declared (for the config's cross-check). */
export declare function optimizeProblems(o: OptimizeConfig, benchmarks: BenchmarksConfig | undefined): {
    path: string;
    message: string;
}[];
/** The slowest test the metrics recorded in the week before `now`: the highest median of its recorded durations. */
export declare function slowestTests(events: readonly {
    type: string;
    ts: string;
    payload: unknown;
}[], now: number): {
    name: string;
    ms: number;
}[];
/** Every target, in priority order (config `targets`, else every benchmark then the slowest test). */
export declare function targets(o: OptimizeConfig, benchmarks: BenchmarksConfig | undefined, slow: {
    name: string;
    ms: number;
}[]): Target[];
/** A target by its key, as the config now declares it (null: no longer declared). */
export declare function targetByKey(key: string, o: OptimizeConfig, benchmarks: BenchmarksConfig | undefined): Target | null;
/** Due on `weekday` at or after `at` (local time), when the last pass started 6 or more days ago (or never). */
export declare function optimizeDue(now: Date, lastStartedAt: string | null, o: Pick<OptimizeConfig, 'weekday' | 'at'>): boolean;
/** The top target: the first one in priority order never tried, else the one tried longest ago. */
export declare function pickTarget(all: Target[], lastTried: (key: string) => number | null): Target | null;
/** One run's number: its wall time, or the last match of the metric's pattern in its output. Null: none printed. */
export declare function readMetric(m: Benchmark['metric'], out: string, wallMs: number): number | null;
export declare function median(xs: readonly number[]): number;
/** The median absolute deviation: the spread, robust to one slow outlier. */
export declare function mad(xs: readonly number[]): number;
export interface Sample {
    runs: number[];
    median: number;
    mad: number;
}
export declare const sample: (runs: number[]) => Sample;
export interface Verdict {
    improved: boolean;
    /** How much better the change's median is (in the metric's unit; negative: worse). */
    gain: number;
    /** As a percentage of the baseline median. */
    pct: number;
    /** What a gain must beat: 2 x the larger MAD, at least MIN_GAIN of the baseline median. */
    noise: number;
    why: string;
}
/** The rule: an improvement only when the change's median beats the baseline's by more than the noise. */
export declare function judge(before: Sample, after: Sample, lowerIsBetter: boolean, unit?: string): Verdict;
/** The task's brief: what to change, and the one rule it is measured by. Its done_when is the full suite. */
export declare function optimizeIssue(t: Target, base: Sample, sha: string, profile: string): {
    title: string;
    body: string;
};
/** The PR body's measurement section: before and after, and every raw run. */
export declare function prLines(target: string, unit: string, lowerIsBetter: boolean, before: Sample & {
    sha: string;
}, after: Sample & {
    sha: string;
}, v: Pick<Verdict, 'gain' | 'pct' | 'noise'>): string[];
/**
 * The PR body's measurement section, from an issue's events: the improved result at `head` and its pass (for the
 * unit). None for any PR that is not an optimization measured at that head.
 */
export declare function optimizePrLines(events: readonly Pick<StoredEvent, 'type' | 'payload'>[], head: string): string[];
export {};
