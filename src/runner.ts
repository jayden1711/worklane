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
import { RunRecorder } from './run-record.js';

export type TerminalReason = 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'rate_limited' | 'canceled_by_reconciliation' | 'budget_exhausted' | 'auth_mismatch';

export interface RunRequest {
  role: string;
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
}

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
  const [file, args] = runAs ? asUser(runAs.user, bin, ['auth', 'status', '--json'], env) : [bin, ['auth', 'status', '--json']];
  const r = spawnSync(file, args, { encoding: 'utf8', env: runAs ? { PATH: env.PATH ?? '' } : env, timeout: 30_000 });
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
    return j.loggedIn ? (j.authMethod ?? 'unknown') : 'none';
  } catch {
    return 'unknown';
  }
}

/**
 * The claude command line. The prompt is not on it: command lines are public
 * on the machine and sudo logs them to the journal, so the prompt goes on
 * stdin and the role's system prompt in a file (`systemPromptFile`).
 */
export function cliArgs(req: RunRequest, settings?: object, systemPromptFile?: string): string[] {
  const args = [...(settings ? ['--settings', JSON.stringify(settings)] : []), '-p', '--output-format', 'stream-json', '--verbose', '--model', req.model, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--max-turns', String(req.maxTurns), '--max-budget-usd', String(req.maxBudgetUsd)];
  if (req.allowedTools.length) args.push('--allowedTools', ...req.allowedTools);
  if (req.disallowedTools?.length) args.push('--disallowedTools', ...req.disallowedTools);
  if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));
  return args;
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
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const env = agentEnv(this.base, this.runtime, {
      ...safeProjectEnv(req.env),
      ...identityEnv(this.identity),
      [`${BRAND.envPrefix}_ROLE`]: req.role,
      ...(req.taskFile ? { [`${BRAND.envPrefix}_TASK_FILE`]: req.taskFile } : {}),
      ...(req.stateDir ? { [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: req.stateDir } : {}),
    });
    const laneName = req.lane ?? 'default';
    const lane = this.lanes?.[laneName];
    if (this.lanes && !lane) return { reason: 'failed', detail: `unknown lane "${laneName}"; not starting`, costUsd: 0, turns: 0, model: req.model };
    const runAs = lane ? lane.runAs : this.runAs;
    const runEnv = runAs ? runAsEnv(env, runAs) : env;
    const auth = claudeAuthMethod(runEnv, runAs, this.bin);
    const want = this.runtime === 'cli' ? ['claude.ai', 'oauth_token'] : ['api_key', 'api_key_helper'];
    if (!want.includes(auth)) {
      return { reason: 'auth_mismatch', detail: `runtime ${this.runtime} expects ${want.join(' or ')} auth, claude reports ${auth}; not starting (no silent billing switch)`, costUsd: 0, turns: 0, model: req.model };
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
    return new Promise((resolve) => {
      const argv = cliArgs(req, lane?.settings, systemPromptFile);
      const [file, args] = runAs ? asUser(runAs.user, this.bin, argv, runEnv) : [this.bin, argv];
      // As another user, sudo gets only PATH; the agent's environment is passed explicitly through env -i.
      const child = spawn(file, args, { cwd: req.cwd, env: runAs ? { PATH: env.PATH ?? '' } : env, stdio: ['pipe', 'pipe', 'pipe'], detached: spawnDetached });
      child.stdin.on('error', () => {}); // a run that exits before reading its prompt reports that itself
      child.on('error', cleanup);
      child.stdin.end(req.prompt);
      req.onStart?.(child.pid ?? -1);
      let result: ResultLine | null = null;
      let rateLimited = false;
      let ended: TerminalReason | null = null;
      let buf = '';
      let stderr = '';
      const kill = (why: TerminalReason) => {
        ended ??= why;
        if (runAs) killTreeAs(runAs.user, child.pid);
        else killTree(child.pid, () => child.kill('SIGKILL'));
      };
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
          if (j.type === 'result') result = j as ResultLine;
          else if (j.type === 'rate_limit_event' && j.rate_limit_info?.status === 'rejected') rateLimited = true;
          else if (j.type === 'assistant') req.onActivity?.('assistant turn');
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      child.on('close', (code) => {
        cleanup();
        clearTimeout(stall);
        clearTimeout(overall);
        const r = result as ResultLine | null;
        const model = Object.keys(r?.modelUsage ?? {})[0] ?? req.model;
        const base = { costUsd: r?.total_cost_usd ?? 0, turns: r?.num_turns ?? 0, model, ...(r?.session_id ? { sessionId: r.session_id } : {}) };
        const done = (out: RunResult) => {
          record?.finish({ reason: out.reason, costUsd: out.costUsd, turns: out.turns, model: out.model, ...(r?.result ? { final: r.result } : {}) });
          resolve(out);
        };
        if (ended) return done({ reason: ended, detail: `killed: ${ended}`, ...base });
        if (rateLimited || r?.api_error_status === 429) return done({ reason: 'rate_limited', detail: 'usage or rate limit reached', ...base });
        if (!r) return done({ reason: 'failed', detail: `claude exited ${code} without a result: ${stderr.trim().split('\n').pop() ?? ''}`, ...base });
        if (r.subtype === 'error_max_budget_usd') return done({ reason: 'budget_exhausted', detail: 'per-run budget reached', ...base });
        if (r.subtype !== 'success' || r.is_error) return done({ reason: 'failed', detail: `${r.subtype}: ${(r.result ?? '').slice(0, 500)}`, ...base });
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
