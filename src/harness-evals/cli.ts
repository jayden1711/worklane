// `harness-eval run` and `harness-eval add-task`: the suite by hand (the coordinator runs it on its schedule; see
// src/coordinator/harness-evals.ts).
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAND } from '../brand.js';
import { loadConfig } from '../config/load.js';
import { EventLog } from '../events/log.js';
import { projectStateDir } from '../guardrails/context.js';
import { loadInstance } from '../instance.js';
import { CliRunner } from '../runner.js';
import { instanceId } from '../service.js';
import { HELD_OUT_FROM_STATE_FLAG, HELD_OUT_NOT_ASKED, heldOutAllowed, SPEND_FLAG, spendFromArgs, spendRefusal, SPEND_REFUSED } from '../spend-gate.js';
import { publicAllowed, saveTask, taskFromPr } from './add-task.js';
import { runSuite } from './replay.js';
import { engineSha } from './schedule.js';
import { heldOutTasksDir, loadSuite, PUBLIC_TASKS_DIR } from './tasks.js';

interface Helpers {
  instance: string | undefined;
  option: (args: string[], name: string) => string | undefined;
  flag: (args: string[], name: string) => boolean;
  usage: string;
  /** The suite runner (tests); runSuite otherwise. */
  suite?: typeof runSuite;
}

export async function harnessEvalCommand(root: string, sub: string | undefined, rest: string[], h: Helpers): Promise<number> {
  const site = h.instance ? (() => {
    const i = loadInstance(h.instance);
    return { stateDir: i.stateDir, cfg: i.config, eventsDb: join(i.stateDir, 'events.db') };
  })() : (() => {
    let cfg = null;
    try {
      cfg = loadConfig(root);
    } catch {
      // no config here: the defaults
    }
    return { stateDir: projectStateDir(root), cfg, eventsDb: join(projectStateDir(root), 'events.db') };
  })();

  if (sub === 'add-task') {
    const [repo, prArg] = rest.filter((a) => !a.startsWith('--'));
    const id = h.option(rest, '--id');
    const pub = h.flag(rest, '--public');
    if (!repo || !prArg || !/^\d+$/.test(prArg)) {
      console.error(h.usage);
      return 2;
    }
    const t = taskFromPr(repo, Number(prArg), id ? { id } : {});
    if (pub) {
      const ok = publicAllowed(repo);
      if (!ok.ok) {
        console.error(`not written: ${ok.why}`);
        return 1;
      }
      console.log(`written: ${saveTask(t, { publicDir: join(root, 'templates', 'evals', 'tasks') })}`);
    } else {
      console.log(`written to the held-out store: ${saveTask(t, { heldOutDir: heldOutTasksDir(site.stateDir) })}`);
    }
    return 0;
  }

  if (sub !== 'run') {
    console.error(h.usage);
    return 2;
  }
  // The spend gate (#612, src/spend-gate.ts): --spend is the caller's ceiling, never config's; held-out tasks only
  // from a store named on purpose. The coordinator's scheduled run doesn't come through here.
  let spend: number | null;
  try {
    spend = spendFromArgs(rest);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  h.option(rest, SPEND_FLAG);
  const heldOut = heldOutAllowed(rest);
  h.flag(rest, HELD_OUT_FROM_STATE_FLAG);
  const only: string[] = [];
  for (let id = h.option(rest, '--task'); id; id = h.option(rest, '--task')) only.push(id);
  const he = site.cfg?.project.harness_evals;
  const samples = Number(h.option(rest, '--samples') ?? he?.samples ?? 1);
  const budget = Number(h.option(rest, '--budget') ?? he?.budget_usd ?? 20);
  const work = resolve(h.option(rest, '--work') ?? join(site.stateDir, 'harness-evals'));
  const keep = h.flag(rest, '--keep');
  const record = h.flag(rest, '--record');
  if (!Number.isInteger(samples) || samples < 1 || !(budget > 0)) {
    console.error('--samples must be a whole number from 1, --budget a positive amount');
    return 2;
  }
  const extra = he?.tasks ? [resolve(root, he.tasks)] : [];
  const { tasks: all, notes } = loadSuite({ publicDirs: [PUBLIC_TASKS_DIR], projectDirs: extra, heldOutDir: heldOut ? heldOutTasksDir(site.stateDir) : null });
  for (const n of notes) console.error(n);
  if (!heldOut) console.error(HELD_OUT_NOT_ASKED);
  const tasks = only.length ? all.filter((t) => only.includes(t.id)) : all;
  const missing = only.filter((id) => !all.some((t) => t.id === id));
  if (missing.length) {
    console.error(`no such task: ${missing.join(', ')} (have: ${all.map((t) => t.id).join(', ')})`);
    return 2;
  }
  if (spend === null) {
    // Held-out task ids are never printed (src/harness-evals/tasks.ts): only how many.
    const shown = tasks.filter((t) => !t.heldOut).map((t) => t.id);
    const plan = [`would replay ${tasks.length} task(s) × ${samples} sample(s) with real agents: ${shown.join(', ') || 'none public'}${tasks.length > shown.length ? ` and ${tasks.length - shown.length} held-out or project task(s)` : ''}`, `  budget $${budget} (--budget, else harness_evals.budget_usd, else 20)`];
    console.error(spendRefusal(plan, budget));
    return SPEND_REFUSED;
  }
  mkdirSync(work, { recursive: true });
  const log = record ? new EventLog(site.eventsDb) : null;
  const actor = instanceId();
  try {
    const run = await (h.suite ?? runSuite)({
      tasks,
      samples,
      budgetUsd: Math.min(budget, spend),
      runner: new CliRunner(site.cfg?.project.agent_runtime.kind ?? 'cli'),
      trigger: 'manual',
      engine: engineSha(),
      pr: null,
      workDir: work,
      source: (t) => `https://github.com/${t.repo}.git`,
      // This checkout is the harness under test: its harness config replaces each task's own (old) one.
      ...(existsSync(join(root, BRAND.configDir)) ? { harnessConfig: root } : {}),
      keep,
      emit: (type, payload) => void log?.append(type, payload, actor),
      say: (l) => console.log(l),
    });
    console.log(`${BRAND.name} harness evals: ${run.passed}/${run.runs} replays passed; $${run.cost_usd.toFixed(2)} of $${run.budget_usd}; ${(run.wall_ms / 60_000).toFixed(1)} min; ${run.turns ?? 0} turns; ${run.interventions} human intervention(s)${run.stopped ? '; STOPPED at the budget' : ''}${run.error ? `; ${run.error}` : ''}`);
    return run.runs > 0 && run.passed === run.runs ? 0 : 1;
  } finally {
    log?.close();
  }
}
