import { type CliAgentName } from './providers.js';
import { type AgentRunner, type CommitIdentity, type RunAs, type RunRequest, type RunResult } from './runner.js';
export interface CliOutcome {
    sessionId?: string;
    model?: string;
    text: string;
    tokens: {
        in: number;
        out: number;
    };
    turns: number;
    finished: boolean;
    failed?: string;
    lastError?: string;
}
/** WHY: each line comes back claude-shaped, so the run record, live feed and stuck guard read these runs unchanged. */
export interface CliStream {
    readonly outcome: CliOutcome;
    line(j: unknown): unknown[];
}
export declare class CodexStream implements CliStream {
    readonly outcome: CliOutcome;
    private open;
    line(j: unknown): unknown[];
    private call;
    private completed;
}
export declare class GeminiStream implements CliStream {
    readonly outcome: CliOutcome;
    private pending;
    line(j: unknown): unknown[];
    private flush;
}
/** WHY: neither CLI takes a claude-style schema; the answer's last JSON object is read back (structuredOutput). */
export declare function cliPrompt(req: Pick<RunRequest, 'prompt' | 'appendSystemPrompt' | 'jsonSchema'>): string;
export declare function structuredOutput(text: string): unknown;
/**
 * INVARIANT: the prompt is never on a command line (sudo logs them); it goes on stdin. `codex exec -` reads it from
 * there; the workspace-write sandbox is codex's own, an extra layer under the OS user, never the boundary itself.
 */
export declare function codexArgs(req: Pick<RunRequest, 'model'>): string[];
/** WHY: gemini needs -p to run headless; piped stdin is added to it, so -p carries only a pointer to the task there. */
export declare const GEMINI_POINTER = "Do the task given on standard input.";
/** INVARIANT: the prompt is never on a command line; yolo because no one is there to approve a tool call. */
export declare function geminiArgs(req: Pick<RunRequest, 'model'>): string[];
/** Why another vendor's CLI may not take this run (or null). INVARIANT: checked by the runner itself, whatever routed it. */
export declare function cliRunRefusal(agent: CliAgentName, req: RunRequest): string | null;
export declare const cliCost: (tokens: {
    in: number;
    out: number;
}, p: {
    in: number;
    out: number;
}) => number;
export interface CliAgentOptions {
    /** INVARIANT: the agent user a lane's runs go as; a lane without one gets no run (the OS user is the only boundary). */
    runAs: (lane: string) => RunAs | undefined;
    identity?: CommitIdentity;
    base?: NodeJS.ProcessEnv;
    bin?: string;
    /** WHY: tests run the stand-in CLI as themselves; an instance always goes through sudo as the agent user. */
    exec?: {
        wrap: (user: string, file: string, args: string[], env: NodeJS.ProcessEnv) => [file: string, args: string[], env: NodeJS.ProcessEnv];
        kill: (user: string, pid: number | undefined) => void;
    };
    now?: () => number;
}
/** INVARIANT: through sudo as the agent user, its environment passed explicitly (env -i); sudo itself gets only PATH. */
export declare function cliAgentCommand(user: string, file: string, args: string[], env: NodeJS.ProcessEnv): [file: string, args: string[], env: NodeJS.ProcessEnv];
export declare class CliAgentRunner implements AgentRunner {
    readonly agent: CliAgentName;
    private o;
    constructor(agent: CliAgentName, o: CliAgentOptions);
    private args;
    private stream;
    run(req: RunRequest): Promise<RunResult>;
    private runOnce;
}
/** INVARIANT: a cli-routed run never falls through to claude here (the coordinator already chose its fallback). */
export declare function withCliAgents(claude: AgentRunner, agents: Partial<Record<CliAgentName, AgentRunner>>): AgentRunner;
