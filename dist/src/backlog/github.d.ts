import type { Backlog, Issue } from './types.js';
export declare class GitHubError extends Error {
    readonly status: number;
    readonly kind: string;
    readonly retryAfter?: number | undefined;
    constructor(status: number, kind: string, message: string, retryAfter?: number | undefined);
}
export declare function ghToken(): string;
type Fetch = typeof fetch;
export declare class GitHubBacklog implements Backlog {
    readonly repo: string;
    private token;
    private fetchImpl;
    private api;
    constructor(repo: string, token?: () => string, fetchImpl?: Fetch, api?: string);
    private req;
    private toIssue;
    list(label: string): Promise<Issue[]>;
    get(n: number): Promise<Issue>;
    labelAdders(n: number, label: string): Promise<string[]>;
    addLabels(n: number, labels: string[]): Promise<void>;
    removeLabel(n: number, label: string): Promise<void>;
    setAssignees(n: number, logins: string[]): Promise<void>;
    comment(n: number, body: string): Promise<void>;
    comments(n: number): Promise<{
        author: string;
        body: string;
    }[]>;
    close(n: number): Promise<void>;
    ensureLabels(labels: {
        name: string;
        color: string;
        description: string;
    }[]): Promise<string[]>;
}
export {};
