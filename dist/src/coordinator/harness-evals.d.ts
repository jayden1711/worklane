import { SuperfanWatch } from './superfan.js';
/** Under this much budget left, a run can't replay anything: it is recorded as not run. */
export declare const MIN_EVAL_USD = 0.5;
export declare abstract class HarnessEvals extends SuperfanWatch {
    /** The harness eval run in flight. */
    protected harnessEvalRun: Promise<void>;
    private harnessEvalBusy;
    /** Start a harness eval run when one is due (one at a time). Off unless harness_evals.enabled. */
    checkHarnessEvals(): Promise<void>;
    /**
     * The PR whose merge is this engine commit, when this instance's repository is the engine's own and its merge
     * subject names one ("Merge #N: ...", "Merge pull request #N ..."). Otherwise null: nothing is posted.
     */
    private mergedPrOf;
    private evalHarness;
    /** Post a run's scores on the PR that triggered it, beside the last baseline's. */
    private postEvalResults;
}
