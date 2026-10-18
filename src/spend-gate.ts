// The spend gate (#612): a command that can call a paid model runs only when its caller says how much it may spend,
// with --spend <usd>. Without it the command prints what it would do (what it would run and the most it could spend)
// and exits 2, before any model call, any held-out read and any state write. The ceiling is the caller's alone: no
// config and no default ever supplies it, and it bounds the command's own caps (--cap, --budget) from above.
// Held-out cases are read only from a store the caller pointed at on purpose: the held-out env variable
// (HELD_OUT_ENV), or --held-out-from-state for the store in this machine's state.
// Used by scripts/eval-roles.mjs, scripts/eval-stage-labels.mjs, `skill eval` and `harness-eval run`. The
// coordinator's scheduled harness evals don't come through here: the owner's config is their opt-in.
// WHY: an agent ran scripts/eval-roles.mjs with no flags while developing; it made real model calls and read the
// machine's held-out store, and nothing asked first.
import { HELD_OUT_ENV } from './held-out-paths.js';
import { failedCost, type Ask } from './skilleval.js';

/** The one flag that lets a command spend: the most this invocation may spend in all, in dollars. */
export const SPEND_FLAG = '--spend';

/** Read held-out cases from the store in this machine's state (when the held-out env variable isn't set). */
export const HELD_OUT_FROM_STATE_FLAG = '--held-out-from-state';

/** The exit code of a run the gate stopped. */
export const SPEND_REFUSED = 2;

/** The --spend ceiling in dollars; null when it wasn't given. A value that isn't a positive number is refused. */
export function spendFromArgs(argv: readonly string[]): number | null {
  const glued = argv.find((a) => a.startsWith(`${SPEND_FLAG}=`));
  if (glued) throw new Error(`write ${SPEND_FLAG} <usd> with a space, not ${glued}`);
  const i = argv.indexOf(SPEND_FLAG);
  if (i < 0) return null;
  const raw = argv[i + 1];
  const usd = Number(raw);
  if (raw === undefined || raw.startsWith('--') || !Number.isFinite(usd) || usd <= 0) {
    throw new Error(`${SPEND_FLAG} takes the most this run may spend, a positive number of dollars (e.g. ${SPEND_FLAG} 5), not ${raw ?? 'nothing'}`);
  }
  return usd;
}

/** Whether the caller pointed at a held-out store on purpose: the env variable, or --held-out-from-state. */
export function heldOutAllowed(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[HELD_OUT_ENV]) || argv.includes(HELD_OUT_FROM_STATE_FLAG);
}

/** Said when held-out cases weren't read because nobody asked for them. */
export const HELD_OUT_NOT_ASKED = `held-out cases not read: set ${HELD_OUT_ENV} to a held-out store, or pass ${HELD_OUT_FROM_STATE_FLAG} for the one in this machine's state`;

/** What a run without --spend prints: its plan, the most it could spend, and how to run it. */
export function spendRefusal(plan: readonly string[], maxUsd: number): string {
  return [
    ...plan,
    `the most it could spend: ~$${maxUsd.toFixed(2)}`,
    `not run: this makes paid model calls. Run it with ${SPEND_FLAG} <usd>, the most this run may spend in all (it bounds every cap above).`,
  ].join('\n');
}

/** An Ask stopped at the --spend ceiling. */
export class SpendCeilingReached extends Error {
  constructor(ceilingUsd: number) {
    super(`the ${SPEND_FLAG} ceiling ($${ceilingUsd}) is reached: no more model calls`);
  }
}

/**
 * Every call through `ask` under one ceiling for the whole invocation: each call's budget is cut to what is left,
 * and a call with nothing left is refused (SpendCeilingReached). A call that fails counts what it reported spending. One call can still end a little past its budget
 * (the CLI checks it between turns); the next one is then refused.
 */
export function ceilingAsk(ask: Ask, ceilingUsd: number): { ask: Ask; spent: () => number; left: () => number } {
  let spent = 0;
  return {
    ask: async (req) => {
      const left = ceilingUsd - spent;
      if (left <= 0) throw new SpendCeilingReached(ceilingUsd);
      let r;
      try {
        r = await ask({ ...req, maxBudgetUsd: Math.min(req.maxBudgetUsd, left) });
      } catch (e) {
        // A failed call can have spent (its budget, --max-turns): that counts too (AskFailed carries it).
        spent += failedCost(e);
        throw e;
      }
      spent += r.costUsd;
      return r;
    },
    spent: () => spent,
    left: () => Math.max(0, ceilingUsd - spent),
  };
}
