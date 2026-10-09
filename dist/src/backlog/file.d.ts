import type { CiStatus, Backlog, Issue } from './types.js';
export declare class FileBacklog implements Backlog {
    readonly path: string;
    readonly actor: string;
    constructor(path: string, actor?: string);
    private load;
    private save;
    private edit;
    /** Test/seed helper: open an issue as `author`, optionally labeling it as `labeler`. */
    open(issue: Omit<Issue, 'number' | 'state' | 'assignees' | 'labels'> & {
        labels?: string[];
        labeler?: string;
        assignees?: string[];
    }): number;
    /** Test helper: a human comments on an issue. */
    humanComment(n: number, author: string, body: string): void;
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
    ciStatus(sha: string): Promise<CiStatus>;
    /** Tests and demos: set CI's result for a commit. */
    setCi(sha: string, status: CiStatus): void;
    prs(): {
        head: string;
        base: string;
        title: string;
        body: string;
        url: string;
    }[];
    ensureLabels(labels: {
        name: string;
    }[]): Promise<string[]>;
}
