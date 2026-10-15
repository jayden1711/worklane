import type { Coordinator } from '../coordinator.js';
import { type PullRequest } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import { type Readiness } from '../pr-watch.js';
import { Landing } from './landing.js';
import { type RunRequest, type RunResult } from '../runner.js';
/** How often the harness's open PRs are read for new reviews (each PR's reviews: one GitHub call). */
export declare const REVIEW_FIX_POLL_MS: number;
export declare abstract class FixRuns extends Landing {
    /** Defined in a later part (or in Coordinator); declared here for the calls in this one. */
    protected abstract inspect(...args: Parameters<Coordinator['inspect']>): ReturnType<Coordinator['inspect']>;
    protected abstract verify(...args: Parameters<Coordinator['verify']>): ReturnType<Coordinator['verify']>;
    protected abstract evaluate(...args: Parameters<Coordinator['evaluate']>): ReturnType<Coordinator['evaluate']>;
    abstract watchedPrs(): EventPayload<'pr.opened'>[];
    private reviewFixesPolledAt;
    /**
     * The claude session that wrote this issue's change: the latest worker or fix run on it that succeeded and
     * reported a session. A fix run resumes it, so CI failures, conflicts and reviews go back to the context that made
     * the change rather than to a fresh agent.
     */
    protected writerSession(n: number): string | null;
    /**
     * A fix run's agent: resumes the writing session with `resumed` (the new instructions only: the session already
     * has the issue's brief), and falls back to a fresh session with `fresh` (the whole brief) when none is stored or
     * the resume fails to start. Same request otherwise, so the same lane and OS user: the session lives in that
     * user's home. Records which happened on run.finished (`resume`), and each run's session (`session`).
     */
    protected runFix(n: number, role: string, model: string, path: string, attempt: number, req: Omit<RunRequest, 'prompt' | 'resume' | 'onStart'>, prompts: {
        fresh: string;
        resumed: string;
    }): Promise<RunResult>;
    /**
     * A fix run found the issue's claim held elsewhere. The first time for this PR head it is recorded (`record`);
     * it never counts toward the fix cap, so a brief collision costs nothing. Only once the claim has been held
     * elsewhere for CLAIM_HELD_GIVE_UP_MS since that first record does this say to give up.
     */
    private claimHeldTooLong;
    protected fixGaveUp(number: number): boolean;
    /** The last commit the harness itself put on a PR's branch: the head it opened with, its latest pushed fix, or a stale-PR merge-in. */
    protected ourHead(number: number): string | null;
    /**
     * A required check failed on a watched PR: start a fix run on its branch, within the cap, or give up and ask
     * the owner. Never on a branch someone else pushed to, and never without the failing job's log (a fix that
     * can't see why CI failed would be a guess).
     */
    protected maybeFix(w: EventPayload<'pr.opened'>, pr: PullRequest, r: Readiness): Promise<void>;
    /** No more fix runs on this PR: say why on it, label it, and ask the owner to review. */
    private giveUpFix;
    /** Reviews already answered on a PR: a fix run started for them, or the owner was told why none would. */
    private handledReviews;
    /**
     * A writer's review on one of the harness's own open PRs (changes requested, or a comment with something to say)
     * goes back to the session that wrote the change, as a fix run with the review's text: the same pipeline and the
     * same per-PR cap as a CI fix (roles.ci_repair). Only PRs the harness opened are read; a person's PR never is.
     * Polled every REVIEW_FIX_POLL_MS.
     */
    watchReviewFixes(): Promise<void>;
    /** Start a review fix run within the cap, or tell the owner (once per review) why there is none. */
    private maybeFixReview;
    /** A review that gets no (more) fix: say why on the PR, label it, and ask the owner to review. */
    private giveUpReview;
    /**
     * One fix run: reclaim the issue, a worktree at the PR's head, a worker with the failing logs, then the
     * usual inspect, verify and evaluate on the whole change, and a push to the same branch only if it is still
     * at the head the run started from. Anything short of that gives up and asks the owner.
     */
    private fixRun;
    /**
     * The fix run's worker: the session that wrote the change, resumed with the failing logs or the reviews (a fresh
     * one gets the issue's brief too). Ends with its answer, or why it stopped.
     */
    private fixAgent;
    /**
     * GitHub reports a watched PR as conflicting with its base: merge the base into the branch and let a worker
     * resolve the conflicted hunks, within the cap; otherwise ask the owner. Never on a branch someone else
     * pushed to. Recorded once per head and base as conflict_fix.detected; the owner is asked once per head.
     */
    protected maybeFixConflict(w: EventPayload<'pr.opened'>, pr: PullRequest): Promise<void>;
    /** No (more) conflict fixes on this PR: say why on it, label it, ask the owner to review. */
    private giveUpConflict;
    /** git, returning null instead of throwing (a path missing at a commit, an unmerged index entry). */
    protected gitOrNull(cwd: string, ...args: string[]): string | null;
    /** What the base branch changed in the conflicted files since the PR branched: each commit's subject and body. */
    private baseSides;
    /**
     * One conflict fix: reclaim the issue, a worktree at the PR's head, merge the base in (a merge commit), a
     * worker for the conflicted hunks, then inspect, verify and evaluate against the new base (with the
     * resolution diff given to the evaluator separately), and a push to the same branch only if it is still at
     * the head the run started from. The merge policy then decides from scratch on the new head.
     */
    private conflictRun;
    /** The conflict fix's worker: the issue's brief plus the conflicted hunks and both sides' intent. */
    private conflictAgent;
}
