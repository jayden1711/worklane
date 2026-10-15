export declare const SUMMARY_ROLE = "intake-summary";
export declare const THREAD_ROLE = "intake-thread";
/** What a decision's or ask's thread is about, as the coordinator holds it: the only thing either role sees. */
export interface ThreadRecord {
    /** The decision's kind (plan, question, ...), or `setup` for a setup-console ask. */
    kind: string;
    issue: number | null;
    /** The issue's title, when there is an issue. */
    title?: string;
    question: string;
    options: string[];
    /** The recommended option ('' when the record gives none, as for a setup ask). */
    recommendation: string;
    /** The issue's text, redacted and cut. */
    issueText?: string;
    /** The plan's text (a held plan), or the ask's detail. */
    plan?: string;
    /** The risk the engine worked out: the review level (null: none set) and what makes it risky (a money path). */
    risk: {
        level: string | null;
        notes: string[];
    };
}
/** The record as the roles read it: redacted, each free text cut. */
export declare function recordBlock(r: ThreadRecord): string;
/** An empty working directory under the research root, as for the replier: the research lane refuses every read. */
export declare function threadRunDir(instanceRoot: string, gid: number, name: string): string;
export declare const SUMMARY_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["problem", "found", "options", "recommendation", "risk"];
    readonly properties: {
        readonly problem: {
            readonly type: "string";
        };
        readonly found: {
            readonly type: "string";
        };
        readonly options: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["name", "effect"];
                readonly properties: {
                    readonly name: {
                        readonly type: "string";
                    };
                    readonly effect: {
                        readonly type: "string";
                    };
                };
            };
        };
        readonly recommendation: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["option", "why"];
            readonly properties: {
                readonly option: {
                    readonly type: "string";
                };
                readonly why: {
                    readonly type: "string";
                };
            };
        };
        readonly risk: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["level", "why"];
            readonly properties: {
                readonly level: {
                    readonly type: "string";
                };
                readonly why: {
                    readonly type: "string";
                };
            };
        };
    };
};
export declare const THREAD_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["intent"];
    readonly properties: {
        readonly intent: {
            readonly type: "string";
            readonly enum: readonly ["question", "choice", "other"];
        };
        readonly option: {
            readonly type: "string";
        };
        readonly answer: {
            readonly type: "string";
        };
    };
};
export declare function summaryRun(o: {
    cwd: string;
    record: ThreadRecord;
}): {
    role: string;
    lane: string;
    cwd: string;
    allowedTools: string[];
    disallowedTools: ("Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Read" | "Grep" | "Bash" | "Glob" | "NotebookRead" | "WebFetch" | "WebSearch" | "Task" | "mcp__*" | "LS" | "TodoWrite")[];
    appendSystemPrompt: string;
    prompt: string;
    jsonSchema: object;
    maxTurns: number;
};
export declare function threadRun(o: {
    cwd: string;
    record: ThreadRecord;
    message: string;
}): {
    role: string;
    lane: string;
    cwd: string;
    allowedTools: string[];
    disallowedTools: ("Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Read" | "Grep" | "Bash" | "Glob" | "NotebookRead" | "WebFetch" | "WebSearch" | "Task" | "mcp__*" | "LS" | "TodoWrite")[];
    appendSystemPrompt: string;
    prompt: string;
    jsonSchema: object;
    maxTurns: number;
};
/**
 * Why a piece of model text can't be posted for this record, or null: a secret (the event log's redaction would
 * change it), a mention, a link other than `links`, an issue number or review level the record doesn't give, or a
 * claim that something is decided.
 */
export declare function textProblem(text: string, r: Pick<ThreadRecord, 'issue' | 'risk'>, links?: string[]): string | null;
export interface SummaryFields {
    problem: string;
    found: string;
    options: {
        name: string;
        effect: string;
    }[];
    recommendation: {
        option: string;
        why: string;
    };
    risk: {
        level: string;
        why: string;
    };
}
/** The most messages a summary is posted in. */
export declare const SUMMARY_MESSAGES = 6;
/**
 * THE facts check: is this summary true to the record? Every option named exactly once and none other, the
 * recommendation and risk level the record's, and every text free of secrets, mentions, links, other issue numbers
 * or levels, a recommendation of another option and any claim that it is decided. Returns the summary's messages
 * (with the engine's own links), or why it can't be posted.
 */
export declare function checkSummary(raw: unknown, r: ThreadRecord, o: {
    issueUrl?: string;
    dashboardUrl: string;
}): {
    ok: true;
    posts: string[];
} | {
    ok: false;
    why: string;
};
/** What a thread posts when the summary can't be: the fixed template, and the dashboard's link. */
export declare function fallbackSummary(template: string, dashboardUrl: string): string;
/**
 * Text as chat messages of at most REPLY_CHARS each, cut on line breaks (a longer line on a space), or null when it
 * needs more than `max` messages.
 */
export declare function splitPosts(text: string, max: number): string[] | null;
/** What a thread message is, as the code takes the thread run's result. */
export type ThreadIntent = {
    intent: 'question';
    answer: string[];
} | {
    intent: 'choice';
    option: string;
} | {
    intent: 'other';
};
/** The most messages an answer in a thread is posted in. */
export declare const ANSWER_MESSAGES = 3;
/**
 * The thread run's result as the code takes it: a choice only of an option the record has; a question only with an
 * answer that passes textProblem (links: only the engine's own) and fits ANSWER_MESSAGES; anything else is other.
 * `why` says what was refused, for the record.
 */
export declare function acceptThread(raw: unknown, r: ThreadRecord, links: string[]): ThreadIntent & {
    why?: string;
};
/** The ask-back for a plain-language pick: only the same person's yes records it. */
export declare const confirmText: (option: string) => string;
/** Someone else's yes to another person's pick. */
export declare const notYourConfirmText: (login: string, option: string) => string;
/** A question when the thread run can't run (the spend cap) or gave nothing usable. */
export declare const noAnswerText: (dashboardUrl: string) => string;
