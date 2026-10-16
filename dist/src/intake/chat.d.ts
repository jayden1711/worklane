export declare const CHAT_ROLE = "channel-chat";
/** The lane chat runs in (src/instance.ts researchLanes): the agent user, read-only, its root the checkout. */
export declare const CHAT_LANE = "chat-repo";
/** The env the chat lane's settings pin for its hooks: the checkout, the only place it may read. */
export declare const CHAT_ROOT_ENV: string;
/** Exactly these tools. */
export declare const CHAT_TOOLS: readonly ["Read", "Glob", "Grep"];
/** Every other tool, named as disallowed too, so a project's pre-approved tools or settings can't add them back. */
export declare const CHAT_DENIED: readonly ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead", "LS", "Task", "TodoWrite", "WebSearch", "WebFetch", "mcp__*"];
export declare const CHAT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["reply"];
    readonly properties: {
        readonly reply: {
            readonly type: "string";
        };
    };
};
/** The most messages one reply is posted in. */
export declare const CHAT_MESSAGES = 8;
/** Key-like and credential files, as Read deny rules in the chat lane's settings (the hook covers .env.* but .env.example). */
export declare const CHAT_KEY_GLOBS: readonly ["**/.env", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*", "**/credentials.yaml", "**/credentials.json", "**/intake.yaml", "**/policy.yaml", "**/.git/**"];
/** Is this path (relative to the checkout) a credential, key, config or .env file (but .env.example), or under .git? */
export declare function secretLike(rel: string): boolean;
/** The most entries a directory Grep's secret check walks; past that, the Grep needs a glob that can't reach one. */
export declare const WALK_LIMIT = 20000;
/**
 * The chat lane's rule, in the PreToolUse hook: only Read, Glob and Grep; every path inside the checkout `root` (its
 * real path: a symlink out is refused); never a credential, key, config or .env file (but .env.example) or .git; a
 * Grep over a directory only when it can't reach such a file (none there, or a glob that can't match one).
 */
export declare function chatModeRefusal(tool: string, input: Record<string, unknown>, cwd: string, rootIn: string): string | null;
/** One turn of the conversation, as it is kept (redacted, in the coordinator's private store). */
export interface ChatTurn {
    at: string;
    by: string;
    said: string;
    reply: string;
}
/** The run's prompt: the state block, the conversation so far, the message. All redacted. */
export declare function chatPrompt(o: {
    state: string;
    history: ChatTurn[];
    by: string;
    message: string;
}): string;
/** The fixed parts of a chat run: its lane, its three tools in the checkout, its reply schema. */
export declare function chatRun(o: {
    repo: string;
    prompt: string;
    model: string;
}): {
    role: string;
    lane: string;
    cwd: string;
    model: string;
    allowedTools: ("Read" | "Grep" | "Glob")[];
    disallowedTools: ("Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "Bash" | "NotebookRead" | "WebFetch" | "WebSearch" | "Task" | "mcp__*" | "LS" | "TodoWrite")[];
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
/**
 * Is a chat reply safe to post? Code decides: no secret-shaped string (the event log's redaction would change it),
 * no ping, no link but `links` (the repo's issue and pull request pages, the dashboard), at most CHAT_MESSAGES
 * messages. Returns the messages, or why not.
 */
export declare function checkChatReply(reply: unknown, o: {
    links: (l: string) => boolean;
}): {
    ok: true;
    posts: string[];
} | {
    ok: false;
    why: string;
};
/** The links a chat reply may carry: the repo's issues and pull requests, and the dashboard. */
export declare function chatLinks(repo: string, dashboardUrl: string | undefined): (l: string) => boolean;
export declare const CHAT_REFUSED_TEXT = "I wrote a reply I can't post here (it failed a safety check). Try asking again, or more narrowly.";
export declare const CHAT_FAILED_TEXT = "Sorry, I couldn't come up with a reply to that. Try again in a bit.";
export declare const chatCapText: (usd: number) => string;
export declare const CHAT_BUDGET_TEXT = "Today's budget for this instance is spent; I'll be quiet until tomorrow.";
