import { type HygieneCounts } from '../pr-hygiene.js';
import { Gardener } from './gardener.js';
export declare abstract class PrHygiene extends Gardener {
    /** The pass's clock (tests move it). */
    protected hygieneNow: () => number;
    /** Run the pass when it is due (PR mode, turned on, and no emergency stop). */
    checkPrHygiene(): Promise<HygieneCounts | null>;
    /** One pass over every open PR this instance opened; records and returns the counts. */
    prHygienePass(): Promise<HygieneCounts | null>;
    private hygieneFor;
    /** Whether PR `number` waits in the batch queue or is in an open batch: a new head would cancel its run. */
    private inPrBatch;
    /** Merge the default branch at `tip` into the PR's head and push it to the PR's branch (pinned to the head read). */
    private mergeIn;
}
