import type { EventLog } from '../events/log.js';
import type { StoredEvent } from '../events/types.js';
import type { RunHost } from '../testrun/host.js';
import { type TestRunRequest, type TestRunResult } from '../testrun/index.js';
/** A PR as the test runs need it. */
export interface OpenPr {
    number: number;
    headSha: string;
    base: string;
    author: string;
    bot: boolean;
}
type Fetch = typeof fetch;
/** Open PRs, one listing (at most 100: the newest first). */
export declare function listOpenPrs(repo: string, token: () => Promise<string>, f?: Fetch, api?: string): Promise<OpenPr[]>;
/** Whether a PR may have its full tiers run (a batch): a bot's only once the owner approved it. */
export declare function fullRunAllowed(pr: Pick<OpenPr, 'bot'>, ownerApproved: boolean): boolean;
export interface PrTestRunDeps {
    log: EventLog;
    actor: string;
    /** The coordinator's clone and its remote. */
    repo: string;
    remote: string;
    host: RunHost;
    listPrs: () => Promise<OpenPr[]>;
    start: (req: TestRunRequest, o: {
        signal: AbortSignal;
    }) => Promise<TestRunResult>;
    post: (sha: string, result: TestRunResult) => Promise<void>;
    /** How often open PRs are listed (one API call; default 90 s, within the shared rate limit). */
    pollMs?: number;
    /** At most this many runs queued or running at once from here (default 12). */
    maxInFlight?: number;
    now?: () => number;
    /** Fetch a PR's head into the clone; returns the fetched commit (tests inject this). */
    fetchPr?: (pr: OpenPr) => string;
    /** The files a PR changes against its base (tests inject this). */
    changed?: (pr: OpenPr) => string[];
    /** The sandbox's check, held and run again while it fails (src/testrun/sandbox-watch.ts); absent: nothing to wait for. */
    sandbox?: {
        readonly ok: boolean;
        stop(): void;
    };
    /** The fast tiers' names (tests.yaml test_run): what a cut-off GPU run's failing check is posted for. Absent: none posted. */
    fastTiers?: () => string[];
}
/** Runs started but never finished: a coordinator stopped during them. Their ids. */
export declare function unfinishedRuns(events: readonly StoredEvent[]): string[];
/** What a check posted while the event log can't be written says (the run's own events wait in memory). */
export declare const EVENTS_KEPT_NOTE = "The instance's disk is full: this run's record waits in memory and is written to its log when there is room. The result above is the run's.";
export declare class PrTestRuns {
    private d;
    private inFlight;
    /** pr -> heads whose fast run finished (from the log, so a restart doesn't run them again). */
    private finished;
    /**
     * pr -> the head whose run was refused because the sandbox's check is failing: its "test runs are off" check is
     * posted once, and the head runs for real once the check passes (sandboxPassed).
     */
    private refused;
    private lastPoll;
    /** The latest listing of open PRs (the coordinator batches people's PRs from it: no listing of its own). */
    private openPrs;
    /** Aborted when the coordinator stops: every run from here, and the batches' (batchTestRuns), is cancelled and wiped. */
    readonly stopped: AbortController;
    constructor(d: PrTestRunDeps);
    /** At start: wipe what a stopped coordinator's runs left, and record them as interrupted. */
    recover(): Promise<string[]>;
    /** The failing check on a cut-off GPU fast run's head: every fast tier, not run again (src/testrun/gpu.ts). */
    private postCutOff;
    private fetchPr;
    private changed;
    /** One pass: list open PRs (at most every pollMs), cancel superseded runs, start runs for new heads. */
    tick(): Promise<{
        started: number[];
        cancelled: number[];
    }>;
    private runOne;
    /** False while the sandbox's check is failing: every run is refused, and nothing else may go through the service. */
    ready(): boolean;
    /**
     * The sandbox's check passed (at start, or after failing): what a stopped coordinator's runs left is wiped, and the
     * next tick lists the PRs at once and runs every head that only got a "test runs are off" check.
     */
    sandboxPassed(): Promise<void>;
    /** The open PRs as last listed (empty before the first listing). */
    listing(): OpenPr[];
    /** Wait for the runs in flight (tests and shutdown). */
    idle(): Promise<void>;
    stop(): void;
}
export {};
