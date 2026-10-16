export interface TestDuration {
    name: string;
    ms: number;
}
/** A test name is cut to this many characters. */
export declare const NAME_CHARS = 300;
/** How many of a run's slowest tests are recorded (testrun.durations, ci.test_durations). */
export declare const RECORD_SLOWEST = 100;
/**
 * Every leaf test's duration the output prints, in any of the formats above, slowest first. A test named twice
 * (a retry, or two formats) keeps its longest. Empty when nothing is recognised.
 */
export declare function parseTestDurations(output: string): TestDuration[];
/** What a run records: its slowest RECORD_SLOWEST tests, and how many it printed durations for in all. */
export declare function recordable(output: string): {
    tests: TestDuration[];
    parsed: number;
};
