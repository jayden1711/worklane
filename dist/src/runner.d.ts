import { type Settings } from './agent-settings.js';
import type { CliAgentName } from './providers.js';
import { type StuckMode, type StuckVerdict } from './stuck.js';
import { type RefusedRequest } from './domain-requests.js';
import { type LimitHit } from './usage-limit.js';
export type TerminalReason = 'succeeded' | 'failed' | 'timed_out' | 'stalled' | 'rate_limited' | 'canceled_by_reconciliation' | 'budget_exhausted' | 'auth_mismatch' | 'stopped' | 'stuck';
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
    onMessage?: (m: {
        id: string;
        state: 'queued' | 'delivered' | 'dropped';
    }) => void;
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
    provider?: {
        name: string;
        kind: 'local' | 'hosted';
        baseUrl: string;
        keyFile: string;
    } | {
        name: string;
        kind: 'cli';
        agent: CliAgentName;
        usdPerMtok: {
            in: number;
            out: number;
        };
    };
    /**
     * What kind of work this is, for a model that names a provider (`local`, `hosted:<name>`): the coordinator
     * resolves it to the provider, or to `fallback` (the role's normal model) when the provider may not or can't run
     * it. A provider model without a route is never sent anywhere but the fallback.
     */
    route?: {
        kind: 'build' | 'planner' | 'research' | 'intake_triage' | 'intake_replier' | 'intake_summary' | 'intake_thread' | 'stage_judge' | 'eval_answer' | 'evaluator' | 'other';
        highRisk?: boolean;
        fallback: string;
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
    stuck?: {
        mode: StuckMode;
        onVerdict?: (v: StuckVerdict, action: 'log' | 'stop') => void;
    };
    /**
     * An earlier session to continue (`claude --resume <id>`), with its context: the one that wrote the change a fix
     * run works on. Sessions live in the Claude login's home (the agent user's), so the run must go to the same lane.
     * A session that is gone ends the run failed at turn 0 ("No conversation found"); the caller falls back to a fresh run.
     */
    resume?: string;
}
/** What a session id looks like (claude's are UUIDs): anything else is never put on the command line. */
export declare const SESSION_ID: RegExp;
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
    tokens?: {
        in: number;
        out: number;
    };
    durationMs?: number;
    /** The provider the run went to, when it wasn't Anthropic. */
    provider?: string;
    /** Hosts the run was refused (outside its allowlist), each once: for the owner to decide on. */
    refusedHosts?: RefusedRequest[];
    /** Why the stuck-run guard stopped it (reason 'stuck'). */
    stuck?: StuckVerdict;
    /** Reason rate_limited: when the limit resets, as claude said (or the default when it didn't). */
    limit?: LimitHit;
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
    send(id: string, text: string): {
        queued: true;
    } | {
        queued: false;
        why: string;
    };
    /** End the run now (its process tree), as a stop. */
    stop(): void;
}
/** One user message on stream-json input. */
export declare const userMessage: (text: string) => string;
export interface AgentRunner {
    run(req: RunRequest): Promise<RunResult>;
}
/**
 * The agent's whole environment. Anything not listed is dropped, which
 * removes GitHub tokens, cloud keys, database URLs and the SSH agent.
 */
export declare function agentEnv(base: NodeJS.ProcessEnv, runtime: 'cli' | 'api_key', extra?: Record<string, string>): NodeJS.ProcessEnv;
/**
 * claude's apiKeyHelper for an API-key file: a command claude runs (as the user it runs as) to read the key. The
 * path is refused unless it is absolute and plain (no quote, space or shell character), so it can't become a command.
 */
export declare function apiKeyHelperCommand(file: string): string;
/** The one identity every commit an agent or the coordinator makes carries. */
export interface CommitIdentity {
    name: string;
    email: string;
}
/** Without an instance (a plain repo), and in tests. */
export declare const DEFAULT_COMMIT_IDENTITY: CommitIdentity;
/** Git reads these before any config, so an agent's commits carry the harness identity whatever its git config says. */
export declare function identityEnv(id: CommitIdentity): Record<string, string>;
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
export declare function agentUserEnv(r: RunAs): Record<string, string>;
/** The agent's environment when it runs as its own user: its home, its login, git trusting worktrees it doesn't own. */
export declare function runAsEnv(env: NodeJS.ProcessEnv, r: RunAs): NodeJS.ProcessEnv;
/**
 * How to run `claude auth status --json`: as the agent user (through sudo, with that user's environment from
 * agentUserEnv, as its runs get it), else as this process. The command, its arguments and spawn's own env.
 */
export declare function authStatusCommand(env: NodeJS.ProcessEnv, runAs?: RunAs, bin?: string): {
    file: string;
    args: string[];
    env: NodeJS.ProcessEnv;
};
/** Which auth `claude` would use. The cli runtime refuses API-key billing it wasn't asked for. */
export declare function claudeAuthMethod(env: NodeJS.ProcessEnv, runAs?: RunAs, bin?: string): string;
/** claude auth status: the auth method ('none' when signed out, 'unknown' when unreadable) and what it printed otherwise. */
export declare function claudeAuthStatus(env: NodeJS.ProcessEnv, runAs?: RunAs, bin?: string): {
    method: string;
    text: string;
};
/**
 * claude auth status --json as the agent user, read for the watchdog: whether it is signed in, and the login's expiry
 * when the CLI reports one. Never the token (the command doesn't print it). Null when it couldn't be read.
 */
