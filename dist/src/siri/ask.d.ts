import type { StoredEvent } from '../events/types.js';
/** A spoken question's most characters. */
export declare const ASK_MAX = 500;
/** The role a Siri answer's run and cost are recorded under. */
export declare const SIRI_ROLE = "siri";
/** Every tool: a Siri answer reads nothing and does nothing; what it knows is in its prompt. */
export declare const SIRI_DENIED: readonly ["Read", "Glob", "Grep", "LS", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead", "Task", "TodoWrite", "WebSearch", "WebFetch", "mcp__*"];
export declare const SIRI_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["answer"];
    readonly properties: {
        readonly answer: {
            readonly type: "string";
        };
    };
};
/** The state a Siri answer may use: a viewer's view of the instance, as plain text. */
export declare function viewerState(events: StoredEvent[], instance: string): string;
/** The run that answers: no tools, the research lane (no repo), an empty working directory, one string out. */
export declare function siriAskRun(o: {
    bundleDir: string;
    model: string;
    state: string;
    question: string;
    maxBudgetUsd: number;
}): {
    role: string;
    lane: string;
    cwd: string;
    model: string;
    allowedTools: string[];
    disallowedTools: ("Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "Bash" | "Read" | "Grep" | "Glob" | "NotebookRead" | "WebFetch" | "WebSearch" | "Task" | "mcp__*" | "LS" | "TodoWrite")[];
    appendSystemPrompt: string;
    prompt: string;
    jsonSchema: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["answer"];
        readonly properties: {
            readonly answer: {
                readonly type: "string";
            };
        };
    };
    maxTurns: number;
    maxBudgetUsd: number;
    interactive: boolean;
    stallMs: number;
    timeoutMs: number;
};
export declare class SiriAskError extends Error {
}
export declare const isAskId: (id: string) => boolean;
export interface SiriRequest {
    v: 1;
    id: string;
    at: string;
    /** The device token's id that asked: only it may read the answer. */
    device: string;
    question: string;
}
export type SiriAnswer = {
    v: 1;
    id: string;
    at: string;
    device: string;
} & ({
    state: 'pending';
} | {
    state: 'answered';
    speech: string;
} | {
    state: 'refused';
    speech: string;
});
/** Leave a question for the coordinator; the answer starts pending. */
export declare function askSiri(o: {
    stateDir: string;
    device: string;
    question: string;
    now?: Date;
}): {
    id: string;
};
export declare function siriAnswer(stateDir: string, id: string): SiriAnswer | null;
/** The coordinator's side: questions waiting, oldest first, each removed as it is taken. */
export declare function takeSiriRequests(stateDir: string): SiriRequest[];
/** The coordinator's side: the spoken answer (cut to speech here, whatever the run said), or a spoken refusal. */
export declare function writeSiriAnswer(stateDir: string, q: Pick<SiriRequest, 'id' | 'device'>, a: {
    answer: string;
} | {
    refused: string;
}, now?: Date): void;
/** Answers older than a day are removed (nobody polls them after a minute). */
export declare function pruneSiriAnswers(stateDir: string, now?: number): void;
