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
// The working folder is checked where it really is too (round 5): its realpath must be inside the task folder's, so a
// link in the task folder (or a task folder that is a link) can't take a run's sandboxed Bash writes elsewhere.
import { realpathSync, statSync } from 'node:fs';
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
 * own parentheses, a backslash, the separators an allowed-tools list splits on (a comma, whitespace), every control
 * character (C0, DEL and C1: \p{Cc}), and every format character (\p{Cf}: zero-width ones, bidi overrides such as
 * U+202E, U+FEFF), which can make a rule read as something it isn't, and lone surrogates (\p{Cs}), which no file name
 * on disk can hold as written.
 */
export const RULE_UNSAFE = /[*?[\]{}!()\\,\s\p{Cc}\p{Cf}\p{Cs}]/u;

/** Refuses (throws) unless `p` is a plain path a rule can hold: absolute, normalized, no trailing slash, not `/`. */
function rulePath(p: string, what: string): string {
  if (typeof p !== 'string' || !isAbsolute(p) || posix.normalize(p) !== p || p.endsWith('/') || RULE_UNSAFE.test(p)) {
    throw new Error(`${what} ${JSON.stringify(p)} must be a normalized absolute path with no trailing slash and no glob or rule character (${RULE_UNSAFE.source})`);
  }
  return p;
}

const within = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** A run's working folder: its path, its identity (device and inode), and the identities of it and its parents. */
interface Folder {
  path: string;
  id: string;
  /** `id` and every parent's, up to and including the task's folder. */
  chain: Set<string>;
}

/** `p` (a real path inside `top`, no link in it) as a Folder; refuses (throws) when a folder of it can't be read. */
function folderOf(p: string, top: string): Folder {
  const idOf = (d: string) => {
    try {
      const s = statSync(d, { bigint: true });
      return `${s.dev}:${s.ino}`;
    } catch (e) {
      throw new Error(`not started: ${d} can't be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  };
  const id = idOf(p);
  const chain = new Set([id]);
  for (let d = p; d !== top && d !== posix.dirname(d); ) {
    d = posix.dirname(d);
    chain.add(idOf(d));
  }
  return { path: p, id, chain };
}

/**
 * `allowed` with every file-writing tool confined to `cwd`, the run's own working folder, which must be in `workDir`,
 * the task's folder: a bare Edit, Write, MultiEdit or NotebookEdit becomes `Edit(/<cwd>/**)` (Claude Code's Edit rules
 * cover all its file-editing tools; an absolute path is written with a leading //), and `Edit(/<p>)` or
 * `Edit(/<p>/**)` stays when p is a plain, normalized path in `cwd`. Refuses (throws) a `cwd` outside `workDir`, a
 * path with a glob or rule character (RULE_UNSAFE) or a trailing slash, and any other grant of them: another folder,
 * a relative, home-relative or globbed path, a qualified Write, MultiEdit or NotebookEdit, or one in an entry that
 * names several tools.
 */
export function scopeEditTools(allowed: readonly string[], workDir: string, cwd: string): string[] {
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
  /** The working folder of each run still going (one entry per run). */
  private cwds: Folder[] = [];
  /** The working folder of every run this task has started, ended ones included. */
  private earlier: Folder[] = [];
  constructor(
    private m: UsageMeter,
    readonly perTaskUsd: number,
    /** The task's own folder: every run's working folder must be in it. */
    readonly workDir: string,
    private stop?: AbortSignal,
  ) {
    rulePath(workDir, "the task's folder");
  }
  /**
   * Throws (refuses the run, unstarted) when its working folder is missing, outside the task's folder by path or where
   * it really is (realpath: a link can't lead out), reached through a link at all (its realpath must be itself), or
   * nested with a run of this task still going (the same folder, one inside the other, either way), strictly inside an
   * earlier run's working folder, or its allowed tools grant a file-writing tool outside that working folder.
   *
   * Why the nesting rule (round 6): the folder is checked here, and the engine's runner spawns claude in it later,
   * after awaits (the login lock, MCP registration). In between, whatever can write a parent of one of its components
   * could swap that component for a link out. In the bench that is another of the task's runs, whose sandboxed Bash may
   * write its own working folder; with no two runs of a task in nested folders at once, none can. A process an ended
   * run left behind could do the same, so no run starts strictly inside an earlier one's folder either. The check and the
   * registration below run with no await between them, so two runs started together can't both pass it.
   */
  async run(req: RunRequest): Promise<RunResult> {
    // The cwd as given, never a default: a missing one is refused by rulePath.
    const allowedTools = scopeEditTools(req.allowedTools, this.workDir, req.cwd);
    const real = (p: string, what: string) => {
      try {
        return realpathSync(p);
      } catch (e) {
        throw new Error(`not started: ${what} ${p} can't be resolved (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
      }
    };
    const realCwd = real(req.cwd, "the run's working folder");
    const realWork = real(this.workDir, "the task's folder");
    // The driver builds the task folder on the bench root's real path (paths.ts benchRoot), so it is never a link.
    if (realWork !== this.workDir) throw new Error(`not started: the task's folder ${this.workDir} is really ${realWork}: a task folder through a link is refused`);
    if (!within(realCwd, realWork)) throw new Error(`not started: the run's working folder ${req.cwd} is really ${realCwd}, outside the task's folder ${this.workDir} (really ${realWork})`);
    // No link anywhere in it, even one that stays inside: the Edit rule then names the real folder (round 6).
    if (realCwd !== req.cwd) throw new Error(`not started: the run's working folder ${req.cwd} is really ${realCwd}: a working folder through a link is refused`);
    // Compared by path and by device and inode (round 7), so two spellings of one folder (a case- or
    // normalisation-insensitive filesystem) are still the same folder.
    const folder = folderOf(req.cwd, this.workDir);
    const nested = this.cwds.find((c) => within(req.cwd, c.path) || within(c.path, req.cwd) || c.chain.has(folder.id) || folder.chain.has(c.id));
    if (nested !== undefined) throw new Error(`not started: the run's working folder ${req.cwd} is nested with ${nested.path}, the working folder of a run of this task still going (its commands could swap a folder of this one)`);
    // An ended run may have left a process behind (a background command, say) that can still write its working folder:
    // no later run starts strictly inside it. The same folder again is fine: swapping it needs its parent.
    const under = this.earlier.find((c) => (c.path !== req.cwd && within(req.cwd, c.path)) || (c.id !== folder.id && folder.chain.has(c.id)));
    if (under !== undefined) throw new Error(`not started: the run's working folder ${req.cwd} is inside ${under.path}, the working folder of an earlier run of this task (a process it left could swap a folder of this one)`);
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
    // Registered before the first await: from here until the run has ended, no nested run of this task starts.
    this.cwds.push(folder);
    this.earlier.push(folder);
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
      this.cwds.splice(this.cwds.indexOf(folder), 1);
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
