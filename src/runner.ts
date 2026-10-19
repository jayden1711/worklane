// Agent runners. The default runs the locally installed `claude` headless
// with the user's own auth; an option runs it with an API key. Either way
// the agent's environment is built from an allowlist: no GitHub token, no
// git credential helper, no SSH agent, so an agent can't push or write to
// GitHub even if it tries. It proposes; the coordinator acts.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { agentSettingsFileOf, NO_ATTRIBUTION, projectSettingsRefusal, runSettings, SETTINGS_CHECK_KEY, settingsAppliedProblem, settingsCheckValue, type Settings } from './agent-settings.js';
import { BRAND } from './brand.js';
import type { CliAgentName } from './providers.js';
import { logRefusalOnce, providerHostRefusal } from './provider-hosts.js';
import { safeProjectEnv } from './project-env.js';
import { withoutPushGateHatch } from './guardrails/push-hook.js';
import { outboundEnv } from './network.js';
import { asUser, killTree, killTreeAs, spawnDetached } from './os/index.js';
import { RunRecorder, runIssue } from './run-record.js';
import { RunFeed } from './run-feed.js';
import { StuckDetector, stuckAction, type StuckMode, type StuckVerdict } from './stuck.js';
import { RefusalTracker, type RefusedRequest } from './domain-requests.js';
import { allowedDomainsOf, withAllowedDomains, withDeniedReads } from './sandbox.js';
import { loadedSetProblem, type InitLoaded, type PluginRun } from './plugins/run.js';
import { mcpRunArgs, type McpRun } from './mcp/client.js';
import { limitHit, USAGE_LIMIT_TEXT, type LimitHit, type RateLimitInfo } from './usage-limit.js';
import { authFailedDetail, isAuthFailure } from './claude-auth-failure.js';
import { EFFORTS, type Effort } from './roles.js';

export type TerminalReason = 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'rate_limited' | 'canceled_by_reconciliation' | 'budget_exhausted' | 'auth_mismatch' | 'auth_failed' | 'stopped' | 'stuck';

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
  /**
   * claude --effort, one of EFFORTS (src/roles.ts); unset: no flag, so the CLI's default. Set from agents.yaml for the
   * worker, evaluator (verdict and repro) and planner runs (#579), and by the dashboard chat from its own list
   * (src/chat-pick.ts CHAT_EFFORTS); cliArgs puts nothing else on the command line.
   */
  effort?: Effort;
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
  /**
   * Every line of the session's stream (reasoning, text, tool calls and results), as it arrives: for a reader on the
   * coordinator's side (the experiment monitor), never sent back to the session.
   */
  onStreamLine?: (line: unknown) => void;
  /** Once the session is up: the handle for messaging and stopping it (the console). Called again on a retried start. */
  onControl?: (c: RunControl) => void;
  /** A console message's progress: queued (held until the current turn ends), delivered, or dropped (the run ended first). */
  onMessage?: (m: { id: string; state: 'queued' | 'delivered' | 'dropped' }) => void;
  /** Once the run holds its Claude login's lock: how long it waited for it (another run on the same login), in ms. */
  onLockWait?: (ms: number) => void;
  /** Before each wait on a transient error: which try failed, why (classified), and how long until the next. */
  onTransientRetry?: (r: TransientRetry) => void;
  signal?: AbortSignal;
  /**
   * An open-model provider this run goes to (src/providers.ts), resolved by the coordinator: claude talks to its
   * Anthropic-compatible endpoint, with the key from its file through apiKeyHelper (never an environment variable),
   * and `model` is the provider's own model id. Absent: Anthropic, as always. Kind `cli`: another vendor's coding
   * CLI (src/cli-agents.ts) runs it instead of claude, its budget enforced from its token counts at these prices.
   */
  provider?: { name: string; kind: 'local' | 'hosted'; baseUrl: string; keyFile: string } | { name: string; kind: 'cli'; agent: CliAgentName; usdPerMtok: { in: number; out: number } };
  /**
   * What kind of work this is, for a model that names a provider (`local`, `hosted:<name>`): the coordinator
   * resolves it to the provider, or to `fallback` (the role's normal model) when the provider may not or can't run
   * it. A provider model without a route is never sent anywhere but the fallback.
   */
  route?: {
    kind: 'build' | 'planner' | 'research' | 'intake_triage' | 'intake_replier' | 'intake_summary' | 'intake_thread' | 'stage_judge' | 'eval_answer' | 'evaluator' | 'cross_eval' | 'other';
    highRisk?: boolean;
    fallback: string;
    /** Never run on the fallback: when the provider may not or can't run it (or hits its limit), the run is not run (reason failed, no turns). */
    noFallback?: boolean;
  };
  /**
   * A person is waiting on this run (a chat-channel reply, a question in a decision's thread): it takes its Claude
   * login's start lock only (the auth check and claude's start, when a token refresh happens), never the login's
   * run lock, so it doesn't wait behind an agent run. Same lane, sandbox, tools and caps as any run.
   */
  interactive?: boolean;
  /** The lane this run belongs to (an issue's lane:<name> label); default when unset. */
  lane?: string;
  /** The project's own variables (tests.yaml env); never one the harness sets. */
  env?: Record<string, string>;
  /** The issue this run works on, for its run record; read from the worktree or task file name when unset. */
  issue?: number;
  /** Every stream-json line of the session, as it arrives (the same stream the run record and the live feed read). */
  onLine?: (line: unknown) => void;
  /**
   * The stuck-run guard (stuck.ts): each verdict goes to onVerdict with what was done about it. Only mode 'on'
   * stops a run (reason 'stuck'); dry-run only reports. The run record keeps the longest streak either way.
   */
  stuck?: { mode: StuckMode; onVerdict?: (v: StuckVerdict, action: 'log' | 'stop') => void };
  /**
   * An earlier session to continue (`claude --resume <id>`), with its context: the one that wrote the change a fix
   * run works on. Sessions live in the Claude login's home (the agent user's), so the run must go to the same lane.
   * A session that is gone ends the run failed at turn 0 ("No conversation found"); the caller falls back to a fresh run.
   */
  resume?: string;
}

