import { type IncomingReport, type IntakeConfig, type IntakeSource } from './report.js';
/** Linear's GraphQL API. INVARIANT: a constant; no config, environment variable or request names another host. */
export declare const LINEAR_API = "https://api.linear.app/graphql";
/** The longest reply posted as a comment. */
export declare const LINEAR_REPLY_CHARS = 500;
export declare class LinearError extends Error {
    readonly retryAfterMs?: number | undefined;
    constructor(message: string, retryAfterMs?: number | undefined);
}
/** Remove every occurrence of the key from a message (and so from anything a server echoed back). */
export declare const scrubKey: (text: string, key: string) => string;
/**
 * One GraphQL request with the API key (Linear wants the bare key in Authorization, no "Bearer"). A rate limit is a
 * LinearError with when to come back; any other failure a LinearError with the key scrubbed out.
 */
export declare function linearQuery<T>(o: {
    apiKey: string;
    fetch?: typeof fetch;
    now?: () => number;
}, query: string, variables?: Record<string, unknown>): Promise<T>;
/** Text for a Linear comment (markdown) with markdown's active characters escaped, links left whole. */
export declare function escapeLinearMarkdown(text: string): string;
export declare class LinearIntake {
    private o;
    readonly name: "linear";
    private nextAt;
    /** Issues seen and dropped, counted only: `bot` (no creator, an app or an integration), `sender` (not allowed). */
    droppedBy: Record<'bot' | 'sender', number>;
    /** The GraphQL queries sent, by name (tests read it: the fetch step is never sent for a creator who isn't allowed). */
    readonly sent: string[];
    constructor(o: {
        apiKey: string;
        stateDir: string;
        config: () => IntakeConfig['linear'];
        fetch?: typeof fetch;
        now?: () => number;
    });
    private q;
    private skipFile;
    private skipped;
    private skip;
    take(): Promise<IncomingReport[]>;
    private pull;
    /** One comment on the report's own issue, at most LINEAR_REPLY_CHARS, markdown escaped. Nothing else is changed. */
    reply(thread: NonNullable<IncomingReport['thread']>, text: string): Promise<boolean>;
    source(): IntakeSource;
}
