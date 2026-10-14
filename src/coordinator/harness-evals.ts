// The harness eval suite's schedule (config.yaml harness_evals; src/harness-evals/): on this machine, in the nightly
// window, weekly and when the engine running here changed src/. One run at a time, in the background like the
// gardener, within its budget and what the daily budget leaves. Every replay and the run are events; a run a merged
// PR triggered is posted on that PR, against the last baseline. Nothing runs in CI, and no secret leaves the machine.
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BRAND } from '../brand.js';
import type { EventPayload } from '../events/types.js';
import { subjectPrNumber } from '../main-watch.js';
import { agentWritableDir } from '../os/index.js';
import { baselineFor, commentMarkdown, evalRuns } from '../harness-evals/score.js';
import { engineSha, ENGINE_ROOT, harnessEvalDue, srcChanged } from '../harness-evals/schedule.js';
import { engineRepo, heldOutTasksDir, loadSuite, PUBLIC_TASKS_DIR, type LoadedTask } from '../harness-evals/tasks.js';
import { SuperfanWatch } from './superfan.js';

/** Under this much budget left, a run can't replay anything: it is recorded as not run. */
export const MIN_EVAL_USD = 0.5;

export abstract class HarnessEvals extends SuperfanWatch {
  /** The harness eval run in flight. */
  protected harnessEvalRun: Promise<void> = Promise.resolve();
  private harnessEvalBusy = false;

  /** Start a harness eval run when one is due (one at a time). Off unless harness_evals.enabled. */
  async checkHarnessEvals(): Promise<void> {
    const h = this.d.cfg.project.harness_evals;
    if (!h?.enabled || this.d.harnessEvals?.replay || this.harnessEvalBusy || this.halt.signal.aborted || this.stopped || this.usagePause()) return;
    const runs = this.d.log.read(0, ['harness_eval.run']);
    const now = this.d.now?.() ?? new Date();
    const engine = (this.d.harnessEvals?.engine ?? engineSha)();
    const lastWeekly = runs.filter((e) => (e.payload as EventPayload<'harness_eval.run'>).trigger === 'weekly').at(-1)?.ts ?? null;
    const last = runs.at(-1);
    const trigger = harnessEvalDue({
      now,
      at: this.d.cfg.tests.nightly_at,
      weekly: h.weekly,
      onChange: h.on_change,
      lastRunDay: last ? new Date(last.ts).toLocaleDateString('en-CA') : null,
      lastWeekly,
      lastEngine: (last?.payload as EventPayload<'harness_eval.run'> | undefined)?.engine ?? null,
      engine,
      changed: this.d.harnessEvals?.changed ?? ((a, b) => srcChanged(a, b, [ENGINE_ROOT, this.d.repo])),
    });
    if (!trigger) return;
    const pr = trigger === 'change' && engine ? this.mergedPrOf(engine) : null;
    const budget = Math.min(h.budget_usd, this.d.cfg.agents.daily_budget_usd - this.spentToday());
    if (budget < MIN_EVAL_USD) {
      this.emit('harness_eval.run', { id: `he-skipped-${now.toISOString().slice(0, 10)}`, trigger, engine, pr, tasks: 0, samples: h.samples, runs: 0, passed: 0, cost_usd: 0, wall_ms: 0, interventions: 0, budget_usd: Math.max(0.01, h.budget_usd), stopped: null, error: `not run: the daily budget ($${this.d.cfg.agents.daily_budget_usd}) leaves $${Math.max(0, budget).toFixed(2)}` });
      return;
    }
    this.harnessEvalBusy = true;
    this.harnessEvalRun = this.evalHarness(trigger, engine, pr, budget)
      .catch((e: Error) => void this.emit('coordinator.error', { instance: this.d.instance, where: 'harness evals', kind: 'error', message: e.message.slice(0, 500) }))
      .finally(() => {
        this.harnessEvalBusy = false;
      });
  }

  /**
   * The PR whose merge is this engine commit, when this instance's repository is the engine's own and its merge
   * subject names one ("Merge #N: ...", "Merge pull request #N ..."). Otherwise null: nothing is posted.
   */
  private mergedPrOf(engine: string): number | null {
    if (engineRepo() !== this.d.cfg.project.project.repo) return null;
    try {
      return subjectPrNumber(this.git(this.d.repo, 'log', '-1', '--format=%s', engine));
    } catch {
      return null;
    }
  }

  private async evalHarness(trigger: 'weekly' | 'change', engine: string | null, pr: number | null, budget: number): Promise<void> {
    const h = this.d.cfg.project.harness_evals;
    const { tasks, notes } = loadSuite({ publicDirs: [PUBLIC_TASKS_DIR], projectDirs: h.tasks ? [resolve(this.d.repo, h.tasks)] : [], heldOutDir: heldOutTasksDir(this.d.stateDir) });
    for (const n of notes) this.emit('coordinator.error', { instance: this.d.instance, where: 'harness evals', kind: 'tasks', message: n });
    // Agents as their own user: the scratch clones go beside the checkout, in the group the agents share.
    const shared = this.d.commandsAs ? { dir: join(dirname(this.d.repo), 'harness-evals'), gid: statSync(this.d.repo).gid } : null;
    const workDir = shared?.dir ?? join(this.d.stateDir, 'harness-evals');
    if (shared) agentWritableDir(shared.dir, shared.gid);
    const suite = this.d.harnessEvals?.suite ?? (await import('../harness-evals/replay.js')).runSuite;
    const run = await suite({
      tasks,
      samples: h.samples,
      budgetUsd: budget,
      runner: this.d.runner,
      trigger,
      engine,
      pr,
      workDir,
      source: (t: LoadedTask) => `https://github.com/${t.repo}.git`,
      signal: this.halt.signal,
      deps: { ...(this.d.commandsAs ? { commandsAs: this.d.commandsAs } : {}), ...(this.d.agentTasks ? { agentTasks: this.d.agentTasks } : {}), ...(this.d.depCacheRoot ? { depCacheRoot: this.d.depCacheRoot } : {}), ...(this.d.commitIdentity ? { commitIdentity: this.d.commitIdentity } : {}) },
      emit: (type, payload) => void this.emit(type, payload),
    });
    if (pr !== null) await this.postEvalResults(run.id, pr);
  }

  /** Post a run's scores on the PR that triggered it, beside the last baseline's. */
  private async postEvalResults(id: string, pr: number): Promise<void> {
    const runs = evalRuns(this.d.log.read(0, ['harness_eval.run', 'harness_eval.task']));
    const cur = runs.find((r) => r.run.id === id);
    if (!cur) return;
    const base = baselineFor(runs, id);
    await this.d.backlog.comment(pr, `[${BRAND.cli}] ${commentMarkdown(cur, base, BRAND.name)}`);
    this.emit('harness_eval.commented', { run: id, pr, baseline: base?.run.id ?? null });
  }
}