/** What a session id looks like (claude's are UUIDs): anything else is never put on the command line. */
export const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;

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
  /** Tokens in and out, and the run's wall time, from claude's result (for usage per model, local models included). */
  tokens?: { in: number; out: number };
  durationMs?: number;
  /** The provider the run went to, when it wasn't Anthropic. */
  provider?: string;
  /** Hosts the run was refused (outside its allowlist), each once: for the owner to decide on. */
  refusedHosts?: RefusedRequest[];
  /** Why the stuck-run guard stopped it (reason 'stuck'). */
  stuck?: StuckVerdict;
  /** Reason rate_limited: when the limit resets, as claude said (or the default when it didn't). */
  limit?: LimitHit;
  /**
   * Reason auth_failed: the login the API refused, by its key (its config dir, as loginOf) and its account as claude
   * auth status names it (null when it names none). Never a token.
   */
  login?: { key: string; account: string | null };
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
  /** The Claude login a run would use (its config dir): runs on one login share its sign-in, and its refusal. */
  loginOf?(req: Pick<RunRequest, 'lane' | 'provider'>): string;
}

// CLAUDE_CONFIG_DIR: an instance's own Claude login (a path, not a secret). No CA bundle: a custom CA comes only from
// root's network.json (src/network.ts outboundEnv, applied below).
const PASS_THROUGH = ['CLAUDE_CONFIG_DIR', 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'XDG_RUNTIME_DIR', 'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData', 'ProgramFiles'];

/** An agent_runtime kind (config.yaml agent_runtime.kind; `sdk` is read as api_key). */
export type RuntimeKind = 'cli' | 'api_key';

/** The `claude auth status` methods each kind runs on; the preflight below and the wizard's Claude step read this one table (#738). */
export const RUNTIME_LOGINS: Readonly<Record<RuntimeKind, readonly string[]>> = {
  cli: ['claude.ai', 'oauth_token'],
  api_key: ['api_key', 'api_key_helper'],
};

/** The login a `claude auth status` answer names: 'none' unless `loggedIn` is exactly true, 'unknown' with no method. */
export function loginMethod(j: { loggedIn?: unknown; authMethod?: unknown }): string {
  if (j.loggedIn !== true) return 'none';
  return typeof j.authMethod === 'string' && j.authMethod ? j.authMethod : 'unknown';
}

/** What of `base` reaches claude in an agent run (the pass-through list; for api_key, local runs, the key); the Claude step uses it too. */
export function agentAuthEnv(base: NodeJS.ProcessEnv, runtime: 'cli' | 'api_key'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASS_THROUGH) if (base[k] !== undefined) env[k] = base[k];
  // Local runs only: an instance never has the key in its environment (it reaches claude through apiKeyHelper).
  if (runtime === 'api_key' && base.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
  return env;
}

/**
 * The agent's whole environment. Anything not listed is dropped, which
 * removes GitHub tokens, cloud keys, database URLs and the SSH agent.
 */
export function agentEnv(base: NodeJS.ProcessEnv, runtime: 'cli' | 'api_key', extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = agentAuthEnv(base, runtime);
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
  // INVARIANT: no redirecting variable, whatever `base` or `extra` holds; a proxy only from root's network.json
  // (src/network.ts). A provider run's endpoint is set by the runner after this, from agents.yaml's provider.
  outboundEnv(env);
  // INVARIANT: no agent starts with the push gate's first-time-setup hatch, whatever `base` or `extra` holds.
  return withoutPushGateHatch(env);
}

/**
 * claude's apiKeyHelper for an API-key file: a command claude runs (as the user it runs as) to read the key. The
 * path is refused unless it is absolute and plain (no quote, space or shell character), so it can't become a command.
 */
export function apiKeyHelperCommand(file: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(file)) throw new Error(`API key file path ${JSON.stringify(file)} must be absolute, with letters, digits and . _ - / only`);
  return `cat -- ${file}`;
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
  /** PATH for project commands run as this user (instance.yaml run_as.path; default: defaultAgentPath()). */
  path?: string;
}

/**
 * The agent user's own identity and places: its home, its name, its Claude login and its XDG dirs under its home.
 * The one source for every process run as the agent user that reads its login (agent runs, and every `claude auth
 * status` probe), so a probe can't look in the coordinator's home while runs look in the agent's.
 */
export function agentUserEnv(r: RunAs): Record<string, string> {
  const j = posix.join; // agent users exist on POSIX systems only
  return {
    HOME: r.home,
    USER: r.user,
    LOGNAME: r.user,
    CLAUDE_CONFIG_DIR: r.claudeConfigDir ?? j(r.home, '.claude'),
    XDG_CONFIG_HOME: j(r.home, '.config'),
    XDG_DATA_HOME: j(r.home, '.local', 'share'),
    XDG_CACHE_HOME: j(r.home, '.cache'),
    XDG_STATE_HOME: j(r.home, '.local', 'state'),
  };
}

