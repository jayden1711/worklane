// Agent runners. The default runs the locally installed `claude` headless
// with the user's own auth; an option runs it with an API key. Either way
// the agent's environment is built from an allowlist: no GitHub token, no
// git credential helper, no SSH agent, so an agent can't push or write to
// GitHub even if it tries. It proposes; the coordinator acts.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { BRAND } from './brand.js';
import { safeProjectEnv } from './project-env.js';
import { asUser, killTree, killTreeAs, spawnDetached } from './os/index.js';
import { RunRecorder, runIssue } from './run-record.js';
import { RunFeed } from './run-feed.js';
import { RefusalTracker, type RefusedRequest } from './domain-requests.js';
import { allowedDomainsOf, withAllowedDomains } from './sandbox.js';

export type TerminalReason = 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'rate_limited' | 'canceled_by_reconciliation' | 'budget_exhausted' | 'auth_mismatch' | 'stopped';

export interface RunRequest {
  role: string;
  /**
   * Hosts the owner allowed for this one run (an "allow once" answer): added to the sandbox's allowedDomains
   * for this run's commands, and to the hook's WebFetch allowlist through the environment. Never kept.
   */
  allowOnce?: string[];
  /** Coordinator's project state dir; hooks in the agent's session log there. */
  stateDir?: string;
  prompt: string;
  appendSystemPrompt?: string;
  cwd: string;
  model: string;
  allowedTools: string[];
  disallowedTools?: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  jsonSchema?: object;
  taskFile?: string;
  stallMs: number;
  timeoutMs: number;
  onStart?: (pid: number) => void;
  onActivity?: (note: string) => void;
  /** Once the session is up: the handle for messaging and stopping it (the console). Called again on a retried start. */
  onControl?: (c: RunControl) => void;
  /** A console message's progress: queued (held until the current turn ends), delivered, or dropped (the run ended first). */
  onMessage?: (m: { id: string; state: 'queued' | 'delivered' | 'dropped' }) => void;
  /** Once the run holds its Claude login's lock: how long it waited for it (another run on the same login), in ms. */
  onLockWait?: (ms: number) => void;
  /** Before each wait on a transient error: which try failed, why (classified), and how long until the next. */
  onTransientRetry?: (r: TransientRetry) => void;
  signal?: AbortSignal;
  /** The lane this run belongs to (an issue's lane:<name> label); default when unset. */
  lane?: string;
  /** The project's own variables (tests.yaml env); never one the harness sets. */
  env?: Record<string, string>;
  /** The issue this run works on, for its run record; read from the worktree or task file name when unset. */
  issue?: number;
}

export interface RunResult {
  reason: TerminalReason;
  detail: string;
  structured?: unknown;
  costUsd: number;
  turns: number;
  model: string;
  sessionId?: string;
  /** The run kept failing on an auth or transient error (token refresh, rate limit, overload, network), not on the task. */
  transient?: boolean;
  /** Hosts the run was refused (outside its allowlist), each once: for the owner to decide on. */
  refusedHosts?: RefusedRequest[];
}

/**
 * A live session's console handle. The session's input stays open (stream-json) for the whole run: a message
 * is held until the current turn's result, then delivered as the next user message (a message written mid-turn
 * would be folded into that turn and change its outcome). With nothing held at a result, the input is closed
 * and the session ends.
 */
export interface RunControl {
  /** The run's id: its run record and live feed (null without a state dir). */
  runId: string | null;
  /** Queue a message; refused once the session's input is closed. */
  send(id: string, text: string): { queued: true } | { queued: false; why: string };
  /** End the run now (its process tree), as a stop. */
  stop(): void;
}

/** One user message on stream-json input. */
export const userMessage = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;

export interface AgentRunner {
  run(req: RunRequest): Promise<RunResult>;
}

// CLAUDE_CONFIG_DIR: an instance's own Claude login (a path, not a secret).
const PASS_THROUGH = ['CLAUDE_CONFIG_DIR', 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'XDG_RUNTIME_DIR', 'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData', 'ProgramFiles', 'NODE_EXTRA_CA_CERTS'];

/**
 * The agent's whole environment. Anything not listed is dropped, which
 * removes GitHub tokens, cloud keys, database URLs and the SSH agent.
 */
export function agentEnv(base: NodeJS.ProcessEnv, runtime: 'cli' | 'sdk', extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASS_THROUGH) if (base[k] !== undefined) env[k] = base[k];
  if (runtime === 'sdk' && base.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
  Object.assign(env, {
    [`${BRAND.envPrefix}_AGENT`]: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // git: no credential helpers or prompts, so pushes can't authenticate.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'false',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    // gh: an empty config dir means no stored login.
    GH_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'no-gh-')),
    ...extra,
  });
  return env;
}

