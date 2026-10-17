import type { GitHubEventName } from './schema.js';
/** Between two polls, at least. */
export declare const POLL_MS: number;
/** Hold off while fewer than this share of the hour's calls are left. */
export declare const QUOTA_FLOOR = 0.1;
/** The poller's state file, in the coordinator's state directory. */
export declare const POLL_STATE = "automations-github.json";
export interface RepoEvent {
    name: GitHubEventName;
    /** The issue or PR number. */
    number: number;
    actor: string;
    /** The actor is a bot (any App, the harness's own included). */
    byBot: boolean;
    label?: string;
    /** The text a run may see (as untrusted data): the issue's title and body, or the comment. */
    text: string;
    at: string;
    /** Unique per event: the fire's reference. */
    key: string;
}
/** One GET: its status, its JSON, its ETag and the rate limit headers. Absent token or network: it throws. */
export type Get = (path: string, etag: string | null) => Promise<{
    status: number;
    json: unknown;
    etag: string | null;
    headers: Record<string, string>;
}>;
/** A GET with the instance's token: conditional (If-None-Match), so an unchanged listing answers 304. */
export declare function githubGet(o: {
    api: string;
    token: () => Promise<string>;
    fetch?: typeof fetch;
}): Get;
export declare class GitHubEventsPoller {
    private o;
    private nextAt;
    constructor(o: {
        repo: string;
        get: Get;
        stateDir: string;
        now?: () => number;
        /** Told once per hold: why, and until when (ISO). */
        held?: (why: string, until: string) => void;
    });
    private get file();
    private read;
    private write;
    /** Whether a poll is due (it never polls more often than POLL_MS, nor before a hold ends). */
    due(): boolean;
    /** The events since the last poll (none on the first: it starts from now). Not due: none, and no call. */
    poll(): Promise<RepoEvent[]>;
}