/** The agent's environment when it runs as its own user: its home, its login, git trusting worktrees it doesn't own. */
export function runAsEnv(env: NodeJS.ProcessEnv, r: RunAs): NodeJS.ProcessEnv {
  // INVARIANT: as agentEnv: an agent user never gets the push gate's hatch from the environment it is built on, nor a
  // redirecting variable; a proxy only from root's network.json (src/network.ts).
  return withoutPushGateHatch(
    outboundEnv({
      ...env,
      ...agentUserEnv(r),
      // Worktrees belong to the coordinator user; git refuses repos owned by someone else unless trusted.
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: '*',
    }),
  );
}

/**
 * How to run `claude auth status --json`: as the agent user (through sudo, with that user's environment from
 * agentUserEnv, as its runs get it), else as this process. The command, its arguments and spawn's own env.
 */
export function authStatusCommand(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude'): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const argv = ['auth', 'status', '--json'];
  if (!runAs) return { file: bin, args: argv, env };
  const [file, args] = asUser(runAs.user, bin, argv, { ...env, ...agentUserEnv(runAs) });
  // As another user, sudo gets only PATH; the probe's environment is passed explicitly through env -i.
  return { file, args, env: { PATH: env.PATH ?? '' } };
}

/** Which auth `claude` would use. The cli runtime refuses API-key billing it wasn't asked for. */
export function claudeAuthMethod(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude'): string {
  return claudeAuthStatus(env, runAs, bin).method;
}

/**
 * claude auth status: the auth method ('none' when signed out, 'unknown' when unreadable) and what it printed
 * otherwise, and the account as it names it (its email, else its org; never the token).
 */
export function claudeAuthStatus(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude'): { method: string; text: string; account?: string | null } {
  const c = authStatusCommand(env, runAs, bin);
  const r = spawnSync(c.file, c.args, { encoding: 'utf8', env: c.env, timeout: 30_000 });
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; email?: unknown; orgName?: unknown };
    const account = typeof j.email === 'string' && j.email ? j.email : typeof j.orgName === 'string' && j.orgName ? j.orgName : null;
    return { method: loginMethod(j), text: '', account: account?.slice(0, 200) ?? null };
  } catch {
    return { method: 'unknown', text: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().slice(-500) };
  }
}

/**
 * claude auth status --json as the agent user, read for the watchdog: whether it is signed in, and the login's expiry
 * when the CLI reports one. Never the token (the command doesn't print it). Null when it couldn't be read.
 */
export function claudeAuthStatusJson(env: NodeJS.ProcessEnv, runAs?: RunAs, bin = 'claude'): { loggedIn: boolean; expiresAt?: unknown } | null {
  const c = authStatusCommand(env, runAs, bin);
  const r = spawnSync(c.file, c.args, { encoding: 'utf8', env: c.env, timeout: 30_000 });
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: unknown; expiresAt?: unknown };
    return typeof j.loggedIn === 'boolean' ? { loggedIn: j.loggedIn, ...(j.expiresAt !== undefined ? { expiresAt: j.expiresAt } : {}) } : null;
  } catch {
    return null;
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
 * Two locks per Claude login (CLAUDE_CONFIG_DIR). Why: three runs started 0.1 s apart on one login all failed on
 * "another Claude Code process is refreshing it": two claude processes refreshing one OAuth login at once, and the
 * loser fails. claude refreshes a due token before its first request, so:
 * - the start lock (loginStartLock) covers the auth check and claude's start until its first answer (or its end,
 *   or LOGIN_START_HOLD_MS): no two claude processes on one login are ever starting, and refreshing, at once.
 *   Every run takes it.
 * - the run lock (withLoginLock) keeps agent runs one at a time per login for their whole run, as before. An
 *   interactive run (a person waiting: chat, thread questions) doesn't take it, so it never waits behind one.
 */
const loginLocks = new Map<string, Promise<unknown>>();
const startLocks = new Map<string, Promise<unknown>>();

/** Wait for `key` in `locks`; resolves to its release (idempotent). Waiters go in arrival order. */
async function acquireIn(locks: Map<string, Promise<unknown>>, key: string): Promise<() => void> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev.catch(() => {});
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
    if (locks.get(key) === tail) locks.delete(key);
  };
}

export async function withLoginLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireIn(loginLocks, key);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Take a login's start lock; the caller releases it once claude has started (or ended). */
export const loginStartLock = (key: string): Promise<() => void> => acquireIn(startLocks, key);

/** The longest one start holds its login's start lock: a claude with no first answer by then isn't refreshing. */
export const LOGIN_START_HOLD_MS = 60_000;

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

/** Settings every instance run carries (Claude Code settings reference: each one only takes something away). */
export const PLUGIN_LOCKS = { disableSkillShellExecution: true, disableClaudeAiConnectors: true, allowedMcpServers: [] as unknown[] } as const;
/** The --effort values cliArgs passes (a mistyped one from anywhere is dropped, never put on the command line). */
const EFFORT_FLAGS = new Set<string>(EFFORTS);

/**
 * The claude command line. The prompt is not on it: command lines are public
 * on the machine and sudo logs them to the journal, so the prompt goes on
 * stdin and the role's system prompt in a file (`systemPromptFile`).
 */
