import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EventLog } from '../events/log.js';
import type { MachineRequest } from '../machine-requests.js';
export declare const ADD_PROJECT_STEPS: readonly ["instance", "app", "claude-token", "checkout", "policy", "service", "test-user", "machine-helper", "dashboards"];
export type AddProjectStep = (typeof ADD_PROJECT_STEPS)[number];
declare const STATES: readonly ["started", "done", "failed", "ask", "waiting"];
/** The paste_secret ask's credential name: the file the dashboard writes it to, in secretsDir(<new instance>). */
export declare const CLAUDE_TOKEN_CREDENTIAL = "claude-token";
/** How long the Claude token ask stays open before the step gives up (the script then fails, naming the retry). */
export declare const SECRET_WAIT_MS: number;
export type SpawnHelper = (file: string, args: string[]) => ChildProcessWithoutNullStreams;
export interface AddProjectDeps {
    log: EventLog;
    /** This coordinator's instance (it took the request). */
    instance: string;
    /** How the helper starts: sudo -n <helper> add-project <name> <repo> by default. */
    spawn?: SpawnHelper;
    /** This user's home, where the dashboard stored a pasted secret; the process's own by default. */
    home?: string;
    pollMs?: number;
    now?: () => number;
}
/** add-project requests this process is running, by request id: their claims are live, never "interrupted". */
export declare const runningAddProjects: Map<string, Promise<void>>;
interface StepAsk {
    kind?: unknown;
    title?: unknown;
    detail?: unknown;
    url?: unknown;
}
interface Line {
    step: AddProjectStep;
    state: (typeof STATES)[number];
    detail: string;
    ask?: StepAsk;
    retry?: string;
}
/** A progress line, or null when it isn't one (anything else the script wrote to stdout is ignored). */
export declare function parseStepLine(text: string): Line | null;
/**
 * Run one claimed add-project request to its end, relaying its steps. Resolves once machine.finished is recorded.
 * The caller has checked it (the requester, the allowlist) and claimed it.
 */
export declare function runAddProject(d: AddProjectDeps, r: MachineRequest): Promise<void>;
export {};
