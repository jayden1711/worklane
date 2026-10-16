import { type DoneWhenList, type Issue } from '../backlog/types.js';
import { type RefusedRequest } from '../domain-requests.js';
import { type Plan } from '../plan-mode.js';
import { Recovery } from './recovery.js';
export declare abstract class Decisions extends Recovery {
    /** Decisions answered by CLI (decision.answered) or by a writer's `/<cli> <option>` comment. */
    /**
     * The plan for a size:M/L task. After the owner approved a held plan: that plan. Otherwise a read-only plan
     * run (with the owner's note after a revise), posted on the issue; the plan gate holds it as the owner's
     * decision (every plan under plan_gate always; under risky, one touching high-risk or design-level areas): the
     * claim is released and the task stops ('stop') before any worker runs.
     */
    protected planStep(issue: Issue, doneWhen: DoneWhenList, path: string, base: string, owner: string): Promise<{
        plan: Plan;
        commentsAt: number;
    } | {
        stop: true;
    }>;
    /** One read-only plan run: the planner, or the plan reviewer (its own instructions are in `extra`). */
    private planRun;
    /**
     * Plan review: a fresh read-only run gets the plan, the full text of every entry it cites and the decisions
     * index, and names each recorded decision the plan contradicts without arguing against it. Null: it passes;
     * sendBack: why it goes back to the planner; block: the review couldn't run. With nothing recorded at all there
     * is nothing to contradict, and no review runs.
     */
    private planReview;
    /** An objection to a plan that is being built: the task stops (blocked, saying who objected and why). */
    protected planObjected(n: number, owner: string, commentsAt: number): Promise<boolean>;
    /** The owner's answer on a held plan: approve and revise put the task back to ready; reject stops it. */
    private handlePlanDecision;
    /** Each newly refused host for a task: recorded, and asked of the owner, once per task and host. */
    protected noteRefusedHosts(issue: number, role: string, run: string | null, refused: RefusedRequest[]): Promise<void>;
    /** The owner's answer on a refused host: recorded, and an allow-repo answer opens the config change as a PR. */
    private handleDomainDecision;
    /**
     * The guardrails change that allows a host for this repo, opened as a pull request on its own branch (built
     * from the default branch with git plumbing: no worktree, no setup). Never applied in place.
     */
    private proposeAllowedHost;
    protected handleDecisions(): Promise<void>;
    /** Answers to this issue's earlier questions, for the next worker's brief. */
    protected answers(issue: number): string[];
}