export function cliArgs(req: RunRequest, settings?: object, systemPromptFile?: string, pluginDirs: readonly string[] = [], mcpConfigFile?: string): string[] {
  const args = [...(settings ? ['--settings', JSON.stringify(settings)] : []), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', req.model, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--max-turns', String(req.maxTurns), '--max-budget-usd', String(req.maxBudgetUsd)];
  // WHY: not on a provider run: whether an open model's endpoint takes the effort parameter is unknown (#579).
  if (req.effort && EFFORT_FLAGS.has(req.effort) && !req.provider) args.push('--effort', req.effort);
  if (req.allowedTools.length) args.push('--allowedTools', ...req.allowedTools);
  if (req.disallowedTools?.length) args.push('--disallowedTools', ...req.disallowedTools);
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
  // One flag per approved plugin directory (root's store), never a folder of them: exactly what was checked.
  for (const d of pluginDirs) args.push('--plugin-dir', d);
  // The broker's connector, once per approved server (--strict-mcp-config stays: nothing else is read).
  if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  // claude --help: "-r, --resume [value]  Resume a conversation by session ID". runOnce refuses an id that isn't one.
  if (req.resume && SESSION_ID.test(req.resume)) args.push('--resume', req.resume);
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
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  duration_ms?: number;
}

export class CliRunner implements AgentRunner {
  constructor(
    private runtime: 'cli' | 'api_key' = 'cli',
    private base: NodeJS.ProcessEnv = process.env,
    private bin = 'claude',
    private runAs?: RunAs,
    /**
     * Per lane: the user and sandbox settings. When set, a run in an unknown lane is refused. A lane with `ownHooks`
     * brings its own hooks (research without repo access) and doesn't get the guardrails below.
     */
    private lanes?: Record<string, { runAs?: RunAs; settings?: object; ownHooks?: boolean }>,
    /** Agents' commits carry this identity, never one they pick. */
    private identity: CommitIdentity = DEFAULT_COMMIT_IDENTITY,
    private retry: RetryOptions = {},
    /**
     * An instance's guardrail hooks and rules, read for every run and passed with --settings (agent-settings.ts).
     * Throws when there are none: the run doesn't start.
     */
    private guardrails?: () => Settings,
    /**
     * runtime api_key, for an instance: the agent user's API key file (0400, the agent user's own). It reaches claude
     * through apiKeyHelper in --settings, which claude runs as the agent user; the key is never in an environment.
     */
    private apiKeyFile?: string,
    /**
     * The Claude login a run as this user uses, read when each run starts (src/claude-profiles.ts: the instance's
     * active account profile), and every login's credentials file that user has, which no agent command may read.
     * Unset: the user's own claudeConfigDir, as always.
     */
    private login?: { resolve: (r: RunAs) => RunAs; credentialFiles: (r: RunAs) => string[] },
    /**
     * An instance's approved plugins for a run of this role (src/plugins/run.ts): root's allowlist, checked against
     * root's store before every run. Throws when the allowlist or a copy can't be trusted: the run doesn't start.
     * Set for every instance run: it also pins the plugin root and the MCP and skill-shell locks below.
     */
    private plugins?: (o: { role: string }) => PluginRun,
    /**
     * The instance's MCP broker (src/mcp/client.ts): a ticket for each run of a role with approved servers, ended when
     * the run ends. Null from register: no broker, so no servers. A refusal or failure: the run doesn't start.
     */
    private mcp?: { instance: string; register: (role: string, ttlMs: number) => Promise<McpRun | null>; end: (ticket: string) => Promise<void> },
  ) {}

  /** The lane's user, on the login its runs use now. */
  private userOf(lane: string): RunAs | undefined {
    const l = this.lanes?.[lane];
    const r = l ? l.runAs : this.runAs;
    return r && this.login ? this.login.resolve(r) : r;
  }

  /** The Claude login a run uses: the lane's agent user's config dir, else the runner's own. */
  loginOf(req: Pick<RunRequest, 'lane' | 'provider'>): string {
    if (req.provider) return `provider:${req.provider.name}`;
    const runAs = this.userOf(req.lane ?? 'default');
    if (runAs) return runAs.claudeConfigDir ?? posix.join(runAs.home, '.claude');
    return this.base.CLAUDE_CONFIG_DIR ?? join(this.base.HOME ?? this.base.USERPROFILE ?? '', '.claude');
  }

