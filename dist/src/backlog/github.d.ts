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
    createIssue(title: string, body: string, labels: string[]): Promise<number>;
    openPr(head: string, base: string, title: string, body: string): Promise<string>;
    ciStatus(sha: string): Promise<{
        state: "none";
        failing: never[];
    } | {
        state: "success" | "failure" | "pending";
        failing: {
            name: string;
            url: string;
        }[];
    }>;
    ensureLabels(labels: {
        name: string;
        color: string;
        description: string;
    }[]): Promise<string[]>;
}
export {};