/** The one identity every commit an agent or the coordinator makes carries. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/** Without an instance (a plain repo), and in tests. */
export const DEFAULT_COMMIT_IDENTITY: CommitIdentity = { name: BRAND.cli, email: `${BRAND.cli}@localhost` };

/** Git reads these before any config, so an agent's commits carry the harness identity whatever its git config says. */
export function identityEnv(id: CommitIdentity): Record<string, string> {
  return { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
}

/** An unprivileged OS user agents run as, separate from the coordinator's (which holds the credentials). */
export interface RunAs {
  user: string;
  /** The agent user's home; its own Claude login lives here. */
  home: string;
  /** Defaults to <home>/.claude. */
  claudeConfigDir?: string;
}

/** The agent's environment when it runs as its own user: its home, its login, git trusting worktrees it doesn't own. */
export function runAsEnv(env: NodeJS.ProcessEnv, r: RunAs): NodeJS.ProcessEnv {
  return {
    ...env,
    HOME: r.home,
    USER: r.user,
    LOGNAME: r.user,
    CLAUDE_CONFIG_DIR: r.claudeConfigDir ?? posix.join(r.home, '.claude'), // agent users exist on POSIX systems only
    // Worktrees belong to the coordinator user; git refuses repos owned by someone else unless trusted.
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_1: 'safe.directory',
    GIT_CONFIG_VALUE_1: '*',
  };
}

/** Which auth `claude` would use. The cli runtime refuses API-key billing it wasn't asked for. */
export function claudeAuthMethod(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude'): string {
  return claudeAuthStatus(env, runAs, bin).method;
}

/** claude auth status: the auth method ('none' when signed out, 'unknown' when unreadable) and what it printed otherwise. */
export function claudeAuthStatus(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude'): { method: string; text: string } {
  const [file, args] = runAs ? asUser(runAs.user, bin, ['auth', 'status', '--json'], env) : [bin, ['auth', 'status', '--json']];
  const r = spawnSync(file, args, { encoding: 'utf8', env: runAs ? { PATH: env.PATH ?? '' } : env, timeout: 30_000 });
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
    return { method: j.loggedIn ? (j.authMethod ?? 'unknown') : 'none', text: '' };
  } catch {
    return { method: 'unknown', text: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().slice(-500) };
  }
}

/**
 * Errors that say nothing about the task: the Claude login's token refresh, rate limits, overload,
 * server errors and the network. Another attempt at the same moment fails the same way; waiting helps.
 */
export const TRANSIENT_ERROR = /failed to refresh oauth token|another claude code process is refreshing|exited mid-refresh|overloaded|\b529\b|rate.?limit|\b429\b|api error:? *5\d\d|\b50[234]\b|econnreset|etimedout|enotfound|eai_again|econnrefused|socket hang up|fetch failed|network error/i;

export type TransientCause = 'token_refresh' | 'rate_limit' | 'overloaded' | 'server_error' | 'network' | 'other';

export interface TransientRetry {
  /** The try that failed (1 = the first). */
  attempt: number;
  cause: TransientCause;
  waitMs: number;
  detail: string;
}

/** What a transient failure was about, for the record (the retry itself treats them all alike). */
export function classifyTransient(reason: string, detail: string): TransientCause {
  if (/failed to refresh oauth token|another claude code process is refreshing|exited mid-refresh/i.test(detail)) return 'token_refresh';
  if (reason === 'rate_limited' || /rate.?limit|\b429\b/i.test(detail)) return 'rate_limit';
  if (/overloaded|\b529\b/i.test(detail)) return 'overloaded';
  if (/api error:? *5\d\d|\b50[234]\b/i.test(detail)) return 'server_error';
  if (/econnreset|etimedout|enotfound|eai_again|econnrefused|socket hang up|fetch failed|network error/i.test(detail)) return 'network';
  return 'other';
}

/** Waits between tries after a transient error: 1 min, 2 min, then every 5 min. */
export const TRANSIENT_BACKOFF_MS = [60_000, 120_000, 300_000];
/** How long transient errors are retried before the run is reported as failed on them. */
export const TRANSIENT_BUDGET_MS = 30 * 60_000;
/** A failure this soon after starting (or within one turn) happened before the task began. */
const STARTUP_WINDOW_MS = 90_000;

/**
 * One claude at a time per Claude login (CLAUDE_CONFIG_DIR): two processes on one login can refresh its
 * token at the same moment, and the loser fails ("another Claude Code process is refreshing it").
 */