export declare function claudeAuthStatusJson(env: NodeJS.ProcessEnv, runAs?: RunAs, bin?: string): {
    loggedIn: boolean;
    expiresAt?: unknown;
} | null;
/**
 * Errors that say nothing about the task: the Claude login's token refresh, rate limits, overload,
 * server errors and the network. Another attempt at the same moment fails the same way; waiting helps.
 */
export declare const TRANSIENT_ERROR: RegExp;
export type TransientCause = 'token_refresh' | 'rate_limit' | 'overloaded' | 'server_error' | 'network' | 'other';
export interface TransientRetry {
    /** The try that failed (1 = the first). */
    attempt: number;
    cause: TransientCause;
    waitMs: number;
    detail: string;
}
/** What a transient failure was about, for the record (the retry itself treats them all alike). */
export declare function classifyTransient(reason: string, detail: string): TransientCause;
/** Waits between tries after a transient error: 1 min, 2 min, then every 5 min. */
export declare const TRANSIENT_BACKOFF_MS: number[];
/** How long transient errors are retried before the run is reported as failed on them. */
export declare const TRANSIENT_BUDGET_MS: number;
export declare function withLoginLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
/** Take a login's start lock; the caller releases it once claude has started (or ended). */
export declare const loginStartLock: (key: string) => Promise<() => void>;
/** The longest one start holds its login's start lock: a claude with no first answer by then isn't refreshing. */
export declare const LOGIN_START_HOLD_MS = 60000;
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
export declare function cliArgs(req: RunRequest, settings?: object, systemPromptFile?: string): string[];
/** The end of claude's stderr, for a failure report: its last few non-empty lines. */
export declare function stderrTail(stderr: string, lines?: number): string;
export declare class CliRunner implements AgentRunner {
    private runtime;
    private base;
    private bin;
    private runAs?;
    /**
     * Per lane: the user and sandbox settings. When set, a run in an unknown lane is refused. A lane with `ownHooks`
     * brings its own hooks (research without repo access) and doesn't get the guardrails below.
     */
    private lanes?;
    /** Agents' commits carry this identity, never one they pick. */
    private identity;
    private retry;
    /**
     * An instance's guardrail hooks and rules, read for every run and passed with --settings (agent-settings.ts).
     * Throws when there are none: the run doesn't start.
     */
    private guardrails?;
    /**
     * runtime api_key, for an instance: the agent user's API key file (0400, the agent user's own). It reaches claude
     * through apiKeyHelper in --settings, which claude runs as the agent user; the key is never in an environment.
     */
    private apiKeyFile?;
    constructor(runtime?: 'cli' | 'api_key', base?: NodeJS.ProcessEnv, bin?: string, runAs?: RunAs | undefined, 
    /**
     * Per lane: the user and sandbox settings. When set, a run in an unknown lane is refused. A lane with `ownHooks`
     * brings its own hooks (research without repo access) and doesn't get the guardrails below.
     */
    lanes?: Record<string, {
        runAs?: RunAs;
        settings?: object;
        ownHooks?: boolean;
    }> | undefined, 
    /** Agents' commits carry this identity, never one they pick. */
    identity?: CommitIdentity, retry?: RetryOptions, 
    /**
     * An instance's guardrail hooks and rules, read for every run and passed with --settings (agent-settings.ts).
     * Throws when there are none: the run doesn't start.
     */
    guardrails?: (() => Settings) | undefined, 
    /**
     * runtime api_key, for an instance: the agent user's API key file (0400, the agent user's own). It reaches claude
     * through apiKeyHelper in --settings, which claude runs as the agent user; the key is never in an environment.
     */
    apiKeyFile?: string | undefined);
    /** The Claude login a run uses: the lane's agent user's config dir, else the runner's own. */
    private loginOf;
    /**
     * One run: agent runs serialized per Claude login, every run's start too (see loginStartLock). A failure at startup on an auth or transient error is not
     * the task's: it is retried after a wait (1 min, 2 min, then 5 min) for up to TRANSIENT_BUDGET_MS,
     * and only then reported, marked transient.
     */
    run(req: RunRequest): Promise<RunResult>;
    /** One try. `started` releases the login's start lock: once claude has answered (its token is fresh), or ended. */
    private runOnce;
}
/** What a scripted run returns; `reads` are the files its session opened, kept in its run record. */
export type FakeResult = Partial<RunResult> & {
    reads?: string[];
};
/**
 * Scripted runner for tests and dry runs: `script` acts on the worktree and returns structured output. A run
 * that read files gets a run record (with a state dir), as a real session would: the files in `reads`, or,
 * when the script doesn't say, the `files_reviewed` it reports (an honest reviewer reads what it says).
 */
export declare class FakeRunner implements AgentRunner {
    private script;
    readonly calls: RunRequest[];
    constructor(script: (req: RunRequest) => Promise<FakeResult> | FakeResult);
    run(req: RunRequest): Promise<RunResult>;
}
