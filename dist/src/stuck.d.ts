export declare const STUCK_FLAG_AT = 5;
export declare const STUCK_STOP_AT = 8;
/** off: not run. dry-run: verdicts are logged, nothing is stopped. on: a stop verdict stops the run as "stuck". */
export type StuckMode = 'off' | 'dry-run' | 'on';
export interface StuckVerdict {
    kind: 'flag' | 'stop';
    tool: string;
    /** The repeated input, clipped for display. */
    input: string;
    /** Identical calls in a row (any result), and identical failures in a row, when the verdict was reached. */
    repeats: number;
    failures: number;
}
/** What the caller does with a verdict: dry-run only ever logs; a stop stops the run only when the mode is on. */
export declare function stuckAction(mode: StuckMode, v: StuckVerdict): 'log' | 'stop' | null;
export declare const isDenial: (text: string) => boolean;
export declare class StuckDetector {
    private pending;
    private key;
    private repeats;
    private failures;
    private flagged;
    private stopped;
    /** The longest streaks seen, for the run record. */
    readonly longest: {
        repeats: number;
        failures: number;
        tool: string;
        input: string;
    };
    /** A tool call was made (from the stream: an assistant tool_use block, or a recorded feed's tool item). */
    call(id: string, tool: string, input: string): void;
    /** Its result arrived. Returns a verdict the first time the run crosses a threshold. */
    result(id: string, ok: boolean, output: string): StuckVerdict | null;
    /** One stream-json line from the runner: tool_use blocks are calls, tool_result blocks their results. */
    line(j: unknown): StuckVerdict[];
}
/** A recorded feed (the run's `.feed.jsonl` items) replayed through a fresh detector: every verdict it would give. */
export declare function replayFeed(items: {
    kind: string;
    id?: string;
    tool?: string;
    input?: string;
    status?: string;
    output?: string;
}[]): {
    verdicts: StuckVerdict[];
    longest: StuckDetector['longest'];
};
export interface StuckScan {
    /** Runs with a recorded feed, replayed. */
    scanned: number;
    /** Runs the guard would have flagged (a stopped run was flagged first), and stopped. */
    flagged: number;
    stopped: number;
    /** Run records without a feed: their steps keep only commands and writes, too little to replay. */
    noFeed: number;
    examples: {
        run: string;
        kind: StuckVerdict['kind'];
        tool: string;
        input: string;
        failures: number;
    }[];
}
/** Read-only: how many of the recorded runs in a state dir the guard would have flagged or stopped. */
export declare function scanStuck(stateDir: string): StuckScan;
