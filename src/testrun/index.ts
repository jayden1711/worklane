// The test-run service's interface for the rest of the engine (and Track PB's PR-mode batching):
//
//   startTestRun(req, opts?): Promise<TestRunResult>   queues, waits for a slot and the lock, runs, wipes, records
//   postChecks(sha, result, checkNames): Promise<void>  GitHub check runs via the App, one per check name
//
// The coordinator registers its instance's service at start (useTestRuns); until then both reject. A sharded full
// run is one startTestRun per shard, `shard.index` 1-based; mergeShards folds their results into one.
import { checkName, type TestRunConfig } from './config.js';
import { postChecks as post, type ChecksDeps } from './checks.js';
import { runTestRun, type TestRunDeps, type TestRunRequest, type TestRunResult } from './run.js';

export type { TestRunRequest, TestRunResult, TierResult } from './run.js';
export { mergeShards, tiersFor } from './run.js';
export { ChecksPermissionMissing } from './checks.js';

export interface TestRunService {
  run: TestRunDeps;
  checks: ChecksDeps;
}

let service: TestRunService | null = null;

/** Register (or, with null, remove) the instance's test-run service. */
export function useTestRuns(s: TestRunService | null): void {
  service = s;
}

export function testRunsAvailable(): boolean {
  return service !== null;
}

/**
 * Run a project's tests on `req.sha` (which must be in the coordinator's clone). Resolves with the result, pass or
 * fail; rejects only for a bad request or when no service is registered. `signal`: cancel (a superseded run).
 */
export function startTestRun(req: TestRunRequest, opts: { signal?: AbortSignal } = {}): Promise<TestRunResult> {
  if (!service) return Promise.reject(new Error('test runs are not set up on this instance (tests.yaml test_run, and the sandbox: scripts/setup/test-user.sh)'));
  return runTestRun(service.run, req, opts);
}

/** Post a result's checks on `sha` (a PR's head, or a batch's). */
export function postChecks(sha: string, result: TestRunResult, checkNames: Record<string, string>): Promise<void> {
  if (!service) return Promise.reject(new Error('test runs are not set up on this instance'));
  return post(service.checks, sha, result, checkNames);
}

/** Every tier's check name, as tests.yaml test_run maps them. */
export function checkNamesFor(c: TestRunConfig): Record<string, string> {
  return Object.fromEntries(c.tiers.map((t) => [t.name, checkName(c, t.name)]));
}
