import type { CommitCheck, PullRequest } from '../backlog/types.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
export interface TestRunRequest {
    repo: string;
    sha: string;
    kind: 'fast' | 'full';
    prs: number[];
    changedFiles?: string[];
    /** 1-based: index 1..total. */
    shard?: {
        index: number;
        total: number;
    };
}
export interface TierResult {
    tier: string;
    ok: boolean;
    durationMs: number;
    summary: string;
    logRef: string;
}
export interface TestRunResult {
    id: string;
    sha: string;
    kind: 'fast' | 'full';
    ok: boolean;
    tiers: TierResult[];
    /**
     * How the run ended, if the service says (src/testrun/ records it on testrun.finished): anything but `done` is no
     * verdict on the code. Without it, a tier that failed without running (no log: `cancelled`, the run couldn't go ahead,
     * a setup step failed) says the same.
     */
    outcome?: 'done' | 'cancelled' | 'error';
}
export interface TestRuns {
    /** Queues, waits for a slot and the lock, runs, wipes, records events. `signal`: cancel it (the result says cancelled). */
    startTestRun(req: TestRunRequest, opts?: {
        signal?: AbortSignal;
    }): Promise<TestRunResult>;
    /** GitHub check runs via the App, one per tier, on `sha`; `checkNames`: tier -> check name. */
    postChecks(sha: string, result: TestRunResult, checkNames: Record<string, string>): Promise<void>;
    /** Every tier's check name (src/testrun/ checkNamesFor over tests.yaml test_run). */
    checkNames(): Record<string, string>;
}
export interface PrBatchConfig {
    enabled: boolean;
    max: number;
    shards: number;
    fast_checks: string[];
    full_checks: string[];
}
export interface BatchEntry {
    /** The issue the harness's PR is for; for a person's PR (`by`), the PR's own number. */
    issue: number;
    number: number;
    head: string;
    /** A person's PR: who opened it (a mapped admin or writer). The harness never merges it; they do. */
    by?: string;
}
type Step = EventPayload<'pr_batch.step'>;
type StepName = Step['step'];
export interface BatchView {
    id: string;
    parent: string | null;
    prs: BatchEntry[];
    sha: string | null;
    base: string | null;
    steps: StepName[];
    /** The batch's own full run, when it ended. */
    run: Step['run'];
    /** The tree after each PR's merge, in order (what main must hold after merging up to it). */
    trees: string[];
    /** Built and not yet finished or abandoned. */
    open: boolean;
    at: string;
    last: string;
}
export interface BatchState {
    /** PRs waiting for a batch, in the order they became ready. */
    queue: BatchEntry[];
    batches: Map<string, BatchView>;
    /** `number@head` -> the green batch whose full check was posted on that head. */
    posted: Map<string, string>;
    /** `number@head` -> why it went back to its author (a culprit, or it doesn't merge onto the base). */
    returned: Map<string, Step>;
    /** The base the latest base-red check found failing on its own, if any. */
    baseRed: string | null;
}
export declare const PR_BATCH_EVENTS: readonly ["pr_batch.queued", "pr_batch.step", "pr.closed"];
/** The batches and the queue, folded from the log (`pr_batch.*` and `pr.closed`; other events are ignored). */
export declare function batchState(events: StoredEvent[]): BatchState;
/** A batch as reports show it: testing, bisecting (red, being split), green, red, abandoned, or empty (nothing built). */
export type BatchStatus = 'testing' | 'bisecting' | 'green' | 'red' | 'abandoned' | 'empty';
export interface BatchSummary {
    id: string;
    status: BatchStatus;
    open: boolean;
    prs: {
        issue: number;
        number: number;
    }[];
    /** PRs whose full check this batch (or a prefix of it) posted, and the culprit(s) it returned. */
    passed: number[];
    culprits: {
        number: number;
        tier: string | null;
    }[];
    requeued: number[];
    dropped: number[];
    at: string;
    last: string;
    /** One line on what happened, for the owner's views (never a viewer's: src/viewer-events.ts). */
    detail: string;
}
/** Each batch the queue started (bisection steps folded into theirs), oldest first. */
export declare function batchSummaries(events: StoredEvent[]): BatchSummary[];
/** Where one PR head stands with the batches: queued, in a batch being tested, passed, returned, or not in them. */
export declare function prBatchStatus(events: StoredEvent[], number: number, head: string): {
    status: 'queued' | 'testing' | 'passed' | 'returned';
    batch: string | null;
} | null;
/** prBatchStatus on a batch state already folded (WHY: the Board asks it for every open PR; one fold serves them all). */
export declare function prBatchStatusIn(st: BatchState, number: number, head: string): {
    status: 'queued' | 'testing' | 'passed' | 'returned';
    batch: string | null;
} | null;
/** The pass rate assumed before there is history, and how many PRs' worth of weight it carries. */
export declare const PRIOR_PASS_RATE = 0.9;
/**
 * The share of PRs that pass the full run: of the PR heads that recently came out of a batch, those that passed (their
 * full check posted) against those found to be culprits, smoothed toward PRIOR_PASS_RATE while there is little history.
 */
