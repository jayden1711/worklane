// Setting an instance's test runs up at coordinator start: only with tests.yaml test_run. No run starts until the
// sandbox's own check passed (a check that can't run is a failure): while it fails the runs are set up but each is
// refused, each PR's check says test runs are off and why, and the check is run again until it passes
// (./sandbox-watch.ts); then the runs go on, with no restart. Records the sandbox's state and the App's Checks
// permission, which health and the dashboard read. First it asks the helper its protocol version (./helper.ts), once:
// with an outdated helper the runs are set up but none starts; each PR's check says so and how to fix it.
import { join } from 'node:path';
import { listOpenPrs, PrTestRuns } from '../coordinator/test-runs.js';
import { checksPermission } from './checks.js';
import { checkHelper } from './helper.js';
import { sandboxHost } from './host.js';
import { SandboxWatch } from './sandbox-watch.js';
import { checkNamesFor, postChecks, startTestRun, useTestRuns } from './index.js';
/**
 * The test-run service as PR-mode batching takes it (CoordinatorDeps testRuns, src/coordinator/pr-batch.ts). Each
 * batch's run is cancelled, and wiped, when `stopped` aborts (the coordinator stopping, after which a restart
 * abandons the batch) or when the caller's own signal does (a dropped batch, once the batcher passes one).
 */
export function batchTestRuns(config, stopped) {
    return {
        startTestRun: (req, opts = {}) => startTestRun(req, { signal: opts.signal ? AbortSignal.any([stopped, opts.signal]) : stopped }),
        // The batcher's combined result may omit outcome (its contract makes it optional); a posted result is a verdict.
        postChecks: (sha, result, checkNames) => postChecks(sha, { ...result, outcome: result.outcome ?? 'done' }, checkNames),
        checkNames: () => checkNamesFor(config),
    };
}
export async function setupTestRuns(cfg, s, d) {
    const config = cfg.tests.test_run;
    if (!config)
        return undefined;
    const host = s.host ?? sandboxHost(s.instance);
    if (s.app)
        d.log.append('testrun.checks_permission', await checksPermission(s.app, s.api ? { api: s.api } : {}), d.actor);
    // Asked once here and cached for every run of this coordinator: an update that replaces the helper restarts it.
    const helper = await checkHelper(host, s.instance);
    d.log.append('testrun.helper', { ok: helper.ok, have: helper.have, need: helper.need, detail: helper.detail.slice(0, 1000) }, d.actor);
    // WHY: a host that isn't the sandbox can never pass its check, so there is nothing to wait for: no test runs.
    if (helper.ok && host.kind !== 'sandbox') {
        d.log.append('testrun.sandbox', { ok: false, detail: 'not the sandbox' }, d.actor);
        return undefined;
    }
    let runs = null;
    // An outdated helper's own check proves nothing about this engine's sandbox: skipped, and every run refused.
    const sandbox = helper.ok
        ? new SandboxWatch({ check: () => host.check(), log: d.log, actor: d.actor, passed: () => runs?.sandboxPassed(), ...(s.say ? { say: s.say } : {}), ...(s.timer ? { timer: s.timer } : {}) })
        : undefined;
    useTestRuns({
        run: { config, host, repo: d.root, log: d.log, actor: d.actor, logDir: join(d.stateDir, 'test-runs'), helper, ...(sandbox ? { sandbox } : {}), sparseExclude: cfg.tests.checkout.sparse_exclude },
        checks: { repo: s.repo, token: s.token, log: d.log, actor: d.actor, ...(s.api ? { api: s.api } : {}) },
    });
    const names = checkNamesFor(config);
    runs = new PrTestRuns({
        log: d.log,
        actor: d.actor,
        repo: d.root,
        remote: d.remote ?? 'origin',
        host,
        listPrs: () => listOpenPrs(s.repo, s.token, fetch, s.api),
        start: (req, o) => startTestRun(req, o),
        post: (sha, result) => postChecks(sha, result, names),
        ...(sandbox ? { sandbox } : {}),
    });
    // INVARIANT: the first check is awaited here, so a coordinator whose sandbox passes starts exactly as before; one
    // whose check fails starts too, with every run refused until a later check passes.
    if (sandbox)
        await sandbox.check();
    else
        await runs.recover();
    return runs;
}
//# sourceMappingURL=setup.js.map