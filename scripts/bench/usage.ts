// The bench's usage meter (#748): every agent run goes through it. It records each run's usage from the CLI's own
// accounting (the engine's RunResult, read from claude's JSON result: total_cost_usd, turns, tokens), as
// usage-equivalent dollars; caps each run at what is left of its task's cap and of the run's ceiling; and stops the
// whole bench at the first usage or rate limit: no retry, no other account, no run after it (each later one is
// refused unstarted), and every task in flight is aborted. A rate limit is any result the engine classes as one
// (classifyTransient): its `rate_limited`, and a failed run on a 429 with no result line too. No retry at all: the
// bench's runner is built with retries off (agent.ts), and should any runner start to wait out a transient error
// anyway, the meter aborts that wait (a rate limit stops the bench; anything else ends that run).
// It also confines the file-writing tools (owner, 2026-10-18 and 2026-10-19): Edit, Write, MultiEdit and NotebookEdit
// run outside the sandbox, as the bench user, so a run may have them pre-approved only inside its own working folder
// (its cwd), which must itself be inside the task's folder (scopeEditTools). Not the whole task folder: an Edit allow
// rule also widens where sandboxed Bash may write (Claude Code's sandboxing docs, inferred), and the sandbox protects
// .claude/ and .git/ hooks and config only in and above the working folder. Any other grant of them, or a cwd outside
// the task's folder, refuses the run. A path put into a rule must hold no glob or rule-syntax character
// (RULE_UNSAFE): refused, never escaped, since the escaping rules of Claude Code's rule globs aren't documented.
import { isAbsolute, posix } from 'node:path';
import { classifyTransient, type AgentRunner, type RunRequest, type RunResult, type TerminalReason } from '../../src/runner.js';

/** Claude Code's file-writing tools: they run outside its sandbox (owner, 2026-10-18). */
export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** An allowed-tools entry's tool names: its text outside parentheses, split where the CLI would split it. */
function toolNames(entry: string): string[] {
  let depth = 0;
  let out = '';
  for (const ch of entry) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out.split(/[,\s]+/).filter(Boolean);
}

/**
 * Characters a path put into a permission rule may not hold: glob syntax (`*`, `?`, `[`, `]`, `{`, `}`, `!`), the rule's
 * own parentheses, a backslash, and the separators an allowed-tools list splits on (a comma, whitespace).
 */
export const RULE_UNSAFE = /[*?[\]{}!()\\,\s]/;

/** Refuses (throws) unless `p` is a plain path a rule can hold: absolute, normalized, no trailing slash, not `/`. */
function rulePath(p: string, what: string): string {
  if (typeof p !== 'string' || !isAbsolute(p) || posix.normalize(p) !== p || p.endsWith('/') || RULE_UNSAFE.test(p)) {
    throw new Error(`${what} ${JSON.stringify(p)} must be a normalized absolute path with no trailing slash and no glob or rule character (${RULE_UNSAFE.source})`);
  }
  return p;
}

const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/**
 * `allowed` with every file-writing tool confined to `cwd`, the run's own working folder, which must be in `workDir`,
 * the task's folder: a bare Edit, Write, MultiEdit or NotebookEdit becomes `Edit(/<cwd>/**)` (Claude Code's Edit rules
 * cover all its file-editing tools; an absolute path is written with a leading //), and `Edit(/<p>)` or
 * `Edit(/<p>/**)` stays when p is a plain, normalized path in `cwd`. Refuses (throws) a `cwd` outside `workDir`, a
 * path with a glob or rule character (RULE_UNSAFE) or a trailing slash, and any other grant of them: another folder,
 * a relative, home-relative or globbed path, a qualified Write, MultiEdit or NotebookEdit, or one in an entry that
 * names several tools.
 */
