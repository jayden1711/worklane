import type { EventLog } from '../events/log.js';
/** How long after each failed check the next one runs: the first three, then SANDBOX_RETRY_MAX_MS every time. */
export declare const SANDBOX_RETRY_MS: readonly [30000, 60000, 120000];
export declare const SANDBOX_RETRY_MAX_MS = 300000;
export declare const sandboxRetryMs: (failures: number) => number;
/** What a run reads before it starts (./run.ts): the newest check's result. */
export interface SandboxState {
    readonly ok: boolean;
    /** The check's FAIL lines, or why it couldn't run; "all checks passed" when ok. */
    readonly detail: string;
}
export interface SandboxWatchDeps {
    /** The host's own check (RunHost.check). A check that throws didn't run, and so failed. */
    check: () => Promise<{
        ok: boolean;
        detail: string;
    }>;
    log: EventLog;
    actor: string;
    /** A line for the journal (default: stderr). */
    say?: (line: string) => void;
    /** After a check passed, each time it passes after failing or for the first time: the test runs go on from here. */
    passed?: () => void | Promise<void>;
    /** A one-shot timer (tests inject one); the default doesn't keep the process alive. */
    timer?: (fn: () => void, ms: number) => {
        cancel(): void;
    };
    now?: () => number;
}
export declare class SandboxWatch implements SandboxState {
    private d;
    private state;
    private failures;
    private failingSince;
    private inFlight;
    private next;
    private recorded;
    private stopped;
    constructor(d: SandboxWatchDeps);
    get ok(): boolean;
    get detail(): string;
    /** Checks failed in a row since the last pass. */
    get failed(): number;
    /**
     * Run the check once; while it fails, the next one is scheduled from here. INVARIANT: never two at once: a call
     * while one runs gets that one's result (the check makes a probe run in the sandbox, and wipes it).
     */
    check(): Promise<boolean>;
    private once;
    /** The coordinator is stopping: no further check is scheduled, and one in flight changes nothing more. */
    stop(): void;
}
