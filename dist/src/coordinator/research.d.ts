import { type Issue } from '../backlog/types.js';
import { type ResearchResult, type ResearchStep } from '../research.js';
import { CoordinatorBase } from './base.js';
export declare abstract class ResearchRuns extends CoordinatorBase {
    /**
     * A research run for an issue: web only (WebSearch, WebFetch), within the instance's daily caps, and without the
     * repo unless the owner turned repo access on (then it reads this task's worktree, read-only). Without it, the run
     * works in a per-run bundle (the issue and its questions) and its lane denies every read of the checkout. Every
     * search and fetch is recorded from the run's own stream; reaching a cap stops it. Only a report with linked
     * sources is taken, and posted on the issue. Returns null once the report is posted, else why there is none.
     */
    protected research(issue: Issue, questions: string[], path: string): Promise<string | null>;
    /**
     * One researcher run on `questions`, as `research` describes, booked to `costRole`: its accepted report with the
     * steps it took, or why there is none (a cap, a failed run, a report that isn't accepted). Posts nothing.
     */
    protected runResearcher(issue: Issue, questions: string[], path: string, costRole: string): Promise<{
        ok: true;
        result: ResearchResult;
        ignored: string[];
        steps: ResearchStep[];
        run: string | null;
    } | {
        ok: false;
        why: string;
    }>;
    /** The latest research report on an issue, for a later run's brief: web-sourced, so marked as data to check. */
    protected researchNote(issue: number): string[];
}
