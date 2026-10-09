import { DoneWhen } from '../stopgate.js';
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
    /** Logins that added `label` to the issue, oldest first. */
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
    /** Open a pull request from a pushed branch; returns its URL. */
    openPr(head: string, base: string, title: string, body: string): Promise<string>;
    /** CI on a commit: the overall state and the checks that failed. */
    ciStatus(sha: string): Promise<CiStatus>;
    ensureLabels(labels: {
        name: string;
        color: string;
        description: string;
    }[]): Promise<string[]>;
}
export interface CiStatus {
    state: 'success' | 'failure' | 'pending' | 'none';
    failing: {
        name: string;
        url: string;
    }[];
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
    readonly name: "type:investigation";
    readonly color: "c5def5";
    readonly description: "Read-only: findings and evidence, no code change";
}, {
    readonly name: "red";
    readonly color: "e11d21";
    readonly description: "A new failure on main, attributed to the change that caused it";
}, {
    readonly name: "ci";
    readonly color: "c5def5";
    readonly description: "CI is red on main";
}, {
    readonly name: "qa";
    readonly color: "fef2c0";
    readonly description: "Found by the QA playtester on a test deployment";
}, {
    readonly name: "incident";
    readonly color: "b60205";
    readonly description: "A deployment check failed; see the monitor comment";
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
export declare function parseContract(body: string): {
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
