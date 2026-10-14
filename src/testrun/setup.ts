// Setting an instance's test runs up at coordinator start: only with tests.yaml test_run, and only once the sandbox's
// own check passed (a check that can't run is a failure). Records the sandbox's state and the App's Checks
// permission, which health and the dashboard read. First it asks the helper its protocol version (./helper.ts), once:
// with an outdated helper the runs are set up but none starts; each PR's check says so and how to fix it.
import { join } from 'node:path';
import type { Config } from '../config/load.js';
import type { EventLog } from '../events/log.js';
import type { AppCredentials } from '../github-app.js';
import { listOpenPrs, PrTestRuns } from '../coordinator/test-runs.js';
import { checksPermission } from './checks.js';
import { checkHelper } from './helper.js';
import { sandboxHost, type RunHost } from './host.js';
import { checkNamesFor, postChecks, startTestRun, useTestRuns, type TestRunRequest, type TestRunResult } from './index.js';
import type { TestRunConfig } from './config.js';
import type { TestRuns } from '../coordinator/pr-batch.js';

/**
 * The test-run service as PR-mode batching takes it (CoordinatorDeps testRuns, src/coordinator/pr-batch.ts). Each
 * batch's run is cancelled, and wiped, when `stopped` aborts (the coordinator stopping, after which a restart
 * abandons the batch) or when the caller's own signal does (a dropped batch, once the batcher passes one).
 */
export function batchTestRuns(config: TestRunConfig, stopped: AbortSignal): TestRuns & { startTestRun(req: TestRunRequest, opts?: { signal?: AbortSignal }): Promise<TestRunResult> } {
  return {
    startTestRun: (req: TestRunRequest, opts: { signal?: AbortSignal } = {}) => startTestRun(req, { signal: opts.signal ? AbortSignal.any([stopped, opts.signal]) : stopped }),
    // The batcher's combined result may omit outcome (its contract makes it optional); a posted result is a verdict.
    postChecks: (sha, result, checkNames) => postChecks(sha, { ...result, outcome: result.outcome ?? 'done' }, checkNames),
    checkNames: () => checkNamesFor(config),
  };
}

export interface TestRunSetup {
  instance: string;
  /** owner/name */
  repo: string;
  token: () => Promise<string>;
  app?: AppCredentials;
  api?: string;
  /** The host (tests inject one; production is always the sandbox). */
  host?: RunHost;
}

export async function setupTestRuns(cfg: Config, s: TestRunSetup, d: { log: EventLog; actor: string; root: string; stateDir: string; remote?: string }): Promise<PrTestRuns | undefined> {
  const config = cfg.tests.test_run;
  if (!config) return undefined;
  const host = s.host ?? sandboxHost(s.instance);
  if (s.app) d.log.append('testrun.checks_permission', await checksPermission(s.app, s.api ? { api: s.api } : {}), d.actor);
  // Asked once here and cached for every run of this coordinator: an update that replaces the helper restarts it.
  const helper = await checkHelper(host, s.instance);
  d.log.append('testrun.helper', { ok: helper.ok, have: helper.have, need: helper.need, detail: helper.detail.slice(0, 1000) }, d.actor);
  // An outdated helper's own check proves nothing about this engine's sandbox: skipped, and every run refused.
  if (helper.ok) {
    const checked = host.kind === 'sandbox' ? await host.check().catch((e: Error) => ({ ok: false, detail: `the check didn't run: ${e.message}` })) : { ok: false, detail: 'not the sandbox' };
    d.log.append('testrun.sandbox', { ok: checked.ok, detail: checked.detail.slice(0, 2000) }, d.actor);
    if (!checked.ok) return undefined;
  }
  useTestRuns({
    run: { config, host, repo: d.root, log: d.log, actor: d.actor, logDir: join(d.stateDir, 'test-runs'), helper, sparseExclude: cfg.tests.checkout.sparse_exclude },
    checks: { repo: s.repo, token: s.token, log: d.log, actor: d.actor, ...(s.api ? { api: s.api } : {}) },
  });
  const names = checkNamesFor(config);
  const runs = new PrTestRuns({
    log: d.log,
    actor: d.actor,
    repo: d.root,
    remote: d.remote ?? 'origin',
    host,
    listPrs: () => listOpenPrs(s.repo, s.token, fetch, s.api),
    start: (req, o) => startTestRun(req, o),
    post: (sha, result) => postChecks(sha, result, names),
  });
  await runs.recover();
  return runs;
}
