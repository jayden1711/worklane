// The bench's caps (#748, owner's decisions of 2026-10-18), in usage-equivalent dollars: what the CLI's own
// accounting (`total_cost_usd` in its JSON result) says a run would have cost, recorded per task. The bench runs on a
// subscription login, so no dollar is billed per run; the caps bound how much of the plan's usage a run may take.
// The run's ceiling is the caller's alone (--spend, src/spend-gate.ts): no default ever supplies it. The per-mode
// maxima and the per-task cap are the owner's approval, here in code: raising one is a reviewed change.
import { SPEND_FLAG, spendFromArgs, spendRefusal } from '../../src/spend-gate.js';

export type Mode = 'smoke' | 'baseline';

/** The most --spend may be per mode: $40 per smoke round, about $300 for the baseline (re-derived after the smoke). */
export const MODE_MAX_USD: Readonly<Record<Mode, number>> = { smoke: 40, baseline: 300 };
/** The most one task may take, and the default per-task cap. */
export const PER_TASK_MAX_USD = 15;
/** A smoke round averaging more than this per task needs the owner's re-approval before the baseline. */
export const REAPPROVE_MEAN_USD = 8;

export interface Caps {
  mode: Mode;
  /** The whole run's ceiling. */
  spendUsd: number;
  perTaskUsd: number;
}

const value = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
};

/**
 * The run's caps from its arguments, or why it doesn't start: `refused` (exit 2, the spend gate's plan) without
 * --spend; a thrown error for a cap over the owner's approval. `smokeMeanUsd` is the last smoke round's mean per task
 * (its aggregate), which a baseline run needs: over REAPPROVE_MEAN_USD it starts only with --owner-reapproved.
 */
export function capsFromArgs(argv: readonly string[], plan: (c: Omit<Caps, 'spendUsd'>) => string[], smokeMeanUsd?: number | null): Caps | { refused: string } {
  const mode = (value(argv, '--tasks') ?? 'smoke') as Mode;
  if (!(mode in MODE_MAX_USD)) throw new Error(`--tasks takes smoke or baseline, not ${mode}`);
  const rawTask = value(argv, '--per-task-cap');
  const perTaskUsd = rawTask === undefined ? PER_TASK_MAX_USD : Number(rawTask);
  if (!Number.isFinite(perTaskUsd) || perTaskUsd <= 0) throw new Error(`--per-task-cap takes a positive number of dollars, not ${rawTask}`);
  if (perTaskUsd > PER_TASK_MAX_USD) throw new Error(`--per-task-cap ${perTaskUsd} is over the approved $${PER_TASK_MAX_USD} per task`);
  const spendUsd = spendFromArgs(argv);
  if (spendUsd === null) return { refused: spendRefusal(plan({ mode, perTaskUsd }), MODE_MAX_USD[mode]) };
  if (spendUsd > MODE_MAX_USD[mode]) throw new Error(`${SPEND_FLAG} ${spendUsd} is over the approved $${MODE_MAX_USD[mode]} for a ${mode} run`);
  if (perTaskUsd > spendUsd) throw new Error(`--per-task-cap ${perTaskUsd} is over ${SPEND_FLAG} ${spendUsd}`);
  if (mode === 'baseline') {
    if (smokeMeanUsd === undefined || smokeMeanUsd === null) throw new Error('a baseline run needs a finished smoke round first (its aggregate gives the cost per task the budget is re-derived from)');
    if (smokeMeanUsd > REAPPROVE_MEAN_USD && !argv.includes('--owner-reapproved')) {
      throw new Error(`the smoke round averaged $${smokeMeanUsd.toFixed(2)} per task, over $${REAPPROVE_MEAN_USD}: the owner re-approves the budget before the baseline (--owner-reapproved)`);
    }
  }
  return { mode, spendUsd, perTaskUsd };
}
