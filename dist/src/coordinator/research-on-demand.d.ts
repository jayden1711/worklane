import type { Issue } from '../backlog/types.js';
import { MAX_REQUESTS_PER_TASK } from '../research-request.js';
import { ResearchRuns } from './research.js';
/** The run.cost role of a researcher run started for a worker's or evaluator's request. */
export declare const ON_DEMAND_COST_ROLE = "research-on-demand";
export declare abstract class ResearchOnDemand extends ResearchRuns {
    /**
     * Answer one research request from `from` on this issue. Returns the section for the resumed run's brief: the
     * cited answer, or, when there is none (refused, held by a cap or the per-task limit, or the run found nothing
     * it could cite), why, and to go on with what the repository shows. Never throws for a bad request.
     */
    protected answerResearch(issue: Issue, raw: unknown, path: string, from: 'worker' | 'evaluator'): Promise<string>;
}
export { MAX_REQUESTS_PER_TASK };
