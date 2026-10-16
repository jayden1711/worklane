import type { Actionability, Issue } from '../backlog/types.js';
import type { EventPayload } from '../events/types.js';
import { type Sample } from '../optimize.js';
import { PrHygiene } from './pr-hygiene.js';
type Pass = EventPayload<'optimize.pass'>;
export declare abstract class Optimizer extends PrHygiene {
    /** The pass in flight. */
    protected optimizeRun: Promise<void>;
    private optimizeBusy;
    private passes;
    private results;
    /** The pass that filed this issue: an optimization task is only one this instance filed and recorded. */
    protected optimizePassOf(n: number): Pass | null;
    /** The dispatcher's say for an optimization task this instance filed itself (its own log is the proof); else null. */
    protected optimizeTask(issue: Issue): Actionability | null;
    /** The week's passes: started in the 7 days before now. */
    private weekPasses;
    /** USD the week's optimization tasks have spent: every run.cost booked to their issues. */
    protected optimizeSpent(): number;
    /** What the week's optimization budget has left (a hard stop at 0). */
    protected optimizeLeft(): number;
    /** Start the pass when it is due (one at a time). */
    checkOptimize(): Promise<void>;
    /** The target's command N times in `cwd`: every run's number, or why it can't be measured. */
    private measure;
    /** Measure at a commit of the default branch, in a scratch worktree removed after. */
    private measureAt;
    private optimizePass;
    /**
     * An optimization task's change, measured before its PR: true goes on to the PR (the numbers recorded for its
     * body); false: discarded and closed with why (already done here). Main's numbers are measured again when the
     * task's base is not the commit the baseline was measured on.
     */
    protected optimizeGate(n: number, pass: Pass, path: string, base: string, head: string): Promise<boolean>;
    /** Discarded: said on the issue with the numbers, closed, and the claim and worktree released. */
    protected optimizeDiscard(n: number, why: string, before?: (Sample & {
        sha: string;
    }) | null, after?: (Sample & {
        sha: string;
    }) | null): Promise<void>;
}
export {};
