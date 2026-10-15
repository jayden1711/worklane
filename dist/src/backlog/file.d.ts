import type { Backlog, CommitCheck, Issue, PrReview, PrReviewComment, PullRequest, RerunJobs } from './types.js';
interface FilePr {
    head: string;
    base: string;
    url: string;
    headSha: string;
    draft: boolean;
    merged: boolean;
    reviewers?: string[];
    /** GitHub's mergeable_state; clean unless a test says otherwise. */
    mergeableState?: string;
    /** The merge commit, once merged. */
    mergeSha?: string;
    mergeTitle?: string;
    mergeBody?: string;
    /** Submitted reviews (tests set them). */
    reviews?: PrReview[];
    /** Inline review comments (tests set them). */
    reviewComments?: PrReviewComment[];
    /** Who closed it (tests set it). */
    closedBy?: string;
    /** Lines added and removed, and files (tests set them); with them, the PR reports stats, its comments counted. */
    stats?: {
        additions: number;
        deletions: number;
        files: number;
    };
}
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
    /** Test helper: a human edits an issue's body. */
    editBody(n: number, body: string): void;
    /** Test helper: a human comments on an issue (now, or at `at`). */
    humanComment(n: number, author: string, body: string, at?: string): void;
    list(label: string): Promise<Issue[]>;
    /** No update times here: every closed issue (a superset, as the contract allows). */
    closedSince(_since: string): Promise<number[]>;
    get(n: number): Promise<Issue>;
    labelAdders(n: number, label: string): Promise<string[]>;
    addLabels(n: number, labels: string[]): Promise<void>;
    removeLabel(n: number, label: string): Promise<void>;
    setAssignees(n: number, logins: string[]): Promise<void>;
    comment(n: number, body: string): Promise<void>;
    comments(n: number): Promise<{
        author: string;
        body: string;
        at?: string;
    }[]>;
    close(n: number): Promise<void>;
    createIssue(title: string, body: string, labels: string[]): Promise<number>;
    openPr(head: string, base: string, title: string, body: string, opts?: {
        draft?: boolean;
        headSha?: string;
    }): Promise<{
        url: string;
        number: number;
        draft: boolean;
    }>;
    pullRequest(n: number): Promise<PullRequest>;
    /** Test hook: re-running a check run's failed Actions jobs (a file backlog has no Actions: absent, nothing re-runs). */
    rerunFailedJobs?: (checkRunIds: number[]) => Promise<Map<number, RerunJobs>>;
    /** Test hook: how a merge happens (e.g. a real merge commit on a test remote); returns the merge commit. */
    mergeWith?: (pr: {
        number: number;
        head: string;
        headSha: string;
        base: string;
    }) => string;
    mergePr(n: number, sha: string, title: string, body?: string): Promise<{
        ok: true;
        sha: string;
    } | {
        ok: false;
        why: string;
    }>;
    checks(sha: string): Promise<CommitCheck[]>;
    markReady(n: number): Promise<void>;
    requestReview(n: number, logins: string[]): Promise<void>;
    jobLog(id: number): Promise<{
        ok: true;
        text: string;
    } | {
        ok: false;
        why: 'forbidden' | 'not_found';
    }>;
    /** Test helper: a job's log, or 403 for a credential that can't read Actions logs. */
    setJobLog(id: number, log: string | 403): void;
    /** Test helper: the pull requests, oldest first. */
    prs(): {
        head: string;
        base: string;
        url: string;
        headSha: string;
        draft: boolean;
        merged: boolean;
        reviewers?: string[];
        /** GitHub's mergeable_state; clean unless a test says otherwise. */
        mergeableState?: string;
        /** The merge commit, once merged. */
        mergeSha?: string;
        mergeTitle?: string;
        mergeBody?: string;
        /** Submitted reviews (tests set them). */
        reviews?: PrReview[];
        /** Inline review comments (tests set them). */
        reviewComments?: PrReviewComment[];
        /** Who closed it (tests set it). */
        closedBy?: string;
        /** Lines added and removed, and files (tests set them); with them, the PR reports stats, its comments counted. */
        stats?: {
            additions: number;
            deletions: number;
            files: number;
        };
        number: number;
        title: string;
        body: string;
        labels: string[];
        state: "open" | "closed";
        comments: {
            author: string;
            body: string;
            at?: string;
        }[];
    }[];
    /** Test helper: change a pull request as GitHub would (a push moves headSha; a merge or close ends it). */
    setPr(n: number, patch: Partial<Pick<FilePr, 'headSha' | 'draft' | 'merged' | 'mergeableState' | 'closedBy' | 'stats'>> & {
        state?: 'open' | 'closed';
    }): void;
    /** Test helper: a review submitted on a pull request. */
    addReview(n: number, r: Omit<PrReview, 'id' | 'at'> & {
        at?: string;
    }): void;
    reviews(n: number): Promise<PrReview[]>;
    /** Test helper: an inline comment in a submitted review (`review`: its id, from addReview). */
    addReviewComment(n: number, c: Omit<PrReviewComment, 'id' | 'at'> & {
        at?: string;
    }): void;
    reviewComments(n: number): Promise<PrReviewComment[]>;
    closedBy(n: number): Promise<string | null>;
    /** Test helper: the checks GitHub reports on a commit. */
    setChecks(sha: string, checks: CommitCheck[]): void;
    ensureLabels(labels: {
        name: string;
    }[]): Promise<string[]>;
}
export {};
