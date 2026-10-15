import type { DoneWhenList } from './backlog/types.js';
import type { ReviewConfig } from './config/schema.js';
import { type DecisionEntry, type DecisionsSection } from './plan-decisions.js';
/** Labels that ask for a plan before building. */
export declare const PLAN_LABELS: string[];
export declare const needsPlan: (labels: string[]) => boolean;
/** The plan run may read the repo and run read-only git, nothing else. */
export declare const PLAN_TOOLS: string[];
export declare const PLAN_DISALLOWED: string[];
export declare const PLAN_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["approach", "steps", "files", "risks", "design_change", "decisions"];
    readonly properties: {
        readonly approach: {
            readonly type: "string";
            readonly description: "The approach in 2-4 sentences: what you will change and why that meets the issue and its done_when.";
        };
        readonly steps: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "The steps, in order, each small enough to check.";
        };
        readonly acceptance: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "The acceptance criteria: each a check the owner can tell is met or not once it is built. Start from the issue's done_when (every item of it is one) and add only what the issue itself asks for.";
        };
        readonly files: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Repo-relative files you expect to change or add.";
        };
        readonly risks: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "What could go wrong or break, and how the steps guard against it.";
        };
        readonly questions: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Open questions for the owner, only if a real decision is needed; the build proceeds with your best answer.";
        };
        readonly design_change: {
            readonly type: "boolean";
            readonly description: "true if the plan is design-level: a new top-level module or package, a change to a public CLI or API surface or to a file format, a new dependency, or an architecture change. The owner then approves the plan before anything is built.";
        };
        readonly design_reason: {
            readonly type: "string";
            readonly description: "When design_change is true: what about the design changes, in one sentence.";
        };
        readonly decisions: {
            readonly type: "string";
            readonly description: "The recorded decisions the plan rests on and any that argue against it, cited from the decisions index. \"Rests on:\" then one line per entry, \"- [<entry>] how the plan relies on it\"; \"Argues against:\" then one line per recorded entry that cuts against the plan, \"- [<entry>] why the plan goes ahead anyway\"; \"- none\" under a part with nothing. Or, when nothing recorded bears on the plan, the whole section is exactly \"nothing recorded on this\".";
        };
    };
};
export interface Plan {
    approach: string;
    steps: string[];
    /** The acceptance criteria the owner approves the plan against: the planner's, or the issue's done_when. */
    acceptance?: string[];
    files: string[];
    risks: string[];
    questions?: string[];
    /** The plan's own design-level flag (binding); undefined: it gave no answer, which holds the plan. */
    design_change?: boolean;
    design_reason?: string;
    /** The Decisions section, checked against the decisions index (src/plan-decisions.ts). */
    decisions: DecisionsSection;
}
/**
 * The plan contract check: a plan from the run's structured output, or why it is refused. Its Decisions section
 * must be there and cite only what the decisions index holds (`index`: the decisions made and the checkout's
 * records), or be exactly "nothing recorded on this".
 */
export declare function readPlan(s: unknown, index: readonly DecisionEntry[], doneWhen?: DoneWhenList): Plan | {
    invalid: string;
};
/** The issue's done_when as acceptance criteria, one line each. */
export declare function acceptanceOf(doneWhen: DoneWhenList): string[];
/**
 * The plan gate (config.yaml plan_gate): `always` holds every size:M/L plan for the owner's approval; `risky` only one
 * the merge policy's checks hold (`reasons`); `off` the same: it never drops the risk and design holds (the owner's
 * rule), only the gate on ordinary plans.
 */
export type PlanGate = 'always' | 'risky' | 'off';
export declare const PLAN_GATE_REASON = "plan_gate is always: a size:M/L plan waits for the owner's approval";
export declare function gateReasons(gate: PlanGate, reasons: string[]): string[];
/** The plan run's brief, after the issue: plan, don't build. */
export declare function planExtra(): string[];
/**
 * The decisions index in the planner's brief: the decisions already made (each question with the answer that
 * stands, the newest `max`), then the decision records in the checkout, each with how to cite it. What they
 * settle, the planner doesn't ask again; what bears on the plan, it cites in its Decisions section.
 */
