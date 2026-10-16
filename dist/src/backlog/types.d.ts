import { DoneWhen } from '../contract.js';
import type { z } from 'zod';
export interface Issue {
    number: number;
    title: string;
    body: string;
    labels: string[];
    author: string;
    assignees: string[];
    state: 'open' | 'closed';
}
/** The tracker, as the coordinator sees it. Only the coordinator writes. */
export interface Backlog {
    list(label: string): Promise<Issue[]>;
    get(n: number): Promise<Issue>;
    /**
     * Issues (not PRs) now closed and last updated at or after `since` (ISO): every one closed since then, and maybe
     * some closed earlier. One listing, however many issues it covers.
     */
    closedSince(since: string): Promise<number[]>;
    /** Logins that added `label` to the issue, oldest first. */
    labelAdders(n: number, label: string): Promise<string[]>;
    addLabels(n: number, labels: string[]): Promise<void>;
    removeLabel(n: number, label: string): Promise<void>;
    setAssignees(n: number, logins: string[]): Promise<void>;
    comment(n: number, body: string): Promise<void>;
    /** An issue's or PR's comments, oldest first; `at`: when it was made (ISO), when the tracker says. */
    comments(n: number): Promise<{
        author: string;
        body: string;
        at?: string;
    }[]>;
    close(n: number): Promise<void>;
    createIssue(title: string, body: string, labels: string[]): Promise<number>;
    /** WHY (#468): the open issues (not PRs), at most 100, in ONE read: the Issues page's "not picked up" list. Absent: this tracker can't. */
    openIssues?(): Promise<Issue[]>;
    /**
     * Open a pull request from a pushed branch, or return the open one for that branch. `draft` asks for a draft
     * (a repo that doesn't support drafts gets an ordinary PR); `headSha` is the commit just pushed.
     */
    openPr(head: string, base: string, title: string, body: string, opts?: {
        draft?: boolean;
        headSha?: string;
    }): Promise<{
        url: string;
        number: number;
        draft: boolean;
    }>;
    /** A pull request's current state. */
    pullRequest(n: number): Promise<PullRequest>;
    /** Every check on a commit: check runs (latest per name) and commit statuses. */
    checks(sha: string): Promise<CommitCheck[]>;
    /** Take a draft PR out of draft. */
    markReady(n: number): Promise<void>;
    /**
     * Merge a PR with a merge commit (never squash), only if its head is still `sha` (GitHub's `sha`, like `gh pr merge
     * --match-head-commit`). `title` and `body` are the merge commit's subject and message. Returns the merge commit.
     */
    mergePr(n: number, sha: string, title: string, body?: string): Promise<{
        ok: true;
        sha: string;
    } | {
        ok: false;
        why: string;
    }>;
    /** Ask these people to review a PR (GitHub notifies them). */
    requestReview(n: number, logins: string[]): Promise<void>;
    /**
     * The log of a check run's job (an Actions job: its id is the check run's). `forbidden`: the credential can't
     * read Actions logs; `not_found`: there is no such log (not an Actions job, or expired).
     */
    jobLog(id: number): Promise<{
        ok: true;
        text: string;
    } | {
        ok: false;
        why: 'forbidden' | 'not_found';
    }>;
    /**
     * Re-run, on the same commit, the failed jobs of the Actions workflow runs these check runs' jobs belong to: each
     * workflow run once (POST /actions/runs/{run}/rerun-failed-jobs). Per check run: re-run, or `forbidden` (the
     * credential can't, no Actions: write, or GitHub refuses it now: the run is still going) or `not_found` (not an
     * Actions job). Absent: this tracker can't re-run checks.
     */
    rerunFailedJobs?(checkRunIds: number[]): Promise<Map<number, RerunJobs>>;
    ensureLabels(labels: {
        name: string;
        color: string;
        description: string;
    }[]): Promise<string[]>;
    /** A pull request's submitted reviews, oldest first. */
    reviews(n: number): Promise<PrReview[]>;
    /** A pull request's inline review comments (on lines of its diff), oldest first. Absent: this tracker has none. */
    reviewComments?(n: number): Promise<PrReviewComment[]>;
    /** Who closed an issue or pull request (null: open, or unknown). */
    closedBy(n: number): Promise<string | null>;
}
export interface PullRequest {
    number: number;
    url: string;
    /** The branch name and its current commit. */
    head: string;
    headSha: string;
    /** The branch it merges into (its actual base, which a conflict fix merges in). */
    base: string;
    draft: boolean;
    state: 'open' | 'closed' | 'merged';
    title: string;
    /** Its description (Markdown), as the tracker has it: a decision's detail reads its fail-without and never sections. */
    body?: string;
    /** GitHub's merge check: null while it's still computing. */
    mergeable: boolean | null;
    /** clean | unstable | has_hooks | dirty (conflicts) | behind | blocked | draft | unknown */
    mergeableState: string;
    /** Its size and conversation as the tracker reports them (lines added and removed, files, comments and review comments); absent when it doesn't. */
    stats?: {
        additions: number;
        deletions: number;
        files: number;
        comments: number;
    };
}
/** A submitted review on a pull request. `state`: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
export interface PrReview {
    id: number;
    author: string;
    state: string;
    body: string;
    at: string;
}
/** An inline review comment: on `path` at `line` (null: the line is gone from the diff), part of review `review`. */
export interface PrReviewComment {
    id: number;
    review: number | null;
    author: string;
    body: string;
    path: string;
    line: number | null;
    at: string;
}
/** What a re-run request got: the workflow run re-run, or why not. */
export type RerunJobs = {
    ok: true;
    run: number;
} | {
    ok: false;
    why: 'forbidden' | 'not_found';
    detail: string;
};
/** One check on a commit, as GitHub reports it: a check run, or a commit status (completed with its state). */
export interface CommitCheck {
    name: string;
    source: 'check_run' | 'status';
    /** queued | in_progress | completed for check runs; pending | completed for statuses. */
    status: string;
    /** success | failure | cancelled | skipped | neutral | timed_out | action_required | ... ; null until completed. */
    conclusion: string | null;
    /** The check run's id (its job, for a run from Actions), when there is one. */
    id?: number;
    url?: string;
}
export declare const LABELS: readonly [{
    readonly name: "triage";
    readonly color: "d4c5f9";
    readonly description: "New; not yet approved for work";
}, {
    readonly name: "ready";
    readonly color: "0e8a16";
    readonly description: "Approved by a writer; has a done_when contract";
}, {
    readonly name: "agent:working";
    readonly color: "fbca04";
    readonly description: "Claimed by an agent (see the claim comment)";
}, {
    readonly name: "in-review";
    readonly color: "1d76db";
    readonly description: "Change proposed; verifying or awaiting approval";
}, {
    readonly name: "needs:decision";
    readonly color: "b60205";
    readonly description: "Waiting on a decision from the owner";
}, {
    readonly name: "money-path";
    readonly color: "5319e7";
    readonly description: "Touches money-path code: extra verification";
}, {
    readonly name: "blocked";
    readonly color: "000000";
    readonly description: "Cannot proceed; see the latest comment";
}, {
    readonly name: "merge-ready";
    readonly color: "0e8a16";
    readonly description: "Required checks passed on the commit the evaluator approved";
}, {
    readonly name: "ci-failing";
    readonly color: "b60205";
    readonly description: "A required check fails and CI fix runs stopped; see the latest comment";
}, {
    readonly name: "needs-owner";
    readonly color: "d93f0b";
    readonly description: "Waits for the owner to review and merge; the latest comment says why";
}, {
    readonly name: "type:investigation";
    readonly color: "c5def5";
    readonly description: "Read-only: findings and evidence, no code change";
}, {
    readonly name: "type:goal";
    readonly color: "c5def5";
    readonly description: "A goal: split into child issues that depend on each other, not built itself";
}, {
    readonly name: "goal:split";
    readonly color: "ededed";
    readonly description: "This goal was split; its child issues are listed in a comment";
}, {
    readonly name: "report";
    readonly color: "bfdadc";
    readonly description: "Scheduled reports are posted here";
}, {
    readonly name: "size:S";
    readonly color: "c2e0c6";
    readonly description: "Small";
}, {
    readonly name: "size:M";
    readonly color: "fef2c0";
    readonly description: "Medium: plan mode first";
}, {
    readonly name: "size:L";
    readonly color: "f9d0c4";
    readonly description: "Large: plan mode first";
}, {
    readonly name: "review:L0";
    readonly color: "ededed";
    readonly description: "Lands after checks pass";
}, {
    readonly name: "review:L1";
    readonly color: "ededed";
    readonly description: "Lands after the evaluator approves";
}, {
    readonly name: "review:L2";
    readonly color: "ededed";
    readonly description: "Lands after the evaluator approves; owner notified";
}, {
    readonly name: "review:L3";
    readonly color: "ededed";
    readonly description: "Owner must approve before landing";
}];
export type DoneWhenList = z.infer<typeof DoneWhen>;
/** The ```done_when fenced block in an issue body, validated. */
/** Identifies the ```done_when block an intake decision was about: a hash of its text, or "none". */
export declare function contractKey(body: string): string;
export declare function parseContract(body: string): {
    ok: true;
    done_when: DoneWhenList;
} | {
    ok: false;
    why: string;
};
/** The five parts of every issue the harness drafts itself (intake, chat, gardener, corrections). */
export declare const ISSUE_PARTS: readonly ["Outcome", "Sources", "Constraints", "Deliverable", "Review point"];
export type IssuePart = (typeof ISSUE_PARTS)[number];
/** How a drafting agent is told to write the body (src/roles.ts says the same in the chat role; a test keeps them in step). */
export declare const DRAFT_FORMAT = "five parts, each starting a line with its bold label: **Outcome:** one sentence. **Sources:** where to look, nowhere else. **Constraints:** what to leave alone. **Deliverable:** a closed ```done_when block, commands as YAML block scalars (\"- command: |\"). **Review point:** the expected review level (L0 to L3) and what would make it wait for the owner.";
/**
 * The text of each part in an issue body, labelled `**Outcome:**` (or `**Outcome**:`) at the start of a line, or as
 * a heading (`## Outcome`). A part runs to the next part's label; labels inside code fences don't count. null: absent.
 */
