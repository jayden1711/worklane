import { type TestRunConfig } from './config.js';
import { type ChecksDeps } from './checks.js';
import { type TestRunDeps, type TestRunRequest, type TestRunResult } from './run.js';
export type { TestRunRequest, TestRunResult, TierResult } from './run.js';
export { mergeShards, tiersFor } from './run.js';
export { ChecksPermissionMissing } from './checks.js';
export interface TestRunService {
    run: TestRunDeps;
    checks: ChecksDeps;
}
/** Register (or, with null, remove) the instance's test-run service. */
export declare function useTestRuns(s: TestRunService | null): void;
export declare function testRunsAvailable(): boolean;
/**
 * Run a project's tests on `req.sha` (which must be in the coordinator's clone). Resolves with the result, pass or
 * fail; rejects only for a bad request or when no service is registered. `signal`: cancel (a superseded run).
 */
export declare function startTestRun(req: TestRunRequest, opts?: {
    signal?: AbortSignal;
}): Promise<TestRunResult>;
/** Post a result's checks on `sha` (a PR's head, or a batch's). */
export declare function postChecks(sha: string, result: TestRunResult, checkNames: Record<string, string>): Promise<void>;
/** Every tier's check name, as tests.yaml test_run maps them. */
export declare function checkNamesFor(c: TestRunConfig): Record<string, string>;
