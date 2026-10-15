import type { Backlog, CommitCheck, Issue, PrReview, PrReviewComment, PullRequest, RerunJobs } from './types.js';
export declare class GitHubError extends Error {
    readonly status: number;
    readonly kind: string;
    readonly retryAfter?: number | undefined;
    constructor(status: number, kind: string, message: string, retryAfter?: number | undefined);
}
export declare function ghToken(): string;
type Fetch = typeof fetch;
/** How long one GitHub request may take: a request that hangs never holds the coordinator's tick (or its shutdown) for longer. */
export declare const REQUEST_TIMEOUT_MS = 30000;
export declare class GitHubBacklog implements Backlog {
    readonly repo: string;
    private token;
    private fetchImpl;
    private api;
    constructor(repo: string, token?: () => string | Promise<string>, fetchImpl?: Fetch, api?: string);
    /**
     * `raw`: the response body as text (a log), not JSON. Everything sent is redacted first (events/redact.ts): a
     * comment, issue or pull request can carry command output, and on a public repo it's public.
     */
    private req;
    private toIssue;
    list(label: string): Promise<Issue[]>;
    closedSince(since: string): Promise<number[]>;
    get(n: number): Promise<Issue>;
    labelAdders(n: number, label: string): Promise<string[]>;
    addLabels(n: number, labels: string[]): Promise<void>;
    removeLabel(n: number, label: string): Promise<void>;
    setAssignees(n: number, logins: string[]): Promise<void>;
    comment(n: number, body: string): Promise<void>;
    comments(n: number): Promise<{
        at?: string;
        author: string;
        body: string;
    }[]>;
    close(n: number): Promise<void>;
    createIssue(title: string, body: string, labels: string[]): Promise<number>;
    openPr(head: string, base: string, title: string, body: string, opts?: {
        draft?: boolean;
    }): Promise<{
        url: string;
        number: number;
        draft: boolean;
    }>;
    pullRequest(n: number): Promise<PullRequest>;
    mergePr(n: number, sha: string, title: string, body?: string): Promise<{
        ok: true;
        sha: string;
    } | {
        ok: false;
        why: string;
    }>;
    checks(sha: string): Promise<CommitCheck[]>;
    requestReview(n: number, logins: string[]): Promise<void>;
    jobLog(id: number): Promise<{
        ok: true;
        text: string;
    } | {
        ok: false;
        why: 'forbidden' | 'not_found';
    }>;
    rerunFailedJobs(checkRunIds: number[]): Promise<Map<number, RerunJobs>>;
    markReady(n: number): Promise<void>;
    reviews(n: number): Promise<PrReview[]>;
    reviewComments(n: number): Promise<PrReviewComment[]>;
    closedBy(n: number): Promise<string | null>;
    ensureLabels(labels: {
        name: string;
        color: string;
        description: string;
    }[]): Promise<string[]>;
}
export {};
