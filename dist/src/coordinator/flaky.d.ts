import type { Backlog } from '../backlog/types.js';
import type { EventLog } from '../events/log.js';
import type { RequiredCheck } from '../pr-watch.js';
import { type TestRuns } from './pr-batch.js';
export interface FlakyConfig {
    rerun: boolean;
    release_after_passes: number;
    rerun_timeout_min: number;
}
export interface FlakyGateDeps {
    log: EventLog;
    actor: string;
    backlog: Backlog;
    config: () => FlakyConfig;
    /** owner/name: the issues' links. */
    repo: string;
    branch: string;
    /** The coordinator's clone (a test-run re-run runs from it). */
    clone: string;
    testRuns: TestRuns | null;
    /** tests.yaml test_run's tiers and their kinds (empty without test runs). */
    tiers: () => {
        name: string;
        kind: 'fast' | 'full';
    }[];
    /** Fetch the default branch into the clone, so a re-run's commit is there. */
    fetch: () => void;
    now?: () => number;
}
export type GateResult = {
    wait: true;
} | {
    wait: false;
    outcomes: RequiredCheck[];
    flaky: string[];
    quarantined: string[];
};
export declare class FlakyGate {
    private readonly d;
    /** A test-run re-run's checks by commit: each check's outcome once it finished (lost on a restart: the posted check is read then). */
    private testRunReruns;
    /** Time each re-run spent held at the start gate: not counted against rerun_timeout_min. */
    private heldTime;
    constructor(d: FlakyGateDeps);
    private get now();
    private emit;
    private error;
    /** The required checks of the default branch's commit `sha`, as the harness's red/green decision counts them; or wait. */
    judge(o: {
        sha: string;
        number: number | null;
        outcomes: RequiredCheck[];
    }): Promise<GateResult>;
    /** How each failing check can be re-run: a test-run check by its tiers, an Actions job by its run, else not. */
    private routes;
    private request;
    /** Run the tiers behind `checks` again on `sha` in the background, and post their checks again. */
    private startTestRunRerun;
    /** The re-run's verdict, once every check is in (or the wait timed out); null while it runs. */
    private resolve;
    /** Quarantine a test seen flaky on `sha`: a new one gets its issue; one quarantined already, a sighting. */
    private quarantine;
    private issueUrl;
    private createIssue;
    /** A quarantined test whose issue couldn't be filed: filed now, recorded as a quarantine with it. */
    private fileIssue;
    /** Each quarantined test's result on `sha` (once per commit): passes in a row, and its release at release_after_passes. */
    private observe;
}