export function scopeEditTools(allowed: readonly string[], workDir: string, cwd: string = workDir): string[] {
  rulePath(workDir, "the task's folder");
  rulePath(cwd, "the run's working folder");
  if (!within(cwd, workDir)) throw new Error(`not started: the run's working folder ${cwd} is outside the task's folder ${workDir}`);
  const scoped = `Edit(/${cwd}/**)`;
  const out: string[] = [];
  for (const entry of allowed) {
    const names = toolNames(entry);
    const edits = names.filter((n) => EDIT_TOOLS.some((t) => t.toLowerCase() === n.toLowerCase()));
    if (!edits.length) {
      out.push(entry);
      continue;
    }
    const refuse = (why: string) => new Error(`not started: allowed tool ${JSON.stringify(entry)} ${why}; file-writing tools run outside the sandbox, so they are allowed only in the run's own working folder (${scoped})`);
    if (names.length !== 1) throw refuse('names several tools in one entry');
    const m = /^([A-Za-z]+)(?:\((.*)\))?$/s.exec(entry.trim());
    if (!m || !EDIT_TOOLS.includes(m[1]!)) throw refuse('is not one tool name');
    if (m[2] === undefined) {
      out.push(scoped);
      continue;
    }
    const path = m[1] === 'Edit' && m[2].startsWith('//') ? m[2].slice(1).replace(/\/\*\*$/, '') : null;
    if (!path || RULE_UNSAFE.test(path) || path.endsWith('/') || posix.normalize(path) !== path || !within(path, cwd)) throw refuse(`reaches outside ${cwd}`);
    out.push(entry.trim());
  }
  return [...new Set(out)];
}

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
  /**
   * The runner one task's agents get. `workDir` is the task's own folder: every run's working folder must be in it,
   * and its file-writing tools are confined to that working folder (scopeEditTools). `signal` is the task's own stop (the driver's wall-clock cap): every run gets
   * it, whatever the task passes, and once it fires no run starts.
   */
  task(perTaskUsd: number, workDir: string, signal?: AbortSignal): TaskMeter {
    return new TaskMeter(this, perTaskUsd, workDir, signal);
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
  /** The task's runs still going. */
  private inflight = new Set<Promise<unknown>>();
  constructor(
    private m: UsageMeter,
    readonly perTaskUsd: number,
    /** The task's own folder: every run's working folder must be in it. */
    readonly workDir: string,
    private stop?: AbortSignal,
  ) {
    scopeEditTools([], workDir);
  }
  /**
   * Throws (refuses the run, unstarted) when its working folder is outside the task's folder, or its allowed tools
   * grant a file-writing tool outside that working folder.
   */
  async run(req: RunRequest): Promise<RunResult> {
    const allowedTools = scopeEditTools(req.allowedTools, this.workDir, req.cwd);
    req = { ...req, allowedTools };
    const refused = (reason: TerminalReason, detail: string): RunResult => ({ reason, detail, costUsd: 0, turns: 0, model: req.model });
    if (this.m.limited) return refused('rate_limited', `not started: the bench stopped at a usage limit (${this.m.limited.detail})`);
    if (this.stop?.aborted) return refused('stopped', "not started: the task's wall-clock cap has passed");
    const cap = cents(Math.min(req.maxBudgetUsd, this.perTaskUsd - this.spent, this.m.left));
    if (cap < 0.01) {
      this.capHit = true;
      return refused('budget_exhausted', `not started: the task's $${this.perTaskUsd} cap or the run's ceiling is spent`);
    }
    const signal = this.stop ? AbortSignal.any([this.stop, ...(req.signal ? [req.signal] : [])]) : req.signal;
    // The whole run, its record included: what settled() waits for.
    const whole = (async () => {
      const r = await this.m.meter({ ...req, maxBudgetUsd: cap, ...(signal ? { signal } : {}) });
      if (r.reason === 'budget_exhausted' && cap < req.maxBudgetUsd) this.capHit = true;
      this.spent = cents(this.spent + r.costUsd);
      this.runs.push({ role: req.role, model: r.model, reason: r.reason, usage_equivalent_usd: r.costUsd, turns: r.turns, tokens_in: r.tokens?.in ?? 0, tokens_out: r.tokens?.out ?? 0 });
      return r;
    })();
    this.inflight.add(whole);
    try {
      return await whole;
    } finally {
      this.inflight.delete(whole);
    }
  }
  /** Waits (at most `ms`) for the task's runs in flight to end and be recorded; whether they all did. */
  async settled(ms: number): Promise<boolean> {
    if (!this.inflight.size) return true;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
    const all = Promise.allSettled([...this.inflight]).then(() => true as const);
    try {
      return await Promise.race([all, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
