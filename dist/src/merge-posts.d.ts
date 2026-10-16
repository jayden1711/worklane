import { type WatchGit } from './main-watch.js';
/** At most one GitHub API call per this long. */
export declare const MERGE_POSTS_CALL_MS = 30000;
/** The intent line is cut to this many characters. */
export declare const INTENT_CHARS = 200;
/** A PR as merge posts read it: from the commit's PRs, and then the PR itself (only it says who merged it). */
export interface MergePull {
    number: number;
    url: string;
    title: string;
    body: string | null;
    mergedAt: string | null;
    mergeCommit: string | null;
    /** The merger's GitHub login (merged_by.login), or null; never an email. */
    mergedBy: string | null;
    base: string;
}
/** The calls merge posts make: one REST request each (github/merge-posts-api.ts). */
export interface MergePostsApi {
    commitPulls(sha: string): Promise<MergePull[]>;
    pull(n: number): Promise<MergePull>;
}
export interface MergePostsState {
    version: 1;
    /** The last commit walked: everything up to it (first parents) is done. Null: not started (the next tip is the baseline). */
    last: string | null;
    /** When the last API call was made (ms). */
    lastCallAt: number;
    /** The commit being looked at, and what is known about it so far. */
    /** `pullsAt`, `pullsLastAt`: when the commit's PRs were first and last asked (ms); an answer with no merged PR is asked again until one LINK_LAG_MS after the first. */
    pending: {
        sha: string;
        pulls?: MergePull[];
        pullsAt?: number;
        pullsLastAt?: number;
        pr?: MergePull;
    } | null;
}
export declare function readMergePostsState(file: string): MergePostsState;
/** The key a merge's post is sent under, once. */
export declare const mergePostKey: (sha: string) => string;
/**
 * The PR's intent line: the first line of the body's first paragraph (HTML comments, as templates leave them, and a
 * heading's #s taken off), redacted by `redact`, then cut to INTENT_CHARS. The title when the body gives no line.
 */
export declare function intentLine(body: string | null, title: string, redact: (s: string) => string): string;
/** The post for one merge. Only the login (when it is one), the number, the link, the short sha and the intent line. */
export declare function mergePostText(pr: MergePull, sha: string, redact: (s: string) => string): string;
export interface MergePostsDeps {
    stateFile: string;
    branch: string;
    api: MergePostsApi;
    git: WatchGit;
    /** Redacts the intent line (secrets, emails, the intake's own names and patterns). */
    redact: (s: string) => string;
    /**
     * Post `text` once under `key`: 'sent' when it went (or had gone before), 'limited' when the ops channel's machine-
     * wide limit is full right now (it is tried again on a later pass).
     */
    send: (key: string, text: string) => Promise<'sent' | 'limited'>;
    now?: () => number;
}
export declare class MergePosts {
    private readonly d;
    private listedAt;
    constructor(d: MergePostsDeps);
    private get now();
    state(): MergePostsState;
    /** Turned off (or nowhere to post): forget the place, so turning it on starts from the tip, not a backlog. */
    off(): void;
    private take;
    /** One pass: at most one API call, and at most one post. */
    step(): Promise<void>;
}
