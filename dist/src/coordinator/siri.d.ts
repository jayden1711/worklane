import type { EventLog } from '../events/log.js';
import type { IntakeConfig } from '../intake/report.js';
import type { AgentRunner, RunResult } from '../runner.js';
import { type SiriRequest } from '../siri/ask.js';
export declare const SIRI_OFF = "Siri is off for this instance.";
export declare const SIRI_CAPPED = "I've reached today's limit for questions. Try again tomorrow.";
export declare const SIRI_BUDGET = "Today's budget is spent, so I can't answer now.";
export declare const SIRI_FAILED = "I couldn't answer that just now.";
export declare const SIRI_PAUSED = "The agents are paused right now, so I can't answer.";
export interface SiriDeps {
    stateDir: string;
    instance: string;
    log: EventLog;
    runner: AgentRunner;
    intake: () => IntakeConfig | null;
    /** The instance root, beside the checkout (where the research lane's bundles go), and the agents' group. */
    instanceRoot: string;
    gid: number;
    /** What's left of today's budget. */
    budgetLeft: () => number;
    /** Why no run may start now (stopped, usage limit, sign-in held, disk), or null. */
    held: () => string | null;
    /** Record the run's cost (run.cost, role siri). */
    cost: (r: RunResult) => void;
    now?: () => Date;
}
/** USD spent today (UTC) on Siri answers, from the log. */
export declare function siriSpentToday(log: EventLog, now?: Date): number;
export declare function answerSiri(d: SiriDeps, q: SiriRequest): Promise<void>;
/** Every question waiting, one at a time (the returned promise is the queue's end). */
export declare function siriPass(d: SiriDeps, queue: Promise<void>): Promise<void>;
