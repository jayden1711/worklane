// The test-run service's interface for the rest of the engine (and Track PB's PR-mode batching):
//
//   startTestRun(req, opts?): Promise<TestRunResult>   queues, waits for a slot and the lock, runs, wipes, records
//   postChecks(sha, result, checkNames): Promise<void>  GitHub check runs via the App, one per check name
//
// The coordinator registers its instance's service at start (useTestRuns); until then both reject. A sharded full
// run is one startTestRun per shard, `shard.index` 1-based; mergeShards folds their results into one.
import { checkName } from './config.js';
import { postChecks as post } from './checks.js';
import { runTestRun } from './run.js';
export { mergeShards, tiersFor } from './run.js';
export { ChecksPermissionMissing } from './checks.js';
let service = null;
/** Register (or, with null, remove) the instance's test-run service. */
export function useTestRuns(s) {
    service = s;
}
export function testRunsAvailable() {
    return service !== null;
}
/**
 * Run a project's tests on `req.sha` (which must be in the coordinator's clone). Resolves with the result, pass or
 * fail; rejects only for a bad request or when no service is registered. `signal`: cancel (a superseded run).
 */
export function startTestRun(req, opts = {}) {
    if (!service)
        return Promise.reject(new Error('test runs are not set up on this instance (tests.yaml test_run, and the sandbox: scripts/setup/test-user.sh)'));
    return runTestRun(service.run, req, opts);
}
/** Post a result's checks on `sha` (a PR's head, or a batch's). */
export function postChecks(sha, result, checkNames) {
    if (!service)
        return Promise.reject(new Error('test runs are not set up on this instance'));
    return post(service.checks, sha, result, checkNames);
}
/** Every tier's check name, as tests.yaml test_run maps them. */
export function checkNamesFor(c) {
    return Object.fromEntries(c.tiers.map((t) => [t.name, checkName(c, t.name)]));
}
//# sourceMappingURL=index.js.map