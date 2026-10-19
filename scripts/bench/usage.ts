// The bench's usage meter (#748): every agent run goes through it. It records each run's usage from the CLI's own
// accounting (the engine's RunResult, read from claude's JSON result: total_cost_usd, turns, tokens), as
// usage-equivalent dollars; caps each run at what is left of its task's cap and of the run's ceiling; and stops the
// whole bench at the first usage or rate limit: no retry, no other account, no run after it (each later one is
// refused unstarted), and every task in flight is aborted. A rate limit is any result the engine classes as one
// (classifyTransient): its `rate_limited`, and a failed run on a 429 with no result line too. No retry at all: the
// bench's runner is built with retries off (agent.ts), and should any runner start to wait out a transient error
// anyway, the meter aborts that wait (a rate limit stops the bench; anything else ends that run).
import { classifyTransient, type AgentRunner, type RunRequest, type RunResult, type TerminalReason } from '../../src/runner.js';

export interface RunUsage {
  role: string;
  model: string;
  reason: TerminalReason;
  usage_equivalent_usd: number;
  turns: number;
  tokens_in: number;
  tokens_out: number;
}

export interface LimitStop {
  detail: string;
  /** When claude said the limit resets (ISO), if it did. */
  reset_at: string | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export class UsageMeter {
  spent = 0;
  limited: LimitStop | null = null;
  private stop = new AbortController();
  constructor(
    private inner: AgentRunner,
    readonly spendUsd: number,
  ) {}
  get left(): number {
    return Math.max(0, cents(this.spendUsd - this.spent));
  }
  /** Aborted at the first usage limit. */
  get signal(): AbortSignal {
    return this.stop.signal;
  }
  /** The runner one task's agents get. */
  task(perTaskUsd: number): TaskMeter {
    return new TaskMeter(this, perTaskUsd);
  }
  private limit(detail: string, resetAt: string | null): void {
    if (this.limited) return;
    this.limited = { detail: detail.slice(0, 300), reset_at: resetAt };
    this.stop.abort();
  }
  /** @internal */
  async meter(req: RunRequest): Promise<RunResult> {
    const own = new AbortController();
    const signal = AbortSignal.any([own.signal, this.stop.signal, ...(req.signal ? [req.signal] : [])]);
    const r = await this.inner.run({
      ...req,
      signal,
      onTransientRetry: (t) => {
        // Never waited out: a rate limit stops the bench here, before a second session can start.
        if (t.cause === 'rate_limit') this.limit(t.detail, null);
        else own.abort();
        req.onTransientRetry?.(t);
      },
    });
    this.spent = cents(this.spent + r.costUsd);
    if (r.reason !== 'succeeded' && classifyTransient(r.reason, r.detail) === 'rate_limit') this.limit(r.detail, r.limit?.resetAt ?? null);
    return r;
  }
}

export class TaskMeter implements AgentRunner {
  runs: RunUsage[] = [];
  spent = 0;
  /** A run was refused or cut for the task's cap or the run's ceiling. */
  capHit = false;
  constructor(
    private m: UsageMeter,
    readonly perTaskUsd: number,
  ) {}
  async run(req: RunRequest): Promise<RunResult> {
    const refused = (reason: TerminalReason, detail: string): RunResult => ({ reason, detail, costUsd: 0, turns: 0, model: req.model });
    if (this.m.limited) return refused('rate_limited', `not started: the bench stopped at a usage limit (${this.m.limited.detail})`);
    const cap = cents(Math.min(req.maxBudgetUsd, this.perTaskUsd - this.spent, this.m.left));
    if (cap < 0.01) {
      this.capHit = true;
      return refused('budget_exhausted', `not started: the task's $${this.perTaskUsd} cap or the run's ceiling is spent`);
    }
    const r = await this.m.meter({ ...req, maxBudgetUsd: cap });
    if (r.reason === 'budget_exhausted' && cap < req.maxBudgetUsd) this.capHit = true;
    this.spent = cents(this.spent + r.costUsd);
    this.runs.push({ role: req.role, model: r.model, reason: r.reason, usage_equivalent_usd: r.costUsd, turns: r.turns, tokens_in: r.tokens?.in ?? 0, tokens_out: r.tokens?.out ?? 0 });
    return r;
  }
}