const loginLocks = new Map<string, Promise<unknown>>();
export async function withLoginLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = loginLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  loginLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (loginLocks.get(key) === tail) loginLocks.delete(key);
  }
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve(false);
    });
  });

export interface RetryOptions {
  now?: () => number;
  /** Resolves false when the run was canceled while waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  budgetMs?: number;
}

/**
 * The claude command line. The prompt is not on it: command lines are public
 * on the machine and sudo logs them to the journal, so the prompt goes on
 * stdin and the role's system prompt in a file (`systemPromptFile`).
 */
export function cliArgs(req: RunRequest, settings?: object, systemPromptFile?: string): string[] {
  const args = [...(settings ? ['--settings', JSON.stringify(settings)] : []), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', req.model, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--max-turns', String(req.maxTurns), '--max-budget-usd', String(req.maxBudgetUsd)];
  if (req.allowedTools.length) args.push('--allowedTools', ...req.allowedTools);
  if (req.disallowedTools?.length) args.push('--disallowedTools', ...req.disallowedTools);
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  return args;
}

/** The end of claude's stderr, for a failure report: its last few non-empty lines. */
export function stderrTail(stderr: string, lines = 5): string {
  return stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-lines).join('\n') || '(nothing on stderr)';
}

interface ResultLine {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  structured_output?: unknown;
  result?: string;
  session_id?: string;
  modelUsage?: Record<string, unknown>;
  api_error_status?: number | null;
}

export class CliRunner implements AgentRunner {
  constructor(
    private runtime: 'cli' | 'sdk' = 'cli',
    private base: NodeJS.ProcessEnv = process.env,
    private bin = 'claude',
    private runAs?: RunAs,
    /** Per lane: the user and sandbox settings. When set, a run in an unknown lane is refused. */
    private lanes?: Record<string, { runAs?: RunAs; settings?: object }>,
    /** Agents' commits carry this identity, never one they pick. */
    private identity: CommitIdentity = DEFAULT_COMMIT_IDENTITY,
    private retry: RetryOptions = {},
  ) {}

  /** The Claude login a run uses: the lane's agent user's config dir, else the runner's own. */
  private loginOf(req: RunRequest): string {
    const lane = this.lanes?.[req.lane ?? 'default'];
    const runAs = lane ? lane.runAs : this.runAs;
    if (runAs) return runAs.claudeConfigDir ?? posix.join(runAs.home, '.claude');
    return this.base.CLAUDE_CONFIG_DIR ?? join(this.base.HOME ?? this.base.USERPROFILE ?? '', '.claude');
  }

  /**
   * One run, serialized per Claude login. A failure at startup on an auth or transient error is not
   * the task's: it is retried after a wait (1 min, 2 min, then 5 min) for up to TRANSIENT_BUDGET_MS,
   * and only then reported, marked transient.
   */
  async run(req: RunRequest): Promise<RunResult> {
    const now = this.retry.now ?? Date.now;
    const sleep = this.retry.sleep ?? sleepFor;
    const budget = this.retry.budgetMs ?? TRANSIENT_BUDGET_MS;
    const first = now();
    for (let tries = 1; ; tries++) {
      const started = now();
      const r = await withLoginLock(this.loginOf(req), () => {
        req.onLockWait?.(Math.max(0, now() - started));
        return this.runOnce(req);
      });
      const atStartup = now() - started < STARTUP_WINDOW_MS || r.turns <= 1;
      const transient = atStartup && (r.reason === 'rate_limited' || ((r.reason === 'failed' || r.reason === 'auth_mismatch') && TRANSIENT_ERROR.test(r.detail)));
      if (!transient) return r;
      const wait = TRANSIENT_BACKOFF_MS[Math.min(tries - 1, TRANSIENT_BACKOFF_MS.length - 1)]!;
      if (now() + wait - first > budget) {
        const mins = Math.max(1, Math.round((now() - first) / 60_000));
        return { ...r, reason: r.reason === 'auth_mismatch' ? 'failed' : r.reason, transient: true, detail: `${r.detail} (still failing after ${tries} tries over ${mins} min)` };
      }
      req.onTransientRetry?.({ attempt: tries, cause: classifyTransient(r.reason, r.detail), waitMs: wait, detail: r.detail.slice(0, 300) });
      req.onActivity?.(`transient error, retrying in ${Math.round(wait / 1000)}s: ${r.detail.slice(0, 200)}`);
      if (!(await sleep(wait, req.signal))) return { ...r, reason: 'canceled_by_reconciliation', detail: `canceled while waiting out a transient error: ${r.detail}` };
    }
  }

