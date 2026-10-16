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
import { projectSettingsRefusal, runSettings } from './agent-settings.js';
import { BRAND } from './brand.js';
import { safeProjectEnv } from './project-env.js';
import { withoutPushGateHatch } from './guardrails/push-hook.js';
import { outboundEnv } from './network.js';
import { asUser, killTree, killTreeAs, spawnDetached } from './os/index.js';
import { RunRecorder, runIssue } from './run-record.js';
import { RunFeed } from './run-feed.js';
import { StuckDetector, stuckAction } from './stuck.js';
import { RefusalTracker } from './domain-requests.js';
import { allowedDomainsOf, withAllowedDomains, withDeniedReads } from './sandbox.js';
import { loadedSetProblem } from './plugins/run.js';
import { mcpRunArgs } from './mcp/client.js';
import { limitHit, USAGE_LIMIT_TEXT } from './usage-limit.js';
import { authFailedDetail, isAuthFailure } from './claude-auth-failure.js';
/** What a session id looks like (claude's are UUIDs): anything else is never put on the command line. */
export const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
/** One user message on stream-json input. */
export const userMessage = (text) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
// CLAUDE_CONFIG_DIR: an instance's own Claude login (a path, not a secret). No CA bundle: a custom CA comes only from
// root's network.json (src/network.ts outboundEnv, applied below).
const PASS_THROUGH = ['CLAUDE_CONFIG_DIR', 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'XDG_RUNTIME_DIR', 'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ProgramData', 'ProgramFiles'];
/**
 * The agent's whole environment. Anything not listed is dropped, which
 * removes GitHub tokens, cloud keys, database URLs and the SSH agent.
 */