export declare function decisionsMade(index: readonly DecisionEntry[], max?: number): string[];
/** The plan as posted on the issue: the build starts now (with how to object), or it waits for approval (`held`). */
export declare function planComment(plan: Plan, owner: string, held?: string[]): string;
/** The plan in the worker's brief. */
export declare function planBrief(plan: Plan): string[];
/**
 * The owner's (or a writer's) objection to the plan: a `/<cli> object` comment after the plan was posted.
 * `comments` in order; `after`: how many there were when the plan was posted.
 */
export declare function objection(comments: {
    author: string;
    body: string;
}[], after: number, people: string[]): {
    by: string;
    why: string;
} | null;
/**
 * Why a plan waits for the owner before anything is built: the merge policy's high-risk categories and
 * design-level checks, over the files the plan expects to change, plus its own design flag. Empty: post and
 * proceed. `existsAtBase` tells a new top-level module from an existing one.
 */
export declare function planHoldReasons(plan: Plan, o: {
    review: ReviewConfig;
    moneyPaths: RegExp[];
    existsAtBase: (path: string) => boolean;
}): string[];
export declare const PLAN_OPTIONS: readonly ["approve", "revise", "reject"];
export type PlanAnswer = (typeof PLAN_OPTIONS)[number];
/** A held plan's receipt line for each acceptance criterion (the chat post shows these). */
export declare const ACCEPTANCE_RECEIPT = "acceptance: ";
/** The owner's decision on a held plan. */
export declare function planDecision(reasons: string[], acceptance?: string[]): {
    question: string;
    options: ("approve" | "revise" | "reject")[];
    recommendation: PlanAnswer;
    receipts: string[];
};
/** What an answer to a held plan does: build with it, plan again with a note, or stop. */
export declare function planAnswer(answer: string, comment?: string): {
    act: 'build';
} | {
    act: 'replan';
    note: string;
} | {
    act: 'stop';
};
/** Plan review sends a plan back to the planner this many times, then the task is blocked with why. */
export declare const PLAN_SEND_BACKS = 1;
/** The plan reviewer's verdict: the recorded decisions the plan contradicts without naming them. */
export declare const PLAN_REVIEW_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["contradictions", "summary"];
    readonly properties: {
        readonly contradictions: {
            readonly type: "array";
            readonly description: "Each recorded decision the plan contradicts that its Decisions section does not name under \"Argues against\" with a reason. Empty when there is none.";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["ref", "why"];
                readonly properties: {
                    readonly ref: {
                        readonly type: "string";
                        readonly description: "The entry, exactly as the decisions index brackets it.";
                    };
                    readonly why: {
                        readonly type: "string";
                        readonly description: "What in the plan contradicts what the entry records, quoting both.";
                    };
                };
            };
        };
        readonly summary: {
            readonly type: "string";
            readonly description: "Your review in 1-3 sentences.";
        };
    };
};
/** The plan reviewer's brief, after the issue: the plan, the full text of every entry it cites, and the index. */
export declare function planReviewExtra(plan: Plan, index: readonly DecisionEntry[]): string[];
/**
 * What plan review sends back: each contradiction the reviewer found that names a recorded entry the plan
 * doesn't already argue against with a reason. A ref that isn't in the index is not a finding (the reviewer
 * can't invent a decision). An unreadable verdict is null (the review failed).
 */
export declare function readPlanReview(s: unknown, plan: Plan, index: readonly DecisionEntry[]): {
    ref: string;
    why: string;
}[] | null;
/** The planner's note when its plan is sent back (by the contract check or by plan review). */
export declare function sendBackNote(why: string): string[];
