import type { PrReview, PrReviewComment } from './backlog/types.js';
import type { RunResult } from './runner.js';
/** One writer's review a fix run answers: its summary and its inline comments. */
export interface ReviewFeedback {
    id: number;
    author: string;
    state: 'CHANGES_REQUESTED' | 'COMMENTED';
    body: string;
    comments: {
        path: string;
        line: number | null;
        body: string;
    }[];
    at: string;
}
/**
 * The reviews a fix run should answer: a writer's review that requests changes, or that comments with something to
 * say (a summary or an inline comment), not yet handled. Approvals, dismissed reviews, anyone who isn't a writer, and
 * the harness's own words never start one.
 */
export declare function reviewFeedback(o: {
    reviews: PrReview[];
    comments: PrReviewComment[];
    writers: string[];
    handled: ReadonlySet<number>;
}): ReviewFeedback[];
/** What the fix run is told: each review, its summary and its inline comments by file and line. Bounded. */
export declare function reviewBrief(f: ReviewFeedback[]): string[];
/**
 * A resumed run that never got going: claude ended it at turn 0 without a transient error to wait out ("No
 * conversation found with session ID", the session's file is gone, or it can't be read). A fresh run takes over.
 */
export declare const resumeFailed: (r: RunResult) => boolean;
