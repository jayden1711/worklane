import type { EventPayload, EventType, StoredEvent } from '../events/types.js';
import type { RunResult } from '../runner.js';
import { type Used } from '../experiments/approval.js';
import { type Plan } from '../experiments/keep.js';
import type { RootState } from '../experiments/root-file.js';
import { type LogEntry, type StudyState } from '../experiments/state.js';
import { type Pin } from '../experiments/store.js';
import { StudiesFile, type Study } from '../experiments/study.js';
/** The experimenter's tools: no shell, no web, no agents, nothing that runs or waits on anything. */
export declare const EXPERIMENTER_TOOLS: readonly ["Read", "Glob", "Grep", "Edit", "Write"];
export declare const EXPERIMENTER_DENIED: readonly ["Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit"];
/** How long a job may wait for the GPU (its own minutes start once it has it). */
export declare const WAIT_MAX_S: number;
/** The most of a transcript the monitor reads (the newest part is kept). */
export declare const TRANSCRIPT_MAX = 120000;
export declare const MONITOR_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["flagged", "findings"];
    readonly properties: {
        readonly flagged: {
            readonly type: "boolean";
        };
        readonly findings: {
            readonly type: "array";
            readonly maxItems: 10;
            readonly items: {
                readonly type: "string";
                readonly maxLength: 300;
            };
        };
    };
};
/** The monitor's instructions: fixed here. The transcript follows as data. */
export declare const MONITOR_PROMPT: string;
/** What the coordinator gives the loop: its log, git, runner and the helper, nothing more. */
export interface ExperimentHost {
    instance: string;
    pinsFile: string;
    configDir: string;
    model: string;
    /** The cheaper model the monitor runs on (from routing). */
    monitorModel: string;
    events(): StoredEvent[];
    emit<T extends EventType>(type: T, payload: EventPayload<T>): void;
    now(): Date;
    held(): string | null;
    instanceUsdLeft(): number;
    mainTip(): string;
    show(commit: string, path: string): Buffer | null;
    /**
     * A session in a fresh worktree at `commit`: `hide` taken out of it before the session (and put back before `then`),
     * `frozen` and `hide` protected and `hide` unreadable through the hook. `then` gets its result and its transcript.
     */
    session<T>(o: {
        name: string;
        commit: string;
        frozen: string[];
        hide: string[];
        prompt: string;
        system: string;
        maxBudgetUsd: number;
    }, then: (r: RunResult, path: string, transcript: string) => T): Promise<T>;
    /** The tampering monitor: one tool-less run on the cheaper model, in an empty directory. */
    monitor(prompt: string, maxBudgetUsd: number): Promise<RunResult>;
    commitChange(path: string, parent: string, message: string): {
        commit: string;
        raw: string;
    };
    bundle(ref: string, commit: string): Buffer;
    helper(args: string[], stdin: Buffer | string): Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
    }>;
    root(): RootState;
    logTail(job: string, step: string): string;
    /** Tell the owner (an incident: Health and the ops channel). */
    notify(key: string, detail: string): void;
}
export declare function readStudies(host: Pick<ExperimentHost, 'show' | 'configDir'>, commit: string): StudiesFile | {
    error: string;
};
export declare function currentPin(host: Pick<ExperimentHost, 'show'>, s: Study, commit: string, root: RootState): {
    pin: Omit<Pin, 'started_by' | 'started_at'>;
} | {
    error: string;
};
export declare function usedBy(events: readonly StoredEvent[], study: string, state: StudyState, now: Date): Used;
export declare const planOf: (s: Study) => Plan;
/** The session's instructions, fixed here; the metric in words and its own past results follow as data. */
export declare function experimenterPrompt(s: Study, st: StudyState, kind: 'exploit' | 'explore' | 'combine', parent: LogEntry | null, combines: LogEntry | null): {
    system: string;
    prompt: string;
};
/** A stream line as the monitor reads it: the session's text, reasoning, tool calls and their results. */
export declare function transcriptLine(j: unknown): string;
export declare class ExperimentLoop {
    private readonly h;
    private sessionBusy;
    private jobs;
    private stopping;
    private recovered;
    private work;
    constructor(h: ExperimentHost);
    idle(): Promise<void>;
    private track;
    tick(): void;
    private judge;
    /** The next job: the baseline, a seed, or one agent session's candidate. Ends with one proposal or one refusal. */
    private begin;
    private monitor;
    /** One job through the helper: the eval copies sealed, the workspace made, the job run, its record judged. */
    private runJob;
}
