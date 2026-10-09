// Nightly runs: the full suite on the tip of main (which re-records the
// baseline) plus any extra nightly tiers (e.g. mutation testing), queued
// behind the machine-wide full-run lock, the project's idle probe and the
// load gate, so they never overlap another full run.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import { projectStateDir } from './guardrails/context.js';
import { queueJob } from './queue.js';
import { createWorktree } from './worktrees.js';
const cliPath = () => fileURLToPath(new URL('./cli.js', import.meta.url));
/** Queue a full run on the tip of main that records main's baseline when it finishes. */
export function queueBaselineRun(root, cfg, eventsDb, actor, maxLoad) {
    const fmt = cfg.tests.failures;
    if (!fmt)
        throw new Error('tests.yaml needs a failures: { section, item } format to record a baseline');
    const branch = cfg.project.project.default_branch;
    execFileSync('git', ['fetch', '-q', 'origin', branch], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', `origin/${branch}`], { cwd: root, encoding: 'utf8' }).trim();
    const state = projectStateDir(root);
    const name = `baseline-${sha.slice(0, 8)}`;
    const wt = { repo: root, root: cfg.tests.worktree.root, stateDir: state, setup: cfg.tests.worktree.setup };
    const { path, setupErrors } = createWorktree(wt, name, `${BRAND.cli}/${name}`, sha);
    if (setupErrors.length)
        throw new Error(`worktree setup failed: ${setupErrors.join('; ')}`);
    return queueJob({
        stateDir: state,
        cwd: path,
        command: cfg.tests.runner.full,
        idleProbe: cfg.tests.idle_probe,
        maxLoad,
        cliPath: cliPath(),
        after: { baseline: { eventsDb, sha, section: fmt.section, item: fmt.item, actor }, cleanup: { repo: root, root: cfg.tests.worktree.root, stateDir: state, name } },
    });
}
/** True once per day, after the configured time (local), if nightly isn't queued yet. */
export function nightlyDue(at, lastQueuedDay, now = new Date()) {
    if (!at)
        return false;
    const [h, m] = at.split(':').map(Number);
    const day = now.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
    const past = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
    return past && lastQueuedDay !== day;
}
export function queueNightly(root, cfg, eventsDb, actor) {
    const jobs = [];
    if (cfg.tests.failures)
        jobs.push(queueBaselineRun(root, cfg, eventsDb, actor, cfg.project.governor.max_load));
    for (const tier of cfg.tests.gates.nightly.filter((t) => t !== 'full')) {
        const t = cfg.tests.tiers.find((x) => x.name === tier);
        if (!t)
            continue;
        jobs.push(queueJob({ stateDir: projectStateDir(root), cwd: root, command: t.command, idleProbe: cfg.tests.idle_probe, maxLoad: cfg.project.governor.max_load, cliPath: cliPath() }));
    }
    return jobs;
}
//# sourceMappingURL=nightly.js.map