export function agentEnv(base, runtime, extra = {}) {
    const env = {};
    for (const k of PASS_THROUGH)
        if (base[k] !== undefined)
            env[k] = base[k];
    // Local runs only: an instance never has the key in its environment (it reaches claude through apiKeyHelper).
    if (runtime === 'api_key' && base.ANTHROPIC_API_KEY)
        env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
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
export function apiKeyHelperCommand(file) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(file))
        throw new Error(`API key file path ${JSON.stringify(file)} must be absolute, with letters, digits and . _ - / only`);
    return `cat -- ${file}`;
}
/** Without an instance (a plain repo), and in tests. */
export const DEFAULT_COMMIT_IDENTITY = { name: BRAND.cli, email: `${BRAND.cli}@localhost` };
/** Git reads these before any config, so an agent's commits carry the harness identity whatever its git config says. */
export function identityEnv(id) {
    return { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
}
/**
 * The agent user's own identity and places: its home, its name, its Claude login and its XDG dirs under its home.
 * The one source for every process run as the agent user that reads its login (agent runs, and every `claude auth
 * status` probe), so a probe can't look in the coordinator's home while runs look in the agent's.
 */
export function agentUserEnv(r) {
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
export function runAsEnv(env, r) {
    // INVARIANT: as agentEnv: an agent user never gets the push gate's hatch from the environment it is built on, nor a
    // redirecting variable; a proxy only from root's network.json (src/network.ts).
    return withoutPushGateHatch(outboundEnv({
        ...env,
        ...agentUserEnv(r),
        // Worktrees belong to the coordinator user; git refuses repos owned by someone else unless trusted.
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_1: 'safe.directory',
        GIT_CONFIG_VALUE_1: '*',
    }));
}
/**
 * How to run `claude auth status --json`: as the agent user (through sudo, with that user's environment from
 * agentUserEnv, as its runs get it), else as this process. The command, its arguments and spawn's own env.
 */
export function authStatusCommand(env, runAs, bin = 'claude') {
    const argv = ['auth', 'status', '--json'];
    if (!runAs)
        return { file: bin, args: argv, env };
    const [file, args] = asUser(runAs.user, bin, argv, { ...env, ...agentUserEnv(runAs) });
    // As another user, sudo gets only PATH; the probe's environment is passed explicitly through env -i.
    return { file, args, env: { PATH: env.PATH ?? '' } };
}
/** Which auth `claude` would use. The cli runtime refuses API-key billing it wasn't asked for. */
export function claudeAuthMethod(env, runAs, bin = 'claude') {
    return claudeAuthStatus(env, runAs, bin).method;
}
/**
 * claude auth status: the auth method ('none' when signed out, 'unknown' when unreadable) and what it printed
 * otherwise, and the account as it names it (its email, else its org; never the token).
 */
export function claudeAuthStatus(env, runAs, bin = 'claude') {
    const c = authStatusCommand(env, runAs, bin);
    const r = spawnSync(c.file, c.args, { encoding: 'utf8', env: c.env, timeout: 30_000 });
    try {
        const j = JSON.parse(r.stdout);
        const account = typeof j.email === 'string' && j.email ? j.email : typeof j.orgName === 'string' && j.orgName ? j.orgName : null;
        return { method: j.loggedIn ? (j.authMethod ?? 'unknown') : 'none', text: '', account: account?.slice(0, 200) ?? null };
    }
    catch {
        return { method: 'unknown', text: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().slice(-500) };
    }
}
/**
 * claude auth status --json as the agent user, read for the watchdog: whether it is signed in, and the login's expiry
 * when the CLI reports one. Never the token (the command doesn't print it). Null when it couldn't be read.
 */
export function claudeAuthStatusJson(env, runAs, bin = 'claude') {
    const c = authStatusCommand(env, runAs, bin);
    const r = spawnSync(c.file, c.args, { encoding: 'utf8', env: c.env, timeout: 30_000 });
    try {
        const j = JSON.parse(r.stdout);
        return typeof j.loggedIn === 'boolean' ? { loggedIn: j.loggedIn, ...(j.expiresAt !== undefined ? { expiresAt: j.expiresAt } : {}) } : null;
    }
    catch {
        return null;
    }
}
/**
 * Errors that say nothing about the task: the Claude login's token refresh, rate limits, overload,
 * server errors and the network. Another attempt at the same moment fails the same way; waiting helps.
 */
export const TRANSIENT_ERROR = /failed to refresh oauth token|another claude code process is refreshing|exited mid-refresh|overloaded|\b529\b|rate.?limit|\b429\b|api error:? *5\d\d|\b50[234]\b|econnreset|etimedout|enotfound|eai_again|econnrefused|socket hang up|fetch failed|network error/i;
/** What a transient failure was about, for the record (the retry itself treats them all alike). */
export function classifyTransient(reason, detail) {
    if (/failed to refresh oauth token|another claude code process is refreshing|exited mid-refresh/i.test(detail))
        return 'token_refresh';
    if (reason === 'rate_limited' || /rate.?limit|\b429\b/i.test(detail))
        return 'rate_limit';
    if (/overloaded|\b529\b/i.test(detail))
        return 'overloaded';
    if (/api error:? *5\d\d|\b50[234]\b/i.test(detail))
        return 'server_error';
    if (/econnreset|etimedout|enotfound|eai_again|econnrefused|socket hang up|fetch failed|network error/i.test(detail))
        return 'network';
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
const loginLocks = new Map();
const startLocks = new Map();
/** Wait for `key` in `locks`; resolves to its release (idempotent). Waiters go in arrival order. */
async function acquireIn(locks, key) {
    const prev = locks.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    const tail = prev.then(() => mine);
    locks.set(key, tail);
    await prev.catch(() => { });
    let done = false;
    return () => {
        if (done)
            return;
        done = true;
        release();
        if (locks.get(key) === tail)
            locks.delete(key);
    };
}
export async function withLoginLock(key, fn) {
    const release = await acquireIn(loginLocks, key);
    try {
        return await fn();
    }
    finally {
        release();
    }
}
/** Take a login's start lock; the caller releases it once claude has started (or ended). */
export const loginStartLock = (key) => acquireIn(startLocks, key);
/** The longest one start holds its login's start lock: a claude with no first answer by then isn't refreshing. */
export const LOGIN_START_HOLD_MS = 60_000;
const sleepFor = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted)
        return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve(false);
    });
});
/** Settings every instance run carries (Claude Code settings reference: each one only takes something away). */
export const PLUGIN_LOCKS = { disableSkillShellExecution: true, disableClaudeAiConnectors: true, allowedMcpServers: [] };
/** The --effort values cliArgs passes (a mistyped one from anywhere is dropped, never put on the command line). */
const EFFORTS = new Set(['low', 'medium', 'high']);
/**
 * The claude command line. The prompt is not on it: command lines are public
 * on the machine and sudo logs them to the journal, so the prompt goes on
 * stdin and the role's system prompt in a file (`systemPromptFile`).
 */