export declare function passRate(st: Pick<BatchState, 'posted' | 'returned'>): number;
/**
 * Full runs per PR for a batch of k at pass rate p: the batch's one run shared by k PRs, plus, for each PR expected to
 * fail (1 - p of them), a bisection of log2(k) runs and one run to test the rest again. A batch of one is one run.
 */
export declare function runsPerPr(k: number, p: number): number;
/** The batch size with the fewest full runs per PR at this pass rate, from 1 to `max` (about ln 2 / (1 - p)). */
export declare function batchSize(p: number, max: number): number;
/**
 * May this PR merge at this head? Only with every fast check passing on the head and a passing full run from a batch
 * that held exactly this head, whose full check was posted on it. Fails closed (no fast checks configured: no).
 */
export declare function mayMerge(o: {
    events: StoredEvent[];
    number: number;
    head: string;
    checks: CommitCheck[];
    fastChecks: string[];
}): {
    ok: true;
    batch: string;
} | {
    ok: false;
    why: string;
};
/** Whose turn it is to merge in a green batch, and whether main is still what the batch tested. */
export type MergeTurn = {
    act: 'merge';
    batch: string;
} | {
    act: 'wait';
    why: string;
} | {
    act: 'stale';
    batch: string;
    prs: BatchEntry[];
    why: string;
};
/**
 * A green batch merges strictly in batch order, each PR onto exactly the commit the batch tested it on: the batch's
 * base for the first, and for each next one the merge of the PR before it, whose tree must be the batch's tree after
 * that PR. (GitHub's merge commit, `merge_method: merge`, of the head onto that tip gives the same tree the batch
 * tested.) Anything else and this PR and those after it are stale: main is no longer what was tested, so they are
 * tested again. A PR ahead of it still to merge (open at its head, its own turn pending): wait.
 */
export declare function mergeTurn(o: {
    events: StoredEvent[];
    number: number;
    head: string;
    tip: string;
    treeOf: (sha: string) => string | null;
}): MergeTurn;
/**
 * Why a run gave no verdict on the code, or null when it did (it passed, or a tier that ran failed). Cancelled,
 * interrupted or errored runs never count as red: they would start a bisection and blame a PR for nothing.
 */
export declare function noVerdict(r: TestRunResult): string | null;
/**
 * Whether a green batch's PRs are still merging (posted, not merged, not closed, not left to the owner, posted in
 * the last half hour). The next batch waits for them: built on the main they're about to change, it would be stale.
 */