export declare function issueParts(body: string): Record<IssuePart, string | null>;
/**
 * Can an issue the harness drafted itself be filed? A title; all five parts, none empty; the Outcome one sentence on
 * one line; the Deliverable a ```done_when block parseContract accepts, its commands YAML block scalars
 * (`- command: |`, which keeps quoting and colons inside commands from breaking the block); the Review point naming
 * a review level (L0 to L3).
 */
export declare function checkDraftedIssue(title: string, body: string): {
    ok: true;
    done_when: DoneWhenList;
} | {
    ok: false;
    why: string;
};
export interface Actionability {
    actionable: boolean;
    why: string;
}
/**
 * Only issues opened by a writer, or marked ready by a writer, are
 * actionable; outsiders' issues stay in triage however they're labeled.
 */
export declare function actionable(issue: Issue, writers: string[], backlog: Backlog): Promise<Actionability>;
/** The owner for an issue: an assignee who is a writer, else the first matching area, else the default. */
export declare function ownerFor(issue: Issue, paths: string[], owners: {
    default: string;
    writers: string[];
    areas: {
        owner: string;
        paths: string[];
        labels: string[];
    }[];
}, match: (glob: string, path: string) => boolean): string;
/** Who may answer a decision: its owner, or one of the project's writers. GitHub logins are case-insensitive. */
export declare function mayAnswer(owner: string, user: string, owners: {
    writers: string[];
}): boolean;
