import type { Coordinator } from '../coordinator.js';
import { type CommitCheck, type PullRequest } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import { type Readiness } from '../pr-watch.js';
import { type MergeDecision } from '../merge-policy.js';
import { MergePass } from '../merge-policy-train.js';
import { type MergeIn } from '../pr-hygiene.js';
import type { ChatPerson } from '../intake/people.js';
import { PrBatcher } from './pr-batch.js';
import { FixRuns } from './fix-runs.js';
import { FlakyGate } from './flaky.js';
import { FixForward } from './fix-forward.js';
import { PollCounter } from './wait-caps.js';
export declare abstract class MergeFlow extends FixRuns {
    /** Defined in a later part (or in Coordinator); declared here for the calls in this one. */
    protected abstract combinedGate(...args: Parameters<Coordinator['combinedGate']>): ReturnType<Coordinator['combinedGate']>;
    /** Polls of the merge flow's capped waits (wait-caps.ts). */
    protected readonly waitPolls: PollCounter;
    private batcher;
    private flakyGateInst;
    private fixForwardInst;
    /** The flaky-test gate in front of a red default branch (coordinator/flaky.ts): re-run first, quarantine what passes. */
    protected get flakyGate(): FlakyGate;
    /** Fix-forward on a real red default branch (coordinator/fix-forward.ts): the culprit, fix tasks, the revert if they fail. */
    protected get fixForward(): FixForward;
    /** Fix-forward's pass: the open red default branch moved on, and its ops posts. */
    protected fixForwardStep(): Promise<void>;
    /** The merge train: this pass's merges, up to tests.yaml land.parallel_merges. */
    protected readonly mergePass: MergePass;
    /** The merge train's clock for deferrals (tests move it). */
    protected trainNow: () => number;
    /** PR mode with batching on (tests.yaml land.pr_batch): ready PRs are tested together before any merges. */
    protected prBatching(): boolean;
    protected get prBatch(): PrBatcher;
    /** Start the next PR batch in the background (one at a time). */
    protected prBatchTick(): void;
    /** When each person's PR was last looked at (its fast checks), by number. */
    private readonly peoplePolled;
    /**
     * People's PRs into the default branch join the batch queue: once their fast checks pass on the head, a PR opened
     * by a mapped admin or writer (their role from their repo permission) gets the same sharded full run, and the full
     * check posted on its head. A bot's or an unmapped author's stays fast-only until an admin approves it. The harness
     * never merges any of them (the merge policy refuses a PR it didn't open): the person does, once it's green. From
     * the test runs' own listing of open PRs: no listing of its own.
     */
    protected batchPeoplesPrs(): Promise<void>;
    /** An admin's (owner's) latest review on the PR approves it. */
    private adminApproved;
    /** Wait for a running PR batch. */
    /** The coordinator is stopping: cancel a batch run in flight. */
    protected prBatchStop(): void;
    protected prBatchIdle(): Promise<void>;
    /** Open PRs this instance opened: the latest pr.opened per number, without a pr.closed after it. */
    watchedPrs(): EventPayload<'pr.opened'>[];
    /**
     * Each watched PR, at most once per poll interval and a few per tick: read its head and the checks on it,
     * record changes, and mark it ready (out of draft, labelled merge-ready) once every required check passed
     * on the exact commit the evaluator approved. A head that moves after that takes the label off again.
     */
    protected watchPrs(): Promise<void>;
    private watchPr;
    /** A PR ready on its fast checks: the merge policy once a batch with this head passed, else the batch queue. */
    private batchOrMerge;
    /** The PR's size and comment count as the tracker reports them, recorded only when they change (the dashboard's board reads them). */
    private notePrStats;
    private get stopFile();
    /** Why auto-merge is stopped for this instance, or null. Persisted in a file only the operator clears. */
    autoMergeStopped(): string | null;
    /** Whether this instance opened PR `number` (a pr.opened event of its own). */
    private openedByUs;
    /**
     * The only way the harness merges: GitHub's merge API, pinned to the head, and never for a PR it didn't open or a
     * revert it opened (neverAutoMerge), whatever led here.
     */
    private mergeOurs;
    /**
     * The merge train's one door to mergeOurs (src/merge-policy-train.ts): within this pass's cap (a PR over it merges
     * on the next pass); at the head GitHub reports right now, since an earlier merge of the pass or a push may have
     * moved it (a moved head is never merged: it is decided afresh); and a branch GitHub calls behind its base (strict
     * protection) or a base that moved mid-merge is put off with a backoff, never retried in a loop and never made to
     * merge the default branch in. null: not merged this pass, nothing to record; a failure is the caller's to record.
     */
    private trainMerge;
    private deferrals;
    /** PR `number` at `head` was put off and its retry time hasn't come. */
    protected mergeDeferred(number: number, head: string): boolean;
    /**
     * Put off merging PR `number` at this head, for longer each time (deferDelay). The first time a head is put off as
     * behind, one comment says why and what lets it through; the owner isn't asked: it isn't theirs to decide.
     */
    private deferMerge;
    /** The policy's call on a ready PR at its current head. */
    mergeDecisionFor(n: number, number: number, pr: PullRequest): MergeDecision;
    /**
     * A ready PR: merge it (a merge commit, pinned to the evaluated head) when the policy allows and GitHub says
     * it merges cleanly; otherwise ask the owner once per head, saying why.
     */
    private mergeOrWait;
    /**
     * Batching: merge a PR only as tested. Both checks on this exact head (mayMerge), and main exactly what its green
     * batch tested it on, in batch order (mergeTurn); a main that moved otherwise sends it, and the PRs after it, back to
     * be tested again. Merged with a merge commit (merge_method: merge, pinned to the head), whose tree is the tested one.
     */
    private mergeTested;
    /**
     * An owner's approval from a Discord thread, of PR `number` waiting for an owner at `head` (src/coordinator/
     * channel.ts): the same checks as a merge, now, before anything is recorded: an open PR this instance opened,
     * waiting for an owner at exactly this head (unchanged since the decision), its required checks green on it, no
     * emergency stop and auto-merge not stopped (the main watch). Recorded through decide (approveMerge: an owner only,
     * audited via discord); the PR watch then looks at it on its next pass, where mergeApproved merges it.
     */
    protected chatApproveMerge(number: number, head: string, who: ChatPerson): Promise<{
        ok: true;
    } | {
        ok: false;
        already?: {
            answer: string;
            by: string;
        };
        error?: string;
    }>;
    /**
     * Merge a PR an owner approved from Discord at this head, through the normal merge path: nothing under an emergency
     * stop or a stopped auto-merge; GitHub must say it merges cleanly; batching, exactly as tested (mergeTested); else
     * the combined check of main into it first, then GitHub's merge API pinned to the head (mergeOurs, which still
     * never merges a PR the harness didn't open or a revert). A hold is recorded once per head and reason.
     */
    private mergeApproved;
    /** The owner's latest review on the PR approves it, given since this head was queued for a batch. */
    private ownerApproved;
    /** A PR that waits for the owner: the needs-owner label, one comment with every reason, a review request. */
    private waitForOwner;
    /**
     * After each auto-merge, the default branch's required checks on its merge commit. Red, with the commit
     * before it green: stop auto-merging on this instance, open a revert PR and tell the owner. Red with main
     * already red before it: stop and tell, nothing to revert. A stop lasts until the operator clears it.
     */
    protected watchMerges(): Promise<void>;
    /** A real red after auto-merging `m`: fix-forward takes it (coordinator/fix-forward.ts), unless the branch was red already. */
    private mainWentRed;
    private get stopResume();
    /** Who is told about a red default branch: the owner of the issue behind one of `shas` (a harness merge), else the default owner. */
    private redOwner;
    private stopFor;
    /**
     * Fix-forward reverts the culprit: a revert PR (git revert -m 1 on the current tip, through the push checks; never
     * watched, never auto-merged) with the evidence, auto-merge stopped until the operator clears it, and the owner told
     * on the PR that went red, the culprit's PR and the revert.
     */
    private fixForwardRevert;
    /** Fix-forward can neither fix nor revert: auto-merge stopped until the operator clears it, and the owner told. */
    private fixForwardGaveUp;
    /**
     * One ops post (intake.yaml discord.ops_channel), once per key, within the machine-wide limit of ops posts
     * (watchdog/post.ts takeOpsPost): sent (or had been), limited (a later pass tries again), off (nowhere to post).
     */
    private opsPost;
    /**
     * A revert PR of commit `sha` on the current tip (`-m 1` for a merge commit), on `<cli>/revert-<name>`, through the
     * push checks. The merge policy never auto-merges a revert branch (neverAutoMerge), and it is never watched.
     */
    private openRevertOf;
    private mainWatcher;
    /** The main watch's state: its mode, the last commit it checked, the call it is waiting on (src/main-watch.ts). */
    protected get mainWatchFile(): string;
    /**
     * The default branch with no protection on GitHub: check each new commit on it (at most one API call a minute).
     * PR mode only: with land_mode direct, the harness lands by pushing the default branch itself.
     */
    protected watchMain(): Promise<void>;
    /**
     * A commit on the default branch nothing accounts for: stop auto-merge at once (the stop file, until an admin clears
     * it on the dashboard), then alert (main_watch.unaccounted: the dashboard; the asks channel posts it) and open a revert
     * PR for a human. Once per commit, even across a restart.
     */
    private mainUnaccounted;
    /**
     * A commit that landed without a PR (src/direct-push-alert.ts): who pushed it (one API call: a GitHub login, never
     * an email) and its subject (git), recorded once (main_watch.direct_push); then its ops post, unless turned off.
     */
    private directPushNoted;
    /**
     * Post each direct push's alert not posted yet to the ops channel, once per commit, mentioning the Discord owners,
     * within the machine-wide limit of ops posts (what is over it waits for a later pass). Turned off (`alert` false):
     * never posted. No ops channel: not posted, and the dashboard says why (recorded once).
     */
    protected directPushOutbound(): Promise<void>;
    /** Merge the default branch into the PR head in a scratch worktree and run the fast tier there. Nothing is pushed. */
    protected lightCheck(w: EventPayload<'pr.opened'>, pr: PullRequest, baseRef: string, mainSha: string, overlap: string[]): Promise<void>;
    /** The worker's own risk class for the issue's change (worker.claims), if it gave one. */
    private claimedClass;
    /**
     * The required checks the harness's own merge call waits on at this head: every one, or for a docs-only change
     * (its paths, raised by the worker's claim) the light ones, review.yaml docs_only_checks (src/pr-rules.ts).
     */
    protected checksPlan(n: number, head: string): {
        checks: string[];
        fast: boolean;
    };
    /**
     * The readiness of an issue's PR at `head`, against the latest evaluator verdict for the issue; `except`: required
     * checks left out. A verdict on the head the harness merged the default branch into (a clean stale-PR merge-in,
     * src/pr-hygiene.ts) holds for the merge-in; its required checks still have to pass on it.
     */
    prReadiness(n: number, head: string, checks: CommitCheck[], except?: string[]): Readiness;
    /** The stale-PR merge-ins this instance pushed (pr_hygiene.merged_in), oldest first. */
    protected mergeInsOf(): MergeIn[];
}
