import type { Config } from '../config/load.js';
import type { EventLog } from '../events/log.js';
import type { AppCredentials } from '../github-app.js';
import { PrTestRuns } from '../coordinator/test-runs.js';
import { type RunHost } from './host.js';
import { type SandboxWatchDeps } from './sandbox-watch.js';
import { type TestRunRequest, type TestRunResult } from './index.js';
import type { TestRunConfig } from './config.js';
import type { TestRuns } from '../coordinator/pr-batch.js';
/**
 * The test-run service as PR-mode batching takes it (CoordinatorDeps testRuns, src/coordinator/pr-batch.ts). Each
 * batch's run is cancelled, and wiped, when `stopped` aborts (the coordinator stopping, after which a restart
 * abandons the batch) or when the caller's own signal does (a dropped batch, once the batcher passes one).
 */
export declare function batchTestRuns(config: TestRunConfig, stopped: AbortSignal): TestRuns & {
    startTestRun(req: TestRunRequest, opts?: {
        signal?: AbortSignal;
    }): Promise<TestRunResult>;
};
export interface TestRunSetup {
    instance: string;
    /** owner/name */
    repo: string;
    token: () => Promise<string>;
    app?: AppCredentials;
    api?: string;
    /** The host (tests inject one; production is always the sandbox). */
    host?: RunHost;
    /** The sandbox check's journal line and re-check timer (tests inject them; ./sandbox-watch.ts has the defaults). */
    say?: SandboxWatchDeps['say'];
    timer?: SandboxWatchDeps['timer'];
}
export declare function setupTestRuns(cfg: Config, s: TestRunSetup, d: {
    log: EventLog;
    actor: string;
    root: string;
    stateDir: string;
    remote?: string;
}): Promise<PrTestRuns | undefined>;
