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
/**
 * The agent's whole environment. Anything not listed is dropped, which
 * removes GitHub tokens, cloud keys, database URLs and the SSH agent.
 */
export declare function agentEnv(base: NodeJS.ProcessEnv, runtime: 'cli' | 'sdk', extra?: Record<string, string>): NodeJS.ProcessEnv;
/** Which auth `claude` would use. The cli runtime refuses API-key billing it wasn't asked for. */
export declare function claudeAuthMethod(env: NodeJS.ProcessEnv): string;
export declare function cliArgs(req: RunRequest): string[];
export declare class CliRunner implements AgentRunner {
    private runtime;
    private base;
    private bin;
    constructor(runtime?: 'cli' | 'sdk', base?: NodeJS.ProcessEnv, bin?: string);
    run(req: RunRequest): Promise<RunResult>;
}
/** Scripted runner for tests and dry runs: `script` acts on the worktree and returns structured output. */
export declare class FakeRunner implements AgentRunner {
    private script;
    readonly calls: RunRequest[];
    constructor(script: (req: RunRequest) => Promise<Partial<RunResult>> | Partial<RunResult>);
    run(req: RunRequest): Promise<RunResult>;
}
