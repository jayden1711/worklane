import type { Backlog } from '../backlog/types.js';
import type { EventLog } from '../events/log.js';
import { type Episode } from '../fix-forward.js';
import { type TestRuns } from './pr-batch.js';
/** The default branch's commits, read with git in the coordinator's clone. */
export interface FixForwardGit {
    /** Fetch the default branch; its tip, or null. */
    tip(): string | null;
    /** A commit's first parent, or null. */
    parent(sha: string): string | null;
    isAncestor(a: string, b: string): boolean;
    /** The first-parent commits after `from` up to `to`, oldest first. */
    firstParents(from: string, to: string): string[];
    subject(sha: string): string;
    /** The files a commit changes against its first parent. */
    files(sha: string): string[];
    /** Its diff against its first parent. */
    diff(sha: string): string;
}
export interface FixForwardDeps {
    log: EventLog;
    actor: string;
    backlog: Backlog;
    branch: string;
    /** owner/name: links. */
    repo: string;
    /** The coordinator's clone (a test-run probe runs from it). */
    clone: string;
    git: FixForwardGit;
    config: () => {
        max_attempts: number;
        revert_first_paths: string[];
    };
    /** The project's required_checks. */
    required: () => string[];
    /** A probe not done in this many minutes counts as untestable (config.yaml flaky.rerun_timeout_min). */
    probeTimeoutMin: () => number;
    testRuns: TestRuns | null;
    tiers: () => {
        name: string;
        kind: 'fast' | 'full';
    }[];
    /** The review categories (src/review.ts computeLevel, with the money-path list) of these files. */
    categories: (files: string[]) => Record<string, string[]>;
    /** Open the culprit's revert PR (and stop auto-merge, tell the owner): the merge flow's. */
    revert: (o: {
        ep: Episode;
        culprit: string;
        number: number | null;
        title: string;
        evidence: string;
    }) => Promise<{
        url: string;
        number: number;
    } | null>;
    /** Nothing to revert or fix: stop auto-merge and tell the owner (the merge flow's). */
    giveUp: (o: {
        ep: Episode;
        reason: string;
    }) => Promise<void>;
    /** One ops post, once per key: sent (or had been), limited (try again later), or off (nowhere to post). */
    post: (key: string, text: string) => Promise<'sent' | 'limited' | 'off'>;
    /** How often the branch's tip is looked at (ms). */
    pollMs: () => number;
    now?: () => number;
}
export declare const redKey: (sha: string) => string;
export declare const greenKey: (sha: string) => string;
export declare class FixForward {
    private readonly d;
    /** Test-run probes in this process, by candidate: running, or each failing check's result. */
    private probes;
    /** Time each probe spent held at the start gate: not counted against its timeout. */
    private heldTime;
    private lookedAt;
    private attached;
    constructor(d: FixForwardDeps);
    private get now();
    private emit;
    private error;
    private events;
    /** The red default branch being worked on, or null. */
    open(): Episode | null;
    /** Whether issue `n` is one of fix-forward's own fix tasks (so the dispatcher works it whoever filed it). */
    isFixTask(n: number): boolean;
    /**
     * Why PR `number` (for issue `issue`) doesn't auto-merge now, or null: while the default branch is red, only the
     * latest fix task's PR does.
     */
    holds(issue: number): string | null;
    /** A real red on `sha` after auto-merging PR `number`: take it on, unless the branch was red already (the open one covers it). */
    start(o: {
        sha: string;
        number: number | null;
        failed: string[];
    }): Promise<void>;
    /** Default-branch commits known green, newest first: post-merge checks and earlier recoveries. */
    private knownGreen;
    step(): Promise<void>;
    private move;
    /**
     * A default-branch commit's state as the harness counts it: a harness merge by its post-merge check (after the
     * flaky re-run); anything else by its required checks, quarantined ones not counting.
     */
    private state;
    private bisect;
    private tested;
    private onCandidate;
    /** Test candidate `sha` on its own: the checks already on it, else a test run or an Actions re-run. True: a verdict is in. */
    private probe;
    /** A probe asked for earlier: its verdict once in (true), or still running (false); not done in time: skip. */
    private resolve;
    /** Run the tiers behind the failing checks on candidate `sha`, in the background. */
    private startTestRun;
    /** The culprit is named (or only the range it is in). */
    private named;
    /** Fix task `n`: an issue the dispatcher works like any task, with the failure, the culprit and the merged PRs. */
    private attempt;
    /** The PR the fix task opened (the latest pr.opened for its issue since the attempt), or null. */
    private fixPr;
    /** The running fix task: failed (ended without a PR, its PR gave up or closed, or merged and still red), or not yet. */
    private judge;
    /** Name the culprit on the fix PR, once. */
    private attachCulprit;
    private finish;
    private revert;
    /** Green again on `tip`: by a fix PR, the culprit's revert, or something else. */
    private greenAgain;
    /** Each red default branch's posts not sent yet: red once its culprit is named (or it ended), green once it is. */
    private outbound;
    private next;
}
