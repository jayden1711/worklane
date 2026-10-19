// The run's aggregate (#748): counts and rates only, never a task's instance id or text. Written after every task, so
// a run that stops (a usage limit, the ceiling) leaves a partial aggregate that says so. After grading, the confusion
// matrix (the engine's decision against the hidden tests) and the rates, each with a Wilson 95% interval.
import type { Caps } from './caps.js';
import { REAPPROVE_MEAN_USD } from './caps.js';
import type { Limits } from './container.js';
import type { TaskResult } from './driver.js';

/** A proportion with its Wilson score interval (z = 1.96: 95%); null when there is nothing to divide by. */
export function wilson(k: number, n: number, z = 1.96): { k: number; n: number; rate: number; lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { k, n, rate: r(p), lo: r(Math.max(0, mid - half)), hi: r(Math.min(1, mid + half)) };
}

/** Per task key, per patch label: whether the hidden tests resolved it. */
export type Grades = Record<string, Record<string, boolean>>;

export interface RunMeta {
  run: string;
  claude_version: string;
  /** The login's plan as claude named it (enterprise, team, max, ...). */
  subscription_type: string | null;
  caps: Caps;
  /** Tasks in the run's set; fewer results means the run hasn't finished (or the driver died). */
  total_tasks: number;
  /** Every container's limits, read back before each task. */
  limits: Limits;
  task_wall_ms: number;
  /** usage_limit: a usage or rate limit; halted: a run didn't end after its task's wall-clock cap. */
  stopped: 'usage_limit' | 'halted' | null;
  stop_detail: string | null;
  /**
   * The sandbox checks before the first task: the srt probe (sandbox-runtime 0.0.79, per attempt) and the one-call
   * confirmation in Claude Code's own sandbox (its status, attempts and usage). Optional only for aggregates made
   * outside a run.
   */
  sandbox?: { probe: unknown; confirmation: { status: string; usage_equivalent_usd: number } & Record<string, unknown> };
}

const RAN = new Set(['auto-merge', 'hold', 'failed', 'error', 'stopped (usage limit)']);
const NOT_DONE = new Set(['not run (usage limit)', 'not run (spend cap)', 'not run (limits)', 'not run (halted)', 'stopped (usage limit)']);

export function aggregate(meta: RunMeta, results: readonly TaskResult[], grades?: Grades) {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const ran = results.filter((r) => RAN.has(r.status));
  const usd = Math.round(ran.reduce((s, r) => s + r.usage_equivalent_usd, 0) * 100) / 100;
  const mean = ran.length ? Math.round((usd / ran.length) * 100) / 100 : 0;
  const base = {
    ...meta,
    complete: results.length === meta.total_tasks && results.every((r) => !NOT_DONE.has(r.status)),
    tasks: {
      total: meta.total_tasks,
      recorded: results.length,
      run: ran.length,
      not_run_usage_limit: count('not run (usage limit)'),
      not_run_spend_cap: count('not run (spend cap)'),
      not_run_limits: count('not run (limits)'),
      not_run_halted: count('not run (halted)'),
      wall_cap_hit: results.filter((r) => r.wall_cap_hit).length,
    },
    decisions: { auto_merge: count('auto-merge'), hold: count('hold'), failed: count('failed'), error: count('error'), stopped_usage_limit: count('stopped (usage limit)') },
    usage: {
      unit: 'usage-equivalent USD (the CLI total_cost_usd; a subscription bills none per run)',
      total: usd,
      mean_per_task: mean,
      /** The sandbox confirmation's one call, counted against the run's ceiling, not in the tasks' total. */
      sandbox_check: meta.sandbox?.confirmation.usage_equivalent_usd ?? 0,
      owner_reapproval_needed: meta.caps.mode === 'smoke' && mean > REAPPROVE_MEAN_USD,
    },
  };
  if (!grades) return { ...base, graded: null as Graded | null };
  const resolved = (r: TaskResult, label = 'final') => grades[r.key]?.[label];
  const graded = ran.filter((r) => resolved(r) !== undefined);
  const where = (d: string, ok: boolean) => graded.filter((r) => r.status === d && resolved(r) === ok).length;
  const merges = graded.filter((r) => r.status === 'auto-merge');
  const notMerged = graded.filter((r) => r.status !== 'auto-merge');
  const unresolved = graded.filter((r) => resolved(r) === false);
  const allResolved = graded.filter((r) => resolved(r) === true);
  const baseline = (label: string) => {
    const g = ran.filter((r) => resolved(r, label) !== undefined);
    return wilson(g.filter((r) => resolved(r, label)).length, g.length);
  };
  return {
    ...base,
    graded: {
      confusion: {
        auto_merge: { resolved: where('auto-merge', true), unresolved: where('auto-merge', false) },
        hold: { resolved: where('hold', true), unresolved: where('hold', false) },
        failed: { resolved: where('failed', true), unresolved: where('failed', false) },
      },
      merge_precision: wilson(merges.filter((r) => resolved(r)).length, merges.length),
      auto_merge_yield: wilson(merges.filter((r) => resolved(r)).length, ran.length),
      false_holds: wilson(notMerged.filter((r) => resolved(r)).length, allResolved.length),
      caught_bad_fixes: wilson(unresolved.filter((r) => r.status !== 'auto-merge').length, unresolved.length),
      baselines: { b0_agent_alone: baseline('b0'), b1_agent_ci_only: baseline('b1'), bare_claude_p: baseline('bare') },
    } as Graded | null,
  };
}

/** The graded part of an aggregate (null until grading). */
export interface Graded {
  confusion: Record<'auto_merge' | 'hold' | 'failed', { resolved: number; unresolved: number }>;
  merge_precision: Rate;
  auto_merge_yield: Rate;
  false_holds: Rate;
  caught_bad_fixes: Rate;
  baselines: { b0_agent_alone: Rate; b1_agent_ci_only: Rate; bare_claude_p: Rate };
}
type Rate = ReturnType<typeof wilson>;

export type Aggregate = ReturnType<typeof aggregate>;
