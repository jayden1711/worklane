import type { Actionability, Backlog, CommitCheck, Issue, PullRequest } from './backlog/types.js';
import type { StoredEvent } from './events/types.js';
export type CanaryReason = 'update' | 'daily';
/** The labels a canary issue carries: ready (writers' issues are taken as they are), size:M (it is planned first). */
export declare const CANARY_LABELS: readonly ["ready", "size:M", "canary"];
export declare const CANARY_LABEL: {
    name: string;
    color: string;
    description: string;
};
/** The canary issue: one line appended to CANARY.md, a five-part issue with a done_when the agent can run. */
export declare function canaryIssue(reason: CanaryReason, now: Date): {
    id: string;
    title: string;
    body: string;
    labels: string[];
};
/**
 * Why this instance can't be the canary, or null when it can: its repo must be exactly the canary repo the
 * machine config names, and no other instance on this machine may run on that repo.
 */
export declare function canaryRefusal(o: {
    instance: string;
    instanceRepo: string;
    canaryRepo: string;
    others: {
        name: string;
        repo: string;
    }[];
}): string | null;
export type CanaryStage = 'filed' | 'taken' | 'planned' | 'pr' | 'checks' | 'merged';
export interface CanaryStatus {
    state: 'pending' | 'passed' | 'failed';
    /** How far it got. */
    stage: CanaryStage;
    /** What it waits on, or why it failed. */
    reason: string;
    pr: {
        number: number;
        url: string;
    } | null;
}
/**
 * How far the canary issue got, from the canary instance's own events and, once its PR is merged, GitHub's word on
 * that PR and the checks on its head. Fails at once only when nothing can come of it any more (the PR closed
 * unmerged, the plan held for the owner, the PR outside the canary repo); everything else is pending, and the
 * updater's time limit decides.
 */
export declare function canaryProgress(o: {
    issue: number;
    repo: string;
    events: StoredEvent[];
    pr?: PullRequest | null;
    checks?: CommitCheck[] | null;
}): CanaryStatus;
/** File the canary issue on the canary repo with the instance's backlog. */
export declare function fileCanary(backlog: Backlog, repo: string, reason: CanaryReason, now: Date): Promise<{
    issue: number;
    url: string;
    id: string;
}>;
/** Read how far the canary got: the instance's events, and GitHub once the instance recorded the merge. */
export declare function checkCanary(backlog: Backlog, repo: string, issue: number, events: StoredEvent[]): Promise<CanaryStatus>;
/**
 * The one issue a writer didn't open that an instance takes: on the machine's canary instance (updates.json
 * canary.instance), an open `ready` + `canary` issue its own App opened, the canary the updater filed. App bots can't
 * be listed as writers (a handle has no "[bot]"), so without this the canary would never be taken. Anywhere else,
 * or by anyone else, null: the usual writer rule decides.
 */
export declare function canaryTask(issue: Pick<Issue, 'author' | 'labels' | 'state'>, o: {
    instance: string;
    canaryInstance: string | null;
    bot: string;
}): Actionability | null;
/** The canary instance the machine config names, or null (no updater, or no canary). */
export declare const machineCanaryInstance: (path?: string) => string | null;