  private async runOnce(req: RunRequest): Promise<RunResult> {
    const env = agentEnv(this.base, this.runtime, {
      ...safeProjectEnv(req.env),
      ...identityEnv(this.identity),
      [`${BRAND.envPrefix}_ROLE`]: req.role,
      ...(req.taskFile ? { [`${BRAND.envPrefix}_TASK_FILE`]: req.taskFile } : {}),
      ...(req.stateDir ? { [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: req.stateDir } : {}),
      ...(req.allowOnce?.length ? { [`${BRAND.envPrefix}_ALLOW_HOSTS`]: req.allowOnce.join(',') } : {}),
    });
    const laneName = req.lane ?? 'default';
    const lane = this.lanes?.[laneName];
    if (this.lanes && !lane) return { reason: 'failed', detail: `unknown lane "${laneName}"; not starting`, costUsd: 0, turns: 0, model: req.model };
    const runAs = lane ? lane.runAs : this.runAs;
    const runEnv = runAs ? runAsEnv(env, runAs) : env;
    // Preflight, inside the login lock: an unreadable status that mentions a token refresh (or any other
    // transient error) is reported with its text, and run() waits it out instead of starting claude.
    const status = claudeAuthStatus(runEnv, runAs, this.bin);
    const auth = status.method;
    const want = this.runtime === 'cli' ? ['claude.ai', 'oauth_token'] : ['api_key', 'api_key_helper'];
    if (!want.includes(auth)) {
      return { reason: 'auth_mismatch', detail: `runtime ${this.runtime} expects ${want.join(' or ')} auth, claude reports ${auth}${status.text ? `: ${status.text}` : ''}; not starting (no silent billing switch)`, costUsd: 0, turns: 0, model: req.model };
    }
    // The role's system prompt, in a file the agent user can read (this process's /tmp, private to the
    // instance's service and its agents), removed when the run ends.
    const promptDir = req.appendSystemPrompt ? mkdtempSync(join(tmpdir(), `${BRAND.cli}-run-`)) : null;
    const systemPromptFile = promptDir ? join(promptDir, 'system-prompt.md') : undefined;
    if (promptDir && systemPromptFile) {
      writeFileSync(systemPromptFile, req.appendSystemPrompt!, { mode: 0o644 });
      chmodSync(promptDir, 0o755);
    }
    const cleanup = () => promptDir && rmSync(promptDir, { recursive: true, force: true });
    // What the agent did, for the dashboard: written by this process into the coordinator's state dir (the dashboard can't read the agent user's home).
    const record = req.stateDir ? new RunRecorder(req.stateDir, { role: req.role, model: req.model, cwd: req.cwd, ...(req.taskFile ? { taskFile: req.taskFile } : {}), ...(req.issue !== undefined ? { issue: req.issue } : {}) }) : null;
    // The live view of the same run, under the record's id: redacted and capped, ended when the run ends.
    const feed = record && req.stateDir ? new RunFeed(req.stateDir, { run: record.id, issue: req.issue ?? runIssue(req.cwd, req.taskFile), role: req.role, model: req.model, cwd: req.cwd }) : null;
    // An "allow once" host reaches this run's commands only; the lane's own settings are never changed.
    const settings = req.allowOnce?.length && lane?.settings ? withAllowedDomains(lane.settings, req.allowOnce) : lane?.settings;
    // Requests refused for the network, from the same stream the record and the feed read.
    const refusals = new RefusalTracker([...allowedDomainsOf(lane?.settings), ...(req.allowOnce ?? [])]);
    return new Promise((resolve) => {
      const argv = cliArgs(req, settings, systemPromptFile);
      const [file, args] = runAs ? asUser(runAs.user, this.bin, argv, runEnv) : [this.bin, argv];
      // As another user, sudo gets only PATH; the agent's environment is passed explicitly through env -i.
      const child = spawn(file, args, { cwd: req.cwd, env: runAs ? { PATH: env.PATH ?? '' } : env, stdio: ['pipe', 'pipe', 'pipe'], detached: spawnDetached });
      child.stdin.on('error', () => {}); // a run that exits before reading its prompt reports that itself
      child.on('error', cleanup);
      // The prompt is the first user message; the input stays open for console messages until a turn
      // ends with nothing held, then it's closed and the session ends.
      child.stdin.write(userMessage(req.prompt));
      req.onStart?.(child.pid ?? -1);
      let result: ResultLine | null = null;
      let rateLimited = false;
      let ended: TerminalReason | null = null;
      let buf = '';
      let stderr = '';
      let inputOpen = true;
      const held: { id: string; text: string }[] = [];
      const closeInput = () => {
        if (!inputOpen) return;
        inputOpen = false;
        child.stdin.end();
      };
      const kill = (why: TerminalReason) => {
        ended ??= why;
        closeInput();
        if (runAs) killTreeAs(runAs.user, child.pid);
        else killTree(child.pid, () => child.kill('SIGKILL'));
      };
      /** A turn ended: deliver the next held message as a new turn, or end the session. */
      const turnEnded = () => {
        const next = held.shift();
        if (next && inputOpen) {
          child.stdin.write(userMessage(next.text));
          feed?.message(next.id, 'delivered');
          req.onMessage?.({ id: next.id, state: 'delivered' });
        } else closeInput();
      };
      req.onControl?.({
        runId: record?.id ?? null,
        send: (id, text) => {
          if (!inputOpen) return { queued: false, why: 'the run is finishing; its input is closed' };
          held.push({ id, text });
          feed?.message(id, 'queued', text);
          req.onMessage?.({ id, state: 'queued' });
          return { queued: true };
        },
        stop: () => kill('stopped'),
      });
      let stall = setTimeout(() => kill('stalled'), req.stallMs);
      const overall = setTimeout(() => kill('timed_out'), req.timeoutMs);
      req.signal?.addEventListener('abort', () => kill('canceled_by_reconciliation'));
      child.stdout.on('data', (d: Buffer) => {
        clearTimeout(stall);
        stall = setTimeout(() => kill('stalled'), req.stallMs);
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let j: { type?: string; subtype?: string; rate_limit_info?: { status?: string } };
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          record?.line(j);
          feed?.line(j);
          refusals.line(j);
          if (j.type === 'result') {
            result = j as ResultLine;
            turnEnded();
          }
          else if (j.type === 'rate_limit_event' && j.rate_limit_info?.status === 'rejected') rateLimited = true;
          else if (j.type === 'assistant') req.onActivity?.('assistant turn');
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      child.on('close', (code) => {
        cleanup();
        inputOpen = false;
        // Messages still held when the session ended were never delivered.
        for (const m of held.splice(0)) {
          feed?.message(m.id, 'dropped');
          req.onMessage?.({ id: m.id, state: 'dropped' });
        }
        clearTimeout(stall);
        clearTimeout(overall);
        const r = result as ResultLine | null;
        const model = Object.keys(r?.modelUsage ?? {})[0] ?? req.model;
        const base = { costUsd: r?.total_cost_usd ?? 0, turns: r?.num_turns ?? 0, model, ...(r?.session_id ? { sessionId: r.session_id } : {}) };
        const done = (o: RunResult) => {
          const out: RunResult = refusals.refused.length ? { ...o, refusedHosts: refusals.refused } : o;
          record?.finish({ reason: out.reason, costUsd: out.costUsd, turns: out.turns, model: out.model, ...(r?.result ? { final: r.result } : {}) });
          feed?.end({ reason: out.reason, costUsd: out.costUsd, turns: out.turns });
          resolve(out);
        };
        if (ended) return done({ reason: ended, detail: `killed: ${ended}`, ...base });
        if (rateLimited || r?.api_error_status === 429) return done({ reason: 'rate_limited', detail: 'usage or rate limit reached', ...base });
        if (!r) return done({ reason: 'failed', detail: `claude exited ${code} without a result: ${stderrTail(stderr)}`, ...base });
        if (r.subtype === 'error_max_budget_usd') return done({ reason: 'budget_exhausted', detail: 'per-run budget reached', ...base });
        // An error result often carries no text of its own; claude's stderr then says what went wrong.
        if (r.subtype !== 'success' || r.is_error) return done({ reason: 'failed', detail: `${r.subtype}: ${(r.result ?? '').trim().slice(0, 500) || stderrTail(stderr)}`, ...base });
        done({ reason: 'succeeded', detail: (r.result ?? '').slice(0, 500), ...(r.structured_output !== undefined ? { structured: r.structured_output } : {}), ...base });
      });
    });
  }
}

/** Scripted runner for tests and dry runs: `script` acts on the worktree and returns structured output. */
export class FakeRunner implements AgentRunner {
  readonly calls: RunRequest[] = [];
  constructor(private script: (req: RunRequest) => Promise<Partial<RunResult>> | Partial<RunResult>) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    req.onStart?.(process.pid);
    const r = await this.script(req);
    return { reason: 'succeeded', detail: '', costUsd: 0.01, turns: 1, model: req.model, ...r };
  }
}