export function cliArgs(req, settings, systemPromptFile, pluginDirs = [], mcpConfigFile) {
    const args = [...(settings ? ['--settings', JSON.stringify(settings)] : []), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', req.model, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--max-turns', String(req.maxTurns), '--max-budget-usd', String(req.maxBudgetUsd)];
    if (req.effort && EFFORTS.has(req.effort))
        args.push('--effort', req.effort);
    if (req.allowedTools.length)
        args.push('--allowedTools', ...req.allowedTools);
    if (req.disallowedTools?.length)
        args.push('--disallowedTools', ...req.disallowedTools);
    if (systemPromptFile)
        args.push('--append-system-prompt-file', systemPromptFile);
    // One flag per approved plugin directory (root's store), never a folder of them: exactly what was checked.
    for (const d of pluginDirs)
        args.push('--plugin-dir', d);
    // The broker's connector, once per approved server (--strict-mcp-config stays: nothing else is read).
    if (mcpConfigFile)
        args.push('--mcp-config', mcpConfigFile);
    if (req.jsonSchema)
        args.push('--json-schema', JSON.stringify(req.jsonSchema));
    // claude --help: "-r, --resume [value]  Resume a conversation by session ID". runOnce refuses an id that isn't one.
    if (req.resume && SESSION_ID.test(req.resume))
        args.push('--resume', req.resume);
    return args;
}
/** The end of claude's stderr, for a failure report: its last few non-empty lines. */
export function stderrTail(stderr, lines = 5) {
    return stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-lines).join('\n') || '(nothing on stderr)';
}
export class CliRunner {
    runtime;
    base;
    bin;
    runAs;
    lanes;
    identity;
    retry;
    guardrails;
    apiKeyFile;
    login;
    plugins;
    mcp;
    constructor(runtime = 'cli', base = process.env, bin = 'claude', runAs, 
    /**
     * Per lane: the user and sandbox settings. When set, a run in an unknown lane is refused. A lane with `ownHooks`
     * brings its own hooks (research without repo access) and doesn't get the guardrails below.
     */
    lanes, 
    /** Agents' commits carry this identity, never one they pick. */
    identity = DEFAULT_COMMIT_IDENTITY, retry = {}, 
    /**
     * An instance's guardrail hooks and rules, read for every run and passed with --settings (agent-settings.ts).
     * Throws when there are none: the run doesn't start.
     */
    guardrails, 
    /**
     * runtime api_key, for an instance: the agent user's API key file (0400, the agent user's own). It reaches claude
     * through apiKeyHelper in --settings, which claude runs as the agent user; the key is never in an environment.
     */
    apiKeyFile, 
    /**
     * The Claude login a run as this user uses, read when each run starts (src/claude-profiles.ts: the instance's
     * active account profile), and every login's credentials file that user has, which no agent command may read.
     * Unset: the user's own claudeConfigDir, as always.
     */
    login, 
    /**
     * An instance's approved plugins for a run of this role (src/plugins/run.ts): root's allowlist, checked against
     * root's store before every run. Throws when the allowlist or a copy can't be trusted: the run doesn't start.
     * Set for every instance run: it also pins the plugin root and the MCP and skill-shell locks below.
     */
    plugins, 
    /**
     * The instance's MCP broker (src/mcp/client.ts): a ticket for each run of a role with approved servers, ended when
     * the run ends. Null from register: no broker, so no servers. A refusal or failure: the run doesn't start.
     */
    mcp) {
        this.runtime = runtime;
        this.base = base;
        this.bin = bin;
        this.runAs = runAs;
        this.lanes = lanes;
        this.identity = identity;
        this.retry = retry;
        this.guardrails = guardrails;
        this.apiKeyFile = apiKeyFile;
        this.login = login;
        this.plugins = plugins;
        this.mcp = mcp;
    }
    /** The lane's user, on the login its runs use now. */
    userOf(lane) {
        const l = this.lanes?.[lane];
        const r = l ? l.runAs : this.runAs;
        return r && this.login ? this.login.resolve(r) : r;
    }
    /** The Claude login a run uses: the lane's agent user's config dir, else the runner's own. */
    loginOf(req) {
        if (req.provider)
            return `provider:${req.provider.name}`;
        const runAs = this.userOf(req.lane ?? 'default');
        if (runAs)
            return runAs.claudeConfigDir ?? posix.join(runAs.home, '.claude');
        return this.base.CLAUDE_CONFIG_DIR ?? join(this.base.HOME ?? this.base.USERPROFILE ?? '', '.claude');
    }
    /**
     * One run: agent runs serialized per Claude login, every run's start too (see loginStartLock). A failure at startup on an auth or transient error is not
     * the task's: it is retried after a wait (1 min, 2 min, then 5 min) for up to TRANSIENT_BUDGET_MS,
     * and only then reported, marked transient.
     */
    async run(req) {
        const now = this.retry.now ?? Date.now;
        const sleep = this.retry.sleep ?? sleepFor;
        const budget = this.retry.budgetMs ?? TRANSIENT_BUDGET_MS;
        const first = now();
        for (let tries = 1;; tries++) {
            const started = now();
            const key = this.loginOf(req);
            // Every run: the login's start lock, around the auth check and claude's start. Agent runs: its run lock too.
            const once = async () => {
                const release = await loginStartLock(key);
                req.onLockWait?.(Math.max(0, now() - started));
                try {
                    return await this.runOnce(req, release);
                }
                finally {
                    release();
                }
            };
            const r = req.interactive ? await once() : await withLoginLock(key, once);
            // A usage or rate limit claude itself gave up on resets in hours, not minutes: never retried here (the
            // coordinator pauses until its reset instead), so one run that hits it is one try.
            if (r.reason === 'rate_limited')
                return r;
            const atStartup = now() - started < STARTUP_WINDOW_MS || r.turns <= 1;
            const transient = atStartup && (r.reason === 'failed' || r.reason === 'auth_mismatch') && TRANSIENT_ERROR.test(r.detail);
            if (!transient)
                return r;
            const wait = TRANSIENT_BACKOFF_MS[Math.min(tries - 1, TRANSIENT_BACKOFF_MS.length - 1)];
            if (now() + wait - first > budget) {
                const mins = Math.max(1, Math.round((now() - first) / 60_000));
                return { ...r, reason: r.reason === 'auth_mismatch' ? 'failed' : r.reason, transient: true, detail: `${r.detail} (still failing after ${tries} tries over ${mins} min)` };
            }
            req.onTransientRetry?.({ attempt: tries, cause: classifyTransient(r.reason, r.detail), waitMs: wait, detail: r.detail.slice(0, 300) });
            req.onActivity?.(`transient error, retrying in ${Math.round(wait / 1000)}s: ${r.detail.slice(0, 200)}`);
            if (!(await sleep(wait, req.signal)))
                return { ...r, reason: 'canceled_by_reconciliation', detail: `canceled while waiting out a transient error: ${r.detail}` };
        }
    }
    /** One try. `started` releases the login's start lock: once claude has answered (its token is fresh), or ended. */
    async runOnce(req, started) {
        if (req.provider?.kind === 'cli')
            return { reason: 'failed', detail: `${req.provider.name} runs on its own CLI, not claude; not starting`, costUsd: 0, turns: 0, model: req.model };
        // With a key file, apiKeyHelper is the key's only way in: none from this process's environment.
        const base = req.provider ? { ...this.base, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined } : this.apiKeyFile ? { ...this.base, ANTHROPIC_API_KEY: undefined } : this.base;
        // A provider run's config dir is empty (no stored login, nothing of the agent's own settings), unless it runs as
        // another user, whose own dir it keeps; either way the key comes only from apiKeyHelper below.
        const providerDir = req.provider && !this.runAs && !this.lanes?.[req.lane ?? 'default']?.runAs ? mkdtempSync(join(tmpdir(), `${BRAND.cli}-provider-`)) : null;
        // A provider run's endpoint (agents.yaml providers.*.base_url, checked by the config schema): set after agentEnv and
        // runAsEnv, which strip every redirecting variable, so it is the only endpoint a provider run gets.
        const endpoint = req.provider ? { ANTHROPIC_BASE_URL: req.provider.baseUrl } : {};
        const agentVars = agentEnv(base, req.provider ? 'cli' : this.runtime, {
            ...(providerDir ? { CLAUDE_CONFIG_DIR: providerDir } : {}),
            ...safeProjectEnv(req.env),
            ...identityEnv(this.identity),
            [`${BRAND.envPrefix}_ROLE`]: req.role,
            ...(req.taskFile ? { [`${BRAND.envPrefix}_TASK_FILE`]: req.taskFile } : {}),
            ...(req.stateDir ? { [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: req.stateDir } : {}),
            ...(req.allowOnce?.length ? { [`${BRAND.envPrefix}_ALLOW_HOSTS`]: req.allowOnce.join(',') } : {}),
        });
        const env = { ...agentVars, ...endpoint };
        const laneName = req.lane ?? 'default';
        const lane = this.lanes?.[laneName];
        if (this.lanes && !lane)
            return { reason: 'failed', detail: `unknown lane "${laneName}"; not starting`, costUsd: 0, turns: 0, model: req.model };
        if (req.resume !== undefined && !SESSION_ID.test(req.resume))
            return { reason: 'failed', detail: `not a session id: ${JSON.stringify(req.resume.slice(0, 80))}; not starting`, costUsd: 0, turns: 0, model: req.model };
        const runAs = this.userOf(laneName);
        // Approved plugins: for the instance's own agent user only (never an eval lane's user, Q14), and checked now.
        const asAgentUser = !runAs || !this.runAs || runAs.user === this.runAs.user;
        let plugins = null;
        if (this.plugins) {
            try {
                plugins = asAgentUser && !req.provider ? this.plugins({ role: req.role }) : { dirs: [], ids: [], pluginRoot: null };
            }
            catch (e) {
                return { reason: 'failed', detail: `${e.message}; not starting`, costUsd: 0, turns: 0, model: req.model };
            }
        }
        // Approved MCP servers for this run's role, through the broker: never for an eval lane's user or a provider run.
        let mcpRun = null;
        if (this.mcp && asAgentUser && !req.provider) {
            try {
                mcpRun = await this.mcp.register(req.role, req.timeoutMs + 600_000);
            }
            catch (e) {
                return { reason: 'failed', detail: `${e.message}; not starting`, costUsd: 0, turns: 0, model: req.model };
            }
        }
        const mcpArgs = mcpRun && mcpRun.servers.length ? mcpRunArgs(this.mcp.instance, mcpRun, process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))) : null;
        // The plugins root moved to root's empty directory: the agent user's own installs never load, and it can't install.
        const pluginEnv = plugins?.pluginRoot ? { CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins.pluginRoot } : {};
        const runEnv = runAs ? { ...runAsEnv(env, runAs), ...endpoint, ...pluginEnv } : { ...env, ...pluginEnv };
        // The instance's guardrails, or no run: never an agent run without its hooks, or with a project file that
        // could loosen them.
        let guard = null;
        if (this.guardrails && !lane?.ownHooks) {
            try {
                guard = this.guardrails();
            }
            catch (e) {
                return { reason: 'failed', detail: `${e.message}; not starting`, costUsd: 0, turns: 0, model: req.model };
            }
            const refusal = projectSettingsRefusal(req.cwd, guard);
            if (refusal)
                return { reason: 'failed', detail: `${refusal}; not starting`, costUsd: 0, turns: 0, model: req.model };
        }
        // Preflight, inside the login's start lock: an unreadable status that mentions a token refresh (or any other
        // transient error) is reported with its text, and run() waits it out instead of starting claude.
        const status = req.provider ? { method: 'provider', text: '' } : claudeAuthStatus(runEnv, runAs, this.bin);
        const auth = status.method;
        const want = req.provider ? ['provider'] : this.runtime === 'cli' ? ['claude.ai', 'oauth_token'] : ['api_key', 'api_key_helper'];
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
            writeFileSync(systemPromptFile, req.appendSystemPrompt);
            // Set explicitly: a create mode is cut by the umask, and the services' UMask=0007 would leave 0640, unreadable to the agent user.
            chmodSync(systemPromptFile, 0o644);
            chmodSync(promptDir, 0o755);
        }
        const cleanup = () => {
            if (promptDir)
                rmSync(promptDir, { recursive: true, force: true });
            if (providerDir)
                rmSync(providerDir, { recursive: true, force: true });
            if (mcpDir)
                rmSync(mcpDir, { recursive: true, force: true });
            if (mcpRun)
                void this.mcp?.end(mcpRun.ticket);
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
        const pinned = guard ? runSettings(guard, laneSettings, Object.fromEntries(Object.entries(env).filter((kv) => kv[0].startsWith(`${BRAND.envPrefix}_`) && kv[1] !== undefined))) : laneSettings;
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
        const settings = this.plugins ? { ...(keyed ?? {}), ...PLUGIN_LOCKS, ...(mcpArgs ? { allowedMcpServers: mcpArgs.allowedMcpServers } : {}) } : keyed;
        // Requests refused for the network, from the same stream the record and the feed read.
        const refusals = new RefusalTracker([...allowedDomainsOf(lane?.settings), ...(req.allowOnce ?? [])]);
        // The stuck-run guard reads the same stream; a stop verdict ends the run only in mode 'on'.
        const stuck = req.stuck && req.stuck.mode !== 'off' ? { mode: req.stuck.mode, detector: new StuckDetector(), stopped: null } : null;
        return new Promise((resolve) => {
            const argv = cliArgs(mcpArgs ? { ...req, allowedTools: [...req.allowedTools, ...mcpArgs.allowedTools] } : req, settings, systemPromptFile, plugins?.dirs ?? [], mcpConfigFile);
            const [file, args] = runAs ? asUser(runAs.user, this.bin, argv, runEnv) : [this.bin, argv];
            // As another user, sudo gets only PATH; the agent's environment is passed explicitly through env -i.
            const child = spawn(file, args, { cwd: req.cwd, env: runAs ? { PATH: env.PATH ?? '' } : runEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: spawnDetached });
            child.stdin.on('error', () => { }); // a run that exits before reading its prompt reports that itself
            child.on('error', cleanup);
            // The prompt is the first user message; the input stays open for console messages until a turn
            // ends with nothing held, then it's closed and the session ends.
            child.stdin.write(userMessage(req.prompt));
            req.onStart?.(child.pid ?? -1);
            let result = null;
            let rateLimited = null;
            let assistantError = null;
            let ended = null;
            /** Set when the session's init event shows something loaded that this run didn't pass. */
            let loadProblem = null;
            let buf = '';
            let stderr = '';
            let inputOpen = true;
            const held = [];
            const closeInput = () => {
                if (!inputOpen)
                    return;
                inputOpen = false;
                child.stdin.end();
            };
            const kill = (why) => {
                ended ??= why;
                closeInput();
                if (runAs)
                    killTreeAs(runAs.user, child.pid);
                else
                    killTree(child.pid, () => child.kill('SIGKILL'));
            };
            /** A turn ended: deliver the next held message as a new turn, or end the session. */
            const turnEnded = () => {
                const next = held.shift();
                if (next && inputOpen) {
                    child.stdin.write(userMessage(next.text));
                    feed?.message(next.id, 'delivered');
                    req.onMessage?.({ id: next.id, state: 'delivered' });
                }
                else
                    closeInput();
            };
            req.onControl?.({
                runId: record?.id ?? null,
                send: (id, text) => {
                    if (!inputOpen)
                        return { queued: false, why: 'the run is finishing; its input is closed' };
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
            child.stdout.on('data', (d) => {
                clearTimeout(stall);
                stall = setTimeout(() => kill('stalled'), req.stallMs);
                buf += d.toString();
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    let j;
                    try {
                        j = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    record?.line(j);
                    feed?.line(j);
                    req.onStreamLine?.(j);
                    refusals.line(j);
                    if (stuck) {
                        for (const v of stuck.detector.line(j)) {
                            const action = stuckAction(stuck.mode, v);
                            if (!action)
                                continue;
                            try {
                                req.stuck?.onVerdict?.(v, action);
                            }
                            catch {
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
                        loadProblem = loadedSetProblem(j, { pluginDirs: plugins.dirs, mcpServers: mcpArgs?.names ?? [] });
                        if (loadProblem)
                            kill('failed');
                    }
                    if (j.type === 'assistant' || j.type === 'result')
                        started();
                    // claude marks the API's refusal of its login on the assistant message it reports it in.
                    if (j.type === 'assistant' && j.error === 'authentication_failed')
                        assistantError = 'authentication_failed';
                    if (j.type === 'result') {
                        result = j;
                        turnEnded();
                    }
                    else if (j.type === 'rate_limit_event' && j.rate_limit_info?.status === 'rejected')
                        rateLimited = j.rate_limit_info;
                    else if (j.type === 'assistant')
                        req.onActivity?.('assistant turn');
                }
            });
            child.stderr.on('data', (d) => {
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
                const r = result;
                const model = Object.keys(r?.modelUsage ?? {})[0] ?? req.model;
                const u = r?.usage;
                const tokens = u ? { in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0 } : undefined;
                const base = { costUsd: r?.total_cost_usd ?? 0, turns: r?.num_turns ?? 0, model, ...(r?.session_id ? { sessionId: r.session_id } : {}), ...(tokens ? { tokens } : {}), ...(r?.duration_ms !== undefined ? { durationMs: r.duration_ms } : {}), ...(req.provider ? { provider: req.provider.name } : {}) };
                const done = (o) => {
                    const out = { ...o, ...(refusals.refused.length ? { refusedHosts: refusals.refused } : {}), ...(o.reason === 'stuck' && stuck?.stopped ? { stuck: stuck.stopped } : {}) };
                    record?.finish({ reason: out.reason, costUsd: out.costUsd, turns: out.turns, model: out.model, ...(out.reason !== 'succeeded' && out.detail ? { detail: out.detail } : {}), ...(r?.result ? { final: r.result } : {}), ...(stuck ? { stuck: { ...stuck.detector.longest } } : {}), ...(out.sessionId ? { sessionId: out.sessionId } : {}) });
                    feed?.end({ reason: out.reason, costUsd: out.costUsd, turns: out.turns });
                    resolve(out);
                };
                if (ended === 'stuck' && stuck?.stopped) {
                    const v = stuck.stopped;
                    return done({ reason: 'stuck', detail: `stopped as stuck: the same ${v.tool} call failed ${v.failures} times in a row: ${v.input.slice(0, 200)}`, ...base });
                }
                if (loadProblem)
                    return done({ reason: 'failed', detail: `${loadProblem}; stopped`, ...base });
                if (ended)
                    return done({ reason: ended, detail: `killed: ${ended}`, ...base });
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
                if (!r)
                    return done({ reason: 'failed', detail: `claude exited ${code} without a result: ${stderrTail(stderr)}`, ...base });
                if (r.subtype === 'error_max_budget_usd')
                    return done({ reason: 'budget_exhausted', detail: 'per-run budget reached', ...base });
                // An error result often carries no text of its own; claude's stderr then says what went wrong.
                if (r.subtype !== 'success' || r.is_error)
                    return done({ reason: 'failed', detail: `${r.subtype}: ${(r.result ?? '').trim().slice(0, 500) || stderrTail(stderr)}`, ...base });
                done({ reason: 'succeeded', detail: (r.result ?? '').slice(0, 500), ...(r.structured_output !== undefined ? { structured: r.structured_output } : {}), ...base });
            });
        });
    }
}
/**
 * Scripted runner for tests and dry runs: `script` acts on the worktree and returns structured output. A run
 * that read files gets a run record (with a state dir), as a real session would: the files in `reads`, or,
 * when the script doesn't say, the `files_reviewed` it reports (an honest reviewer reads what it says).
 */
export class FakeRunner {
    script;
    calls = [];
    constructor(script) {
        this.script = script;
    }
    async run(req) {
        this.calls.push(req);
        req.onStart?.(process.pid);
        const { reads, stream, ...r } = await this.script(req);
        for (const l of stream ?? [])
            req.onStreamLine?.(l);
        const reviewed = r.structured?.files_reviewed;
        const read = reads ?? (Array.isArray(reviewed) ? reviewed.map(String) : null);
        const out = { reason: 'succeeded', detail: '', costUsd: 0.01, turns: 1, model: req.model, ...r };
        if (read && req.stateDir) {
            const rec = new RunRecorder(req.stateDir, { role: req.role, model: req.model, cwd: req.cwd, ...(req.taskFile ? { taskFile: req.taskFile } : {}), ...(req.issue !== undefined ? { issue: req.issue } : {}) });
            read.forEach((p, i) => {
                rec.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `r${i}`, name: 'Read', input: { file_path: join(req.cwd, p) } }] } });
                rec.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: '' }] } });
            });
            rec.finish({ reason: out.reason, costUsd: out.costUsd, turns: out.turns, model: out.model });
            req.onControl?.({ runId: rec.id, send: () => ({ queued: false, why: 'a scripted run takes no messages' }), stop: () => { } });
        }
        return out;
    }
}
//# sourceMappingURL=runner.js.map