  /**
   * One run: agent runs serialized per Claude login, every run's start too (see loginStartLock). A failure at startup on an auth or transient error is not
   * the task's: it is retried after a wait (1 min, 2 min, then 5 min) for up to TRANSIENT_BUDGET_MS,
   * and only then reported, marked transient.
   */
  async run(req: RunRequest): Promise<RunResult> {
    const now = this.retry.now ?? Date.now;
    const sleep = this.retry.sleep ?? sleepFor;
    const budget = this.retry.budgetMs ?? TRANSIENT_BUDGET_MS;
    const first = now();
    for (let tries = 1; ; tries++) {
      // INVARIANT (#392): a provider run's endpoint is a host root allows (src/provider-hosts.ts). Root's file is read
      // again before each try, so a host root took out since the coordinator resolved the run (or a run handed a
      // provider some other way) can't slip past.
      // Refused: not started, never retried. Not a fallback here: that would skip the coordinator's model cap and
      // usage pause, which it applied when it resolved the run.
      const hostRefused = req.provider && req.provider.kind !== 'cli' ? providerHostRefusal(req.provider.baseUrl) : null;
      if (req.provider && hostRefused) {
        logRefusalOnce(req.provider.name, hostRefused);
        return { reason: 'failed', detail: `${req.provider.name}: ${hostRefused}; not starting`, costUsd: 0, turns: 0, model: req.model };
      }
      const started = now();
      const key = this.loginOf(req);
      // Every run: the login's start lock, around the auth check and claude's start. Agent runs: its run lock too.
      const once = async () => {
        const release = await loginStartLock(key);
        req.onLockWait?.(Math.max(0, now() - started));
        try {
          return await this.runOnce(req, release);
        } finally {
          release();
        }
      };
      const r = req.interactive ? await once() : await withLoginLock(key, once);
      // A usage or rate limit claude itself gave up on resets in hours, not minutes: never retried here (the
      // coordinator pauses until its reset instead), so one run that hits it is one try.
      if (r.reason === 'rate_limited') return r;
      const atStartup = now() - started < STARTUP_WINDOW_MS || r.turns <= 1;
      const transient = atStartup && (r.reason === 'failed' || r.reason === 'auth_mismatch') && TRANSIENT_ERROR.test(r.detail);
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

  /** One try. `started` releases the login's start lock: once claude has answered (its token is fresh), or ended. */
  private async runOnce(req: RunRequest, started: () => void): Promise<RunResult> {
    if (req.provider?.kind === 'cli') return { reason: 'failed', detail: `${req.provider.name} runs on its own CLI, not claude; not starting`, costUsd: 0, turns: 0, model: req.model };
    // With a key file, apiKeyHelper is the key's only way in: none from this process's environment.
    const base = req.provider ? { ...this.base, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined } : this.apiKeyFile ? { ...this.base, ANTHROPIC_API_KEY: undefined } : this.base;
    // A provider run's config dir is empty (no stored login, nothing of the agent's own settings), unless it runs as
    // another user, whose own dir it keeps; either way the key comes only from apiKeyHelper below.
    const providerDir = req.provider && !this.runAs && !this.lanes?.[req.lane ?? 'default']?.runAs ? mkdtempSync(join(tmpdir(), `${BRAND.cli}-provider-`)) : null;
    // A provider run's endpoint (agents.yaml providers.*.base_url, its host root's to allow, checked in run()): set after agentEnv and
    // runAsEnv, which strip every redirecting variable, so it is the only endpoint a provider run gets.
    const endpoint: Record<string, string> = req.provider ? { ANTHROPIC_BASE_URL: req.provider.baseUrl } : {};
    const agentVars = agentEnv(base, req.provider ? 'cli' : this.runtime, {
      ...(providerDir ? { CLAUDE_CONFIG_DIR: providerDir } : {}),
      ...safeProjectEnv(req.env),
      ...identityEnv(this.identity),
      [`${BRAND.envPrefix}_ROLE`]: req.role,
      ...(req.taskFile ? { [`${BRAND.envPrefix}_TASK_FILE`]: req.taskFile } : {}),
      ...(req.stateDir ? { [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: req.stateDir } : {}),
      ...(req.allowOnce?.length ? { [`${BRAND.envPrefix}_ALLOW_HOSTS`]: req.allowOnce.join(',') } : {}),
    });
    const env: NodeJS.ProcessEnv = { ...agentVars, ...endpoint };
    const laneName = req.lane ?? 'default';
    const lane = this.lanes?.[laneName];
    if (this.lanes && !lane) return { reason: 'failed', detail: `unknown lane "${laneName}"; not starting`, costUsd: 0, turns: 0, model: req.model };
    if (req.resume !== undefined && !SESSION_ID.test(req.resume)) return { reason: 'failed', detail: `not a session id: ${JSON.stringify(req.resume.slice(0, 80))}; not starting`, costUsd: 0, turns: 0, model: req.model };
    const runAs = this.userOf(laneName);
    // Approved plugins: for the instance's own agent user only (never an eval lane's user, Q14), and checked now.
    const asAgentUser = !runAs || !this.runAs || runAs.user === this.runAs.user;
    let plugins: PluginRun | null = null;
    if (this.plugins) {
      try {
        plugins = asAgentUser && !req.provider ? this.plugins({ role: req.role }) : { dirs: [], ids: [], pluginRoot: null };
      } catch (e) {
        return { reason: 'failed', detail: `${(e as Error).message}; not starting`, costUsd: 0, turns: 0, model: req.model };
      }
    }
    // Approved MCP servers for this run's role, through the broker: never for an eval lane's user or a provider run.
    let mcpRun: McpRun | null = null;
    if (this.mcp && asAgentUser && !req.provider) {
      try {
        mcpRun = await this.mcp.register(req.role, req.timeoutMs + 600_000);
      } catch (e) {
        return { reason: 'failed', detail: `${(e as Error).message}; not starting`, costUsd: 0, turns: 0, model: req.model };
      }
    }
    const mcpArgs = mcpRun && mcpRun.servers.length ? mcpRunArgs(this.mcp!.instance, mcpRun, process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))) : null;
    // The plugins root moved to root's empty directory: the agent user's own installs never load, and it can't install.
    const pluginEnv: Record<string, string> = plugins?.pluginRoot ? { CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins.pluginRoot } : {};
    const runEnv = runAs ? { ...runAsEnv(env, runAs), ...endpoint, ...pluginEnv } : { ...env, ...pluginEnv };
    // The instance's guardrails, or no run: never an agent run without its hooks, or with a project file that
    // could loosen them.
    let guard: Settings | null = null;
    if (this.guardrails && !lane?.ownHooks) {
      try {
        guard = this.guardrails();
      } catch (e) {
        return { reason: 'failed', detail: `${(e as Error).message}; not starting`, costUsd: 0, turns: 0, model: req.model };
      }
      const refusal = projectSettingsRefusal(req.cwd, guard);
      if (refusal) return { reason: 'failed', detail: `${refusal}; not starting`, costUsd: 0, turns: 0, model: req.model };
    }
    // Preflight, inside the login's start lock: an unreadable status that mentions a token refresh (or any other
    // transient error) is reported with its text, and run() waits it out instead of starting claude.
    const status = req.provider ? { method: 'provider', text: '' } : claudeAuthStatus(runEnv, runAs, this.bin);
    const auth = status.method;
    const want: readonly string[] = req.provider ? ['provider'] : RUNTIME_LOGINS[this.runtime];
    if (!want.includes(auth)) {
      return { reason: 'auth_mismatch', detail: `runtime ${this.runtime} expects ${want.join(' or ')} auth, claude reports ${auth}${status.text ? `: ${status.text}` : ''}; not starting (no silent billing switch)`, costUsd: 0, turns: 0, model: req.model };
    }
    // The role's system prompt, in a file the agent user can read (this process's /tmp, private to the
    // instance's service and its agents), removed when the run ends.
    const promptDir = req.appendSystemPrompt ? mkdtempSync(join(tmpdir(), `${BRAND.cli}-run-`)) : null;
    // The run's MCP config, in a file the agent user can read (a path on argv, never its content): the connector once
    // per approved server, each with this run's ticket.
    const mcpDir = mcpArgs ? mkdtempSync(join(tmpdir(), `${BRAND.cli}-mcp-`)) : null;
    const mcpConfigFile = mcpDir ? join(mcpDir, 'mcp.json') : undefined;
    if (mcpDir && mcpConfigFile && mcpArgs) {
      writeFileSync(mcpConfigFile, JSON.stringify(mcpArgs.config));
      chmodSync(mcpConfigFile, 0o644);
      chmodSync(mcpDir, 0o755);
    }
    const systemPromptFile = promptDir ? join(promptDir, 'system-prompt.md') : undefined;
    if (promptDir && systemPromptFile) {
      writeFileSync(systemPromptFile, req.appendSystemPrompt!);
      // Set explicitly: a create mode is cut by the umask, and the services' UMask=0007 would leave 0640, unreadable to the agent user.
      chmodSync(systemPromptFile, 0o644);
      chmodSync(promptDir, 0o755);
    }
    const cleanup = () => {
      if (promptDir) rmSync(promptDir, { recursive: true, force: true });
      if (providerDir) rmSync(providerDir, { recursive: true, force: true });
      if (mcpDir) rmSync(mcpDir, { recursive: true, force: true });
      if (mcpRun) void this.mcp?.end(mcpRun.ticket);
    };
    // What the agent did, for the dashboard: written by this process into the coordinator's state dir (the dashboard can't read the agent user's home).
    const record = req.stateDir ? new RunRecorder(req.stateDir, { role: req.role, model: req.model, cwd: req.cwd, ...(req.taskFile ? { taskFile: req.taskFile } : {}), ...(req.issue !== undefined ? { issue: req.issue } : {}), ...(req.resume ? { resumed: req.resume } : {}) }) : null;
    // The live view of the same run, under the record's id: redacted and capped, ended when the run ends.
    const feed = record && req.stateDir ? new RunFeed(req.stateDir, { run: record.id, issue: req.issue ?? runIssue(req.cwd, req.taskFile), role: req.role, model: req.model, cwd: req.cwd }) : null;
    // An "allow once" host reaches this run's commands only; the lane's own settings are never changed.
    const allowed = req.allowOnce?.length && lane?.settings ? withAllowedDomains(lane.settings, req.allowOnce) : lane?.settings;
    // Every account profile's login file for this user, whichever it runs on: denied to its commands like its own.
    const laneSettings = allowed && runAs && this.login ? withDeniedReads(allowed, this.login.credentialFiles(runAs)) : allowed;
    // The run's harness variables are pinned in --settings too: a project file's env would otherwise override them.
    const pinned = guard ? runSettings(guard, laneSettings, Object.fromEntries(Object.entries(env).filter((kv): kv is [string, string] => kv[0].startsWith(`${BRAND.envPrefix}_`) && kv[1] !== undefined))) : laneSettings;
    // An API-key instance: the key comes from its file through claude's apiKeyHelper (only a path is passed here),
    // for runs as the instance's agent user only; a lane running as another user (the eval user) never gets it.
    const asAgent = !runAs || !this.runAs || runAs.user === this.runAs.user;
    const keyed = req.provider
      ? { ...(pinned ?? {}), apiKeyHelper: apiKeyHelperCommand(req.provider.keyFile) }
      : this.runtime === 'api_key' && this.apiKeyFile && asAgent
        ? { ...(pinned ?? {}), apiKeyHelper: apiKeyHelperCommand(this.apiKeyFile) }
        : pinned;
    // An instance's runs: no skill or command runs inline shell while rendering; no claude.ai connector; and no MCP
    // server from anywhere (plugins, settings, --mcp-config) but the ones the run is given, of which there are none yet.
    const locked = this.plugins ? { ...(keyed ?? {}), ...PLUGIN_LOCKS, ...(mcpArgs ? { allowedMcpServers: mcpArgs.allowedMcpServers } : {}) } : keyed;
    // Attribution off in every --settings a run gets, with or without instance guardrails (#576); a run passed none gets none.
    // INVARIANT (#626): every --settings carries a fresh check value, and the run stops unless claude's init event
    // reports it before any line but a system one, and never succeeds without it: claude drops a whole --settings
    // over one invalid value, silently. The check key is spread last, so nothing above (NO_ATTRIBUTION included) can
    // replace it.
    const check = locked ? settingsCheckValue() : null;
    const settings = locked && check ? { ...locked, ...NO_ATTRIBUTION, [SETTINGS_CHECK_KEY]: check } : undefined;
    const agentFile = guard ? agentSettingsFileOf(guard) : undefined;
    const settingsName = guard ? `the instance's agent settings${agentFile ? ` ${agentFile}` : ''}${laneSettings ? ", with the lane's" : ''}` : laneSettings ? "the lane's settings" : "the run's own settings";
    // Requests refused for the network, from the same stream the record and the feed read.
    const refusals = new RefusalTracker([...allowedDomainsOf(lane?.settings), ...(req.allowOnce ?? [])]);
    // The stuck-run guard reads the same stream; a stop verdict ends the run only in mode 'on'.
    const stuck = req.stuck && req.stuck.mode !== 'off' ? { mode: req.stuck.mode, detector: new StuckDetector(), stopped: null as StuckVerdict | null } : null;
    return new Promise((resolve) => {
      const argv = cliArgs(mcpArgs ? { ...req, allowedTools: [...req.allowedTools, ...mcpArgs.allowedTools] } : req, settings, systemPromptFile, plugins?.dirs ?? [], mcpConfigFile);
      const [file, args] = runAs ? asUser(runAs.user, this.bin, argv, runEnv) : [this.bin, argv];
      // As another user, sudo gets only PATH; the agent's environment is passed explicitly through env -i.
      const child = spawn(file, args, { cwd: req.cwd, env: runAs ? { PATH: env.PATH ?? '' } : runEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: spawnDetached });
      child.stdin.on('error', () => {}); // a run that exits before reading its prompt reports that itself
      child.on('error', cleanup);
      // The prompt is the first user message; the input stays open for console messages until a turn
      // ends with nothing held, then it's closed and the session ends.
      child.stdin.write(userMessage(req.prompt));
      req.onStart?.(child.pid ?? -1);
      let result: ResultLine | null = null;
      let rateLimited: RateLimitInfo | null = null;
      let assistantError: string | null = null;
      let ended: TerminalReason | null = null;
      /** Set when the session's init event shows something loaded that this run didn't pass. */
      let loadProblem: string | null = null;
      /** The run's --settings: confirmed by the init event, or why the run stopped. Pending until then. */
      let settingsState: 'pending' | 'applied' | { problem: string } = check ? 'pending' : 'applied';
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
      // The start lock is held until claude's first answer, LOGIN_START_HOLD_MS at most.
      const startHold = setTimeout(started, LOGIN_START_HOLD_MS);
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
          let j: { type?: string; subtype?: string; rate_limit_info?: RateLimitInfo };
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          // Before anything else reads the line: settings not confirmed by the first init event, or any line but a
          // system one before it (a turn, a tool result, a result), stop the run, and the line goes nowhere.
          if (settingsState === 'pending' && check) {
            const problem =
              j.type === 'system' && j.subtype === 'init'
                ? settingsAppliedProblem(j as { output_style?: unknown }, check, settingsName)
                : j.type !== 'system'
                  ? `claude sent ${j.type === 'assistant' || j.type === 'user' || j.type === 'result' ? `a ${j.type} line` : 'a line'} before its init event confirmed the --settings this run passed (${settingsName}), so its deny rules and hooks may be off`
                  : undefined;
            if (problem) {
              settingsState = { problem };
              kill('failed');
            } else if (problem === null) settingsState = 'applied';
          }
          if (typeof settingsState === 'object') continue;
          record?.line(j);
          feed?.line(j);
          req.onStreamLine?.(j);
          refusals.line(j);
          if (stuck) {
            for (const v of stuck.detector.line(j)) {
              const action = stuckAction(stuck.mode, v);
              if (!action) continue;
              try {
                req.stuck?.onVerdict?.(v, action);
              } catch {
                // reporting a verdict never affects the run
              }
              if (action === 'stop' && !stuck.stopped) {
                stuck.stopped = v;
                kill('stuck');
              }
            }
          }
          req.onLine?.(j);
          if (plugins && j.type === 'system' && j.subtype === 'init' && !loadProblem) {
            loadProblem = loadedSetProblem(j as InitLoaded, { pluginDirs: plugins.dirs, mcpServers: mcpArgs?.names ?? [] });
            if (loadProblem) kill('failed');
          }
          if (j.type === 'assistant' || j.type === 'result') started();
          // claude marks the API's refusal of its login on the assistant message it reports it in.
          if (j.type === 'assistant' && (j as { error?: unknown }).error === 'authentication_failed') assistantError = 'authentication_failed';
          if (j.type === 'result') {
            result = j as ResultLine;
            turnEnded();
          }
          else if (j.type === 'rate_limit_event' && j.rate_limit_info?.status === 'rejected') rateLimited = j.rate_limit_info;
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
        clearTimeout(startHold);
        started();
        const r = result as ResultLine | null;
        const model = Object.keys(r?.modelUsage ?? {})[0] ?? req.model;
        const u = r?.usage;
        const tokens = u ? { in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0 } : undefined;
        const base = { costUsd: r?.total_cost_usd ?? 0, turns: r?.num_turns ?? 0, model, ...(r?.session_id ? { sessionId: r.session_id } : {}), ...(tokens ? { tokens } : {}), ...(r?.duration_ms !== undefined ? { durationMs: r.duration_ms } : {}), ...(req.provider ? { provider: req.provider.name } : {}) };
        const done = (o: RunResult) => {
          const out: RunResult = { ...o, ...(refusals.refused.length ? { refusedHosts: refusals.refused } : {}), ...(o.reason === 'stuck' && stuck?.stopped ? { stuck: stuck.stopped } : {}) };
          record?.finish({ reason: out.reason, costUsd: out.costUsd, turns: out.turns, model: out.model, ...(out.reason !== 'succeeded' && out.detail ? { detail: out.detail } : {}), ...(r?.result ? { final: r.result } : {}), ...(stuck ? { stuck: { ...stuck.detector.longest } } : {}), ...(out.sessionId ? { sessionId: out.sessionId } : {}) });
          feed?.end({ reason: out.reason, costUsd: out.costUsd, turns: out.turns });
          resolve(out);
        };
        if (ended === 'stuck' && stuck?.stopped) {
          const v = stuck.stopped;
          return done({ reason: 'stuck', detail: `stopped as stuck: the same ${v.tool} call failed ${v.failures} times in a row: ${v.input.slice(0, 200)}`, ...base });
        }
        if (typeof settingsState === 'object') return done({ reason: 'failed', detail: `${settingsState.problem}; stopped`, ...base });
        if (loadProblem) return done({ reason: 'failed', detail: `${loadProblem}; stopped`, ...base });
        if (ended) return done({ reason: ended, detail: `killed: ${ended}`, ...base });
        // The subscription's usage limit (or a provider's rate limit): claude's rate_limit_event, a 429 it gave up on,
        // or its own words for the limit in an error result. Its text is kept: it may name the reset time.
        const said = `${r?.is_error || r?.subtype !== 'success' ? (r?.result ?? '') : ''}\n${stderrTail(stderr)}`;
        if (rateLimited || r?.api_error_status === 429 || ((!r || r.is_error || r.subtype !== 'success') && USAGE_LIMIT_TEXT.test(said))) {
          const text = (r?.is_error ? (r.result ?? '') : '').trim().slice(0, 300);
          return done({ reason: 'rate_limited', detail: `usage or rate limit reached${text ? `: ${text}` : ''}`, limit: limitHit({ info: rateLimited, text: said, now: (this.retry.now ?? Date.now)() }), ...base });
        }
        // The API refused the login (401/403, an invalid or expired key or token): its own reason, never an ordinary
        // failure, with Claude's words (redacted) and the login it refused (src/claude-auth-failure.ts).
        const refusedText = `${r?.is_error || r?.subtype !== 'success' ? (r?.result ?? '').trim() : ''}\n${stderr ? stderrTail(stderr) : ''}`.trim();
        if ((!r || r.is_error || r.subtype !== 'success') && isAuthFailure({ apiErrorStatus: r?.api_error_status ?? null, assistantError, text: refusedText })) {
          return done({ reason: 'auth_failed', detail: authFailedDetail({ apiErrorStatus: r?.api_error_status ?? null, text: refusedText }), login: { key: this.loginOf(req), account: status.account ?? null }, ...base });
        }
        // INVARIANT (#626): never a success with the --settings unconfirmed. Only its stderr is kept (a startup error
        // there may be transient): nothing it sent before an init event was read.
        if (settingsState === 'pending') return done({ reason: 'failed', detail: `claude exited ${code} before its init event confirmed the --settings this run passed (${settingsName}): ${stderrTail(stderr)}`, ...base });
        if (!r) return done({ reason: 'failed', detail: `claude exited ${code} without a result: ${stderrTail(stderr)}`, ...base });
        if (r.subtype === 'error_max_budget_usd') return done({ reason: 'budget_exhausted', detail: 'per-run budget reached', ...base });
        // An error result often carries no text of its own; claude's stderr then says what went wrong.
        if (r.subtype !== 'success' || r.is_error) return done({ reason: 'failed', detail: `${r.subtype}: ${(r.result ?? '').trim().slice(0, 500) || stderrTail(stderr)}`, ...base });
        done({ reason: 'succeeded', detail: (r.result ?? '').slice(0, 500), ...(r.structured_output !== undefined ? { structured: r.structured_output } : {}), ...base });
      });
    });
  }
}

