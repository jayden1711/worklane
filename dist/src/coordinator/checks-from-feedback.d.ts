import { type CheckMode } from '../checks-from-feedback.js';
import { Optimizer } from './optimize.js';
/** The drafting run reads the repo and writes only files (no shell beyond git's read commands and ast-grep). */
export declare const FEEDBACK_CHECK_TOOLS: string[];
export declare const FEEDBACK_CHECK_DISALLOWED: string[];
export declare abstract class ChecksFromFeedback extends Optimizer {
    /** The proposal in flight (one at a time). */
    protected feedbackChecksRun: Promise<void>;
    private feedbackChecksBusy;
    /** Start the next constraint's proposal, when one is due and none is running. */
    checkFeedbackChecks(): Promise<void>;
    /** Files the evidence is about: those its PRs' changes touched, and paths the words name. */
    private evidencePaths;
    private proposeCheck;
    /** A protected area: an issue for a person to decide the check (never `ready`: no agent builds it). */
    private fileIssue;
}
/** Where the check goes: ast-grep's rule and test dirs when the checkout has sgconfig.yml with a rule dir, else a test. */
export declare function checkMode(dir: string): CheckMode;
