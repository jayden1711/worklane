export declare const REPLIER_ROLE = "intake-replier";
/** Every tool, named as disallowed: the role writes one reply and needs none. */
export declare const REPLIER_DENIED: readonly ["Read", "Glob", "Grep", "LS", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead", "Task", "TodoWrite", "WebSearch", "WebFetch", "mcp__*"];
export declare const REPLIER_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["reply"];
    readonly properties: {
        readonly reply: {
            readonly type: "string";
        };
    };
};
/** Every stage the engine can give the replier; it sends no other (the coordinator's fixed reply covers the rest). */
export declare const REPLY_STAGES: readonly ["filed", "merged", "deployed", "needs_info", "question"];
export type ReplyStage = (typeof REPLY_STAGES)[number];
/** What the engine tells the replier, and all it knows besides the redacted message. */
export interface ReplyFacts {
    stage: ReplyStage;
    trusted: boolean;
    /** The issue number, only when the sender may see it (trusted). */
    issue?: number;
    /** The issue's link, the one link a reply may carry, when the engine has one. */
    issueUrl?: string;
}
/** The run's input: the facts and the redacted message, nothing else. */
export declare function replierPrompt(redacted: string, facts: ReplyFacts): string;
/** An empty working directory under the research root (the research lane refuses every read outside it). */
export declare function replierDir(instanceRoot: string, gid: number, id: string, stage: string): string;
/** The fixed parts of a replier run: no tools, the research lane, the structured reply, one short session. */
export declare function replierRun(o: {
    cwd: string;
    redacted: string;
    facts: ReplyFacts;
}): {
    role: string;
    lane: string;
    cwd: string;
    allowedTools: string[];
    disallowedTools: ("Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "Bash" | "Read" | "Grep" | "Glob" | "NotebookRead" | "WebFetch" | "WebSearch" | "Task" | "mcp__*" | "LS" | "TodoWrite")[];
    appendSystemPrompt: string;
    prompt: string;
    jsonSchema: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["reply"];
        readonly properties: {
            readonly reply: {
                readonly type: "string";
            };
        };
    };
    maxTurns: number;
};
/** The longest run of consecutive words the reply shares with the message. */
export declare function echoed(reply: string, message: string): number;
/** A short quote is fine; this many words of the message in a row is an echo. */
export declare const ECHO_WORDS = 8;
/** A link, as the reply checks find one. */
export declare const URL: RegExp;
/**
 * A mention: a Discord user, role or channel ping; a Slack user, channel or group ping (<@U...>, <#C...>,
 * <!here>, <!channel>, <!everyone>, <!subteam^...>); @everyone, @here or @channel; or an @handle.
 */
export declare const MENTION: RegExp;
/**
 * Is this reply safe to send for these facts? Code, not the model, decides. Returns why it isn't, else ok.
 */
export declare function checkReply(reply: unknown, o: {
    redacted: string;
    facts: ReplyFacts;
}): {
    ok: true;
    text: string;
} | {
    ok: false;
    why: string;
};