/** What a scripted run returns; `reads` are the files its session opened, kept in its run record. */
export type FakeResult = Partial<RunResult> & { reads?: string[]; /** Stream lines the session "emits" (onStreamLine). */ stream?: unknown[] };

/**
 * Scripted runner for tests and dry runs: `script` acts on the worktree and returns structured output. A run
 * that read files gets a run record (with a state dir), as a real session would: the files in `reads`, or,
 * when the script doesn't say, the `files_reviewed` it reports (an honest reviewer reads what it says).
 */
export class FakeRunner implements AgentRunner {
  readonly calls: RunRequest[] = [];
  constructor(private script: (req: RunRequest) => Promise<FakeResult> | FakeResult) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    req.onStart?.(process.pid);
    const { reads, stream, ...r } = await this.script(req);
    for (const l of stream ?? []) req.onStreamLine?.(l);
    const reviewed = (r.structured as { files_reviewed?: unknown } | undefined)?.files_reviewed;
    const read = reads ?? (Array.isArray(reviewed) ? reviewed.map(String) : null);
    const out: RunResult = { reason: 'succeeded', detail: '', costUsd: 0.01, turns: 1, model: req.model, ...r };
    if (read && req.stateDir) {
      const rec = new RunRecorder(req.stateDir, { role: req.role, model: req.model, cwd: req.cwd, ...(req.taskFile ? { taskFile: req.taskFile } : {}), ...(req.issue !== undefined ? { issue: req.issue } : {}) });
      read.forEach((p, i) => {
        rec.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `r${i}`, name: 'Read', input: { file_path: join(req.cwd, p) } }] } });
        rec.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: '' }] } });
      });
      rec.finish({ reason: out.reason, costUsd: out.costUsd, turns: out.turns, model: out.model });
      req.onControl?.({ runId: rec.id, send: () => ({ queued: false, why: 'a scripted run takes no messages' }), stop: () => {} });
    }
    return out;
  }
}
