import { type AppCredentials } from '../github-app.js';
import type { EventLog } from '../events/log.js';
import { type TestRunResult } from './run.js';
type Fetch = typeof fetch;
export interface ChecksDeps {
    repo: string;
    token: () => Promise<string>;
    log: EventLog;
    actor: string;
    fetch?: Fetch;
    api?: string;
    /** Where a check's details link points (the instance's dashboard), if anywhere. */
    detailsUrl?: string;
}
export declare class ChecksPermissionMissing extends Error {
    constructor(detail: string);
}
/**
 * The checks a result posts: each check name, its tiers, and its conclusion. A tier whose PR predates the test-run
 * config is a failure too, not action_required: GitHub shows a failure's title in the PR's checks list, where the
 * predates title says what to do, while action_required wants a details page to act on (this check may have none),
 * and the engine's own gate reads action_required as a hold, waiting on something, where this is a fail to fix.
 */
export declare function checksFor(result: TestRunResult, checkNames: Record<string, string>): {
    name: string;
    conclusion: 'success' | 'failure';
    tiers: TestRunResult['tiers'];
}[];
export declare const PREDATES_TITLE = "This PR predates the test-run config: update it with main";
/** The title of the check on a head whose run was refused because the sandbox's check is failing (./sandbox-watch.ts). */
export declare const SANDBOX_TITLE = "Not run: test runs are off (the test sandbox check is failing)";
/** The title of the failing check on the head of a GPU run cut off by a stop (src/coordinator/test-runs.ts recover). */
export declare const GPU_CUT_OFF_TITLE = "Cut off (GPU run): not rerun automatically";
/**
 * A check's title and summary. Each tier's pass or fail and how long it took, and its last lines of output (as the
 * run captured them, stdout and stderr together), redacted: a check is readable by everyone who can read the repo,
 * and the full log stays in the instance's state. A tier the PR's head is too old to run as configured gets the
 * predates title, what the head lacks, the config's commit, and the fix. A run that failed in setup says which step,
 * why, and the last lines of that step's stderr, redacted (never its stdout: db-start prints the database's
 * password there).
 */
export declare function checkOutput(result: TestRunResult, tiers: TestRunResult['tiers'], conclusion: 'success' | 'failure', detailsUrl?: string): {
    title: string;
    summary: string;
};
/**
 * Post one completed check run per check name on `sha` (its output: checkOutput). Throws ChecksPermissionMissing
 * when the App lacks Checks: write, after recording it.
 */
export declare function postChecks(d: ChecksDeps, sha: string, result: TestRunResult, checkNames: Record<string, string>): Promise<void>;
/**
 * The App's Checks permission on its installation, as GitHub reports it (App JWT, GET /app/installations/<id>).
 * Recorded so health and the dashboard can say plainly when posting checks can't work yet.
 */
export declare function checksPermission(c: AppCredentials, o?: {
    fetch?: Fetch;
    api?: string;
}): Promise<{
    level: 'write' | 'read' | 'none' | 'unknown';
    detail: string;
}>;
export {};