export declare function mergesPending(events: StoredEvent[], now: number): boolean;
export interface PrBatchDeps {
    log: EventLog;
    instance: string;
    /** The coordinator's clone: batch commits are made here (never pushed) and the test runs read them from it. */
    repo: string;
    remote: string;
    branch: string;
    identity: {
        name: string;
        email: string;
    };
    config: () => PrBatchConfig;
    /** The test-run service (src/testrun/); null: batching can't run, so nothing merges (fail closed). */
    testRuns: TestRuns | null;
    pullRequest(n: number): Promise<PullRequest>;
    comment(n: number, body: string): Promise<void>;
    addLabels(n: number, labels: string[]): Promise<void>;
    removeLabel(n: number, label: string): Promise<void>;
    ownerOf(issue: number): string;
    /** A PR whose batch passed and whose full check is posted on its head: the merge policy decides it next. */
    tested(e: BatchEntry): void;
    /** False while a green batch's PRs are still merging (mergesPending): no new batch starts until they settle. */
    mergesSettled?(): boolean;
    /**
     * Why the merge policy would leave this PR to the owner (high-risk, money-path, or any other reason it won't
     * auto-merge), or null. Such a PR is batched alone: merging the rest around it would leave main untested.
     */
    waitsForOwner?(e: BatchEntry, pr: PullRequest): string | null;
    now?: () => number;
}
export declare class PrBatcher {
    private readonly d;
    private running;
    private recovered;
    private notWired;
    private nextTryAt;
    private stopping;
    /** The batch whose run is in flight: what drops it, and the signal that cancels its run. */
    private current;
    constructor(d: PrBatchDeps);
    /** Cancel the in-flight run: its batch is abandoned and batched again. */
    private cancel;
    /** The PR watch saw this PR: a head that moved off the one in the running batch, or a closed PR, cancels its run. */
    observe(number: number, head: string, state: string): void;
    /** Main moved off the running batch's base: its result would be stale, so its run is cancelled. */
    mainMoved(tip: string): void;
    /** The coordinator is stopping: cancel the run in flight and start nothing new. */
    stop(): void;
    private get now();
    private emit;
    private step;
    state(): BatchState;
    /** Put a PR ready on its fast checks in the queue at this head (once; not again after it was returned or dropped). */
    enqueue(e: BatchEntry): boolean;
    /** The green batch whose full check was posted on this head, or null. */
    testedIn(number: number, head: string): string | null;
    /** Why this head went back to its author, or null. */
    returnedFor(number: number, head: string): string | null;
    /** One pass: start the next batch in the background, unless one is running (or a restart left one to settle first). */
    tick(): void;
    /** Wait for the running batch (tests and graceful shutdown). */
    idle(): Promise<void>;
    /**
     * Settle every batch still open (a restart, or an error, cut its run off): a green one finishes posting its full
     * checks on the heads that haven't moved; any other is abandoned, and its PRs are back in the queue.
     */
    recover(why: string): Promise<void>;
    private nextId;
    private refOf;
    private git;
    private gitOk;
    private dropRef;
    private finish;
    /** The entries still open at the same head; each one that isn't leaves the batch (`dropped`). */
    private live;
    /** Fetch the default branch and each PR's branch; the base is the default branch's tip. */
    private fetch;
    /** Merge each entry, in order, onto `base` (merge commits, no worktree), under the batch's branch. */
    private build;
    /** One full run of `sha`, in `shards` parallel runs, as one result. Fails closed on a run of another commit or kind. */
    private test;
    private runOf;
    /** Build, test and settle one batch from the head of the queue. */
    private runOne;
    /**
     * A run with no verdict: the batch (and a bisection step in flight) is abandoned, PRs that left are dropped, and the
     * rest are batched again. Nobody is blamed. Not cancelled by us (an errored run, a setup step that failed): wait a
     * while first, and say why.
     */
    private abandon;
    private runBatch;
    /**
     * The next batch from the queue, in order: up to `size` PRs the policy would auto-merge. A PR it would leave to the
     * owner never shares a batch: at the head of the queue it is a batch of one; further back it keeps its place.
     */
    private select;
    /** These PRs' green batch no longer matches main: tested again in a later batch. */
    stale(id: string, prs: BatchEntry[], why: string): void;
    /** Post the passing full check on each head (once), then hand each PR to the merge policy. */
    private pass;
    /**
     * A red batch of one: its PR is the culprit, unless the base alone fails too (then nothing is blamed and the
     * queue waits for the default branch to move).
     */
    private bisectOne;
    private baseFails;
    /**
     * A red batch: binary search over its prefixes (each tested on the same base) for the first one that fails. The PR
     * that turns it red is the culprit; the longest green prefix before it passed in a batch that held exactly those
     * heads, so it merges; the PRs after the culprit go back in the queue to be tested again.
     */
    private bisect;
    /** The culprit goes back to its author (the issue's owner), with the failing tier; its head leaves the queue. */
    private giveBack;
    private tell;
}
/** The first failing tier of a run (a run marked failed with every tier passing reports itself). */
export declare function failingTier(r: TestRunResult): TierResult | null;
export {};
