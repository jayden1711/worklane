// Nightly runs: the full suite on the tip of main (which re-records the
// baseline) plus any extra nightly tiers (e.g. mutation testing), queued
// behind the machine-wide full-run lock, the project's idle probe and the
// load gate, so they never overlap another full run.
import { gitExecFileSync } from './os/git.js';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';
import { projectStateDir } from './guardrails/context.js';
import { queueJob, type Job } from './queue.js';
import { createWorktree, worktreeOptions, type WorktreeOptions } from './worktrees.js';

const cliPath = () => fileURLToPath(new URL('./cli.js', import.meta.url));

/**
 * The baseline run's worktree at `sha`. With `wt` (the coordinator's own options, #890 round 20) its root, already
 * resolved at the coordinator's start, and its task directory are used, so a link planted on the way since then refuses
 * the add; without, options are built here through worktreeOptions. The ownership record stays the project's.
 */
export function baselineWorktree(root: string, cfg: Config, sha: string, runAs?: Job['runAs'], wt?: WorktreeOptions): { o: WorktreeOptions; name: string; path: string } {
  const own = { stateDir: projectStateDir(root), setup: cfg.tests.worktree.setup, ...(runAs ? { runAs } : {}) };
  const o: WorktreeOptions = wt ? { repo: root, root: wt.root, rootResolved: wt.rootResolved, taskDir: wt.taskDir, ...own } : worktreeOptions({ repo: root, root: cfg.tests.worktree.root, taskDir: null, ...own });
  const name = `baseline-${sha.slice(0, 8)}`;
  const { path, setupErrors } = createWorktree(o, name, `${BRAND.cli}/${name}`, sha);
  if (setupErrors.length) throw new Error(`worktree setup failed: ${setupErrors.join('; ')}`);
  return { o, name, path };
}

/** Queue a full run on the tip of main that records main's baseline when it finishes. */
export function queueBaselineRun(root: string, cfg: Config, eventsDb: string, actor: string, maxLoad?: number, runAs?: Job['runAs'], wt?: WorktreeOptions): Job {
  const fmt = cfg.tests.failures;
  if (!fmt) throw new Error('tests.yaml needs a failures: { section, item } format to record a baseline');
  const branch = cfg.project.project.default_branch;
  gitExecFileSync(['fetch', '-q', 'origin', branch], { cwd: root });
  const sha = gitExecFileSync(['rev-parse', `origin/${branch}`], { cwd: root, encoding: 'utf8' }).trim();
  const state = projectStateDir(root);
  const { o, name, path } = baselineWorktree(root, cfg, sha, runAs, wt);
  return queueJob({
    stateDir: state,
    cwd: path,
    command: cfg.tests.runner.full,
    idleProbe: cfg.tests.idle_probe,
    maxLoad,
    cliPath: cliPath(),
    after: { baseline: { eventsDb, sha, section: fmt.section, item: fmt.item, actor }, cleanup: { repo: root, root: o.root, stateDir: o.stateDir, taskDir: o.taskDir, name } },
    ...(runAs ? { runAs } : {}),
  });
}

/** True once per day, after the configured time (local), if nightly isn't queued yet. */
export function nightlyDue(at: string | undefined, lastQueuedDay: string | null, now = new Date()): boolean {
  if (!at) return false;
  const [h, m] = at.split(':').map(Number) as [number, number];
  const day = now.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
  const past = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  return past && lastQueuedDay !== day;
}

export function queueNightly(root: string, cfg: Config, eventsDb: string, actor: string, runAs?: Job['runAs'], wt?: WorktreeOptions): Job[] {
  const jobs: Job[] = [];
  if (cfg.tests.failures) jobs.push(queueBaselineRun(root, cfg, eventsDb, actor, cfg.project.governor.max_load, runAs, wt));
  for (const tier of cfg.tests.gates.nightly.filter((t) => t !== 'full')) {
    const t = cfg.tests.tiers.find((x) => x.name === tier);
    if (!t) continue;
    jobs.push(queueJob({ stateDir: projectStateDir(root), cwd: root, command: t.command, idleProbe: cfg.tests.idle_probe, maxLoad: cfg.project.governor.max_load, cliPath: cliPath(), ...(runAs ? { runAs } : {}) }));
  }
  return jobs;
}
