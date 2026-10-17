import type { DoneWhenList, Issue } from './backlog/types.js';
/** How sure a claim is (src/claim-labels.ts): measured (run and read), inferred (reasoned, not run) or guess. */
export declare const CLAIM_LABELS: readonly ["measured", "inferred", "guess"];
export type ClaimLabel = (typeof CLAIM_LABELS)[number];
/** The output-schema field the worker and the evaluator fill. */
export declare const LABELED_CLAIMS_FIELD: {
    readonly claims: {
        readonly type: "array";
        readonly description: "Every claim you make, each labeled: measured (you ran the command or check and read its output: basis names it and what it showed), inferred (reasoned from code or evidence you read, not run: basis says from what) or guess (basis says why you could not check it).";
        readonly items: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["claim", "label", "basis"];
            readonly properties: {
                readonly claim: {
                    readonly type: "string";
                    readonly maxLength: 500;
                };
                readonly label: {
                    readonly type: "string";
                    readonly enum: readonly ["measured", "inferred", "guess"];
                };
                readonly basis: {
                    readonly type: "string";
                    readonly maxLength: 500;
                };
            };
        };
    };
};
/** A worker's or evaluator's research request: one precise question instead of a guess (src/research-request.ts). */
export declare const RESEARCH_REQUEST_FIELD: {
    readonly research_request: {
        readonly type: "object";
        readonly description: "Instead of guessing: one precise question that needs current outside information (docs, versions, an API), and why the task needs it.";
        readonly properties: {
            readonly question: {
                readonly type: "string";
                readonly maxLength: 500;
            };
            readonly why: {
                readonly type: "string";
                readonly maxLength: 500;
            };
        };
        readonly required: readonly ["question", "why"];
        readonly additionalProperties: false;
    };
};
export declare const WORKER_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["summary", "claims"];
    readonly properties: {
        readonly research_request: {
            readonly type: "object";
            readonly description: "Instead of guessing: one precise question that needs current outside information (docs, versions, an API), and why the task needs it.";
            readonly properties: {
                readonly question: {
                    readonly type: "string";
                    readonly maxLength: 500;
                };
                readonly why: {
                    readonly type: "string";
                    readonly maxLength: 500;
                };
            };
            readonly required: readonly ["question", "why"];
            readonly additionalProperties: false;
        };
        readonly blocked: {
            readonly type: "string";
            readonly description: "Set only if you could not finish: what blocks you.";
        };
        readonly no_change_needed: {
            readonly type: "string";
            readonly description: "Set only if the issue needs no change: its done_when already passes on the unchanged code. Say what you checked and why nothing should change. Commit nothing.";
        };
        readonly ask: {
            readonly type: "object";
            readonly description: "Set only for a real decision the owner must make.";
            readonly additionalProperties: false;
            readonly required: readonly ["question", "options", "recommendation"];
            readonly properties: {
                readonly question: {
                    readonly type: "string";
                };
                readonly options: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                    readonly description: "The answers the owner picks from: each a short word or phrase.";
                };
                readonly recommendation: {
                    readonly type: "string";
                    readonly description: "The option you recommend, copied exactly from options. No reasoning here: that goes in detail.";
                };
                readonly detail: {
                    readonly type: "string";
                    readonly description: "Why you recommend that option, and what the owner needs to know to choose.";
                };
            };
        };
        readonly raise_review: {
            readonly type: "string";
            readonly enum: readonly ["L1", "L2", "L3"];
            readonly description: "Ask for more review than the computed level, with your reason in summary.";
        };
        readonly intent: {
            readonly type: "string";
            readonly description: "One paragraph for the top of the PR: what this change is for and what it changes, for a reviewer who hasn't read the issue.";
        };
        readonly risk_class: {
            readonly type: "string";
            readonly enum: readonly ["docs-only", "logic", "protected"];
            readonly description: "Your view of the risk: protected if it touches the money path, auth, secrets, rulesets, CI, setup scripts or the merge rules. The class is computed from the changed paths; yours can only raise it.";
        };
        readonly claims: {
            readonly type: "array";
            readonly description: "Every claim you make, each labeled: measured (you ran the command or check and read its output: basis names it and what it showed), inferred (reasoned from code or evidence you read, not run: basis says from what) or guess (basis says why you could not check it).";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["claim", "label", "basis"];
                readonly properties: {
                    readonly claim: {
                        readonly type: "string";
                        readonly maxLength: 500;
                    };
                    readonly label: {
                        readonly type: "string";
                        readonly enum: readonly ["measured", "inferred", "guess"];
                    };
                    readonly basis: {
                        readonly type: "string";
                        readonly maxLength: 500;
                    };
                };
            };
        };
        readonly summary: {
            readonly type: "string";
            readonly description: "What you changed and how you verified it, in 2-5 sentences.";
        };
    };
};
export declare const REPRO_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["test_path", "explanation"];
    readonly properties: {
        readonly test_path: {
            readonly type: "string";
            readonly description: "Repo-relative path of the reproduction test you wrote.";
        };
        readonly explanation: {
            readonly type: "string";
            readonly description: "Why this test fails on the current code for the reason the issue describes.";
        };
        readonly not_reproducible: {
            readonly type: "string";
            readonly description: "Set instead of writing a test if the issue cannot be reproduced by a test (and why).";
        };
    };
};
export declare const REFLECTION_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["what_failed", "what_to_change"];
    readonly properties: {
        readonly what_failed: {
            readonly type: "string";
            readonly description: "Why the last attempt failed, in one to three sentences, quoting the check, error or advice it rests on.";
        };
        readonly what_to_change: {
            readonly type: "string";
            readonly description: "What the next attempt should do differently, concretely (the file, function or approach), in one to three sentences.";
        };
    };
};
/**
 * The actors the evaluator answers the "compromised component" question for, on a change to a protected surface:
 * each by its key and in plain words. Any further actor the change exposes it to answers as OTHER_ACTOR.
 */
export declare const COMPROMISED_ACTORS: readonly [readonly ["agent-user", "the agent user (the account agents run as)"], readonly ["coordinator", "the coordinator user and its dashboard"], readonly ["other-instance", "another instance's coordinator"], readonly ["hub-viewer", "a hub viewer"], readonly ["local-os-user", "a local OS user"]];
export declare const OTHER_ACTOR = "other";
export declare const VERDICT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["patch_correct", "test_correct", "confidence", "confidence_reason", "advice", "files_reviewed", "design_change", "claims"];
    readonly properties: {
        readonly research_request: {
            readonly type: "object";
            readonly description: "Instead of guessing: one precise question that needs current outside information (docs, versions, an API), and why the task needs it.";
            readonly properties: {
                readonly question: {
                    readonly type: "string";
                    readonly maxLength: 500;
                };
                readonly why: {
                    readonly type: "string";
                    readonly maxLength: 500;
                };
            };
            readonly required: readonly ["question", "why"];
            readonly additionalProperties: false;
        };
        readonly files_reviewed: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Every changed file whose diff you read in full (repo-relative paths).";
        };
        readonly patch_correct: {
            readonly type: "boolean";
            readonly description: "The change does what the issue and done_when ask, without breaking anything else you can see.";
        };
        readonly test_correct: {
            readonly type: "boolean";
            readonly description: "The reproduction test checks the right behavior (false if the test itself is wrong).";
        };
        readonly confidence: {
            readonly type: "string";
            readonly enum: readonly ["high", "medium", "low"];
            readonly description: "high: you read every changed file in full, the change does what the issue and done_when ask, the reproduction test and the coordinator's checks passed, and you see no risk outside the diff (a small change that meets all of this is high). medium: one specific thing is unverified. low: you found a likely problem.";
        };
        readonly confidence_reason: {
            readonly type: "string";
            readonly description: "When confidence is not high: one sentence naming the specific unverified thing (medium) or the likely problem (low). A verdict without it is refused. Empty when high.";
        };
        readonly compromised_component: {
            readonly type: "array";
            readonly description: "Only when the brief says the change touches a PROTECTED SURFACE: one answer per actor the brief lists, plus any other actor the change exposes it to.";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["actor", "can_do", "acceptable", "why"];
                readonly properties: {
                    readonly actor: {
                        readonly type: "string";
                        readonly enum: readonly [...("coordinator" | "agent-user" | "other-instance" | "hub-viewer" | "local-os-user")[], "other"];
                    };
                    readonly can_do: {
                        readonly type: "string";
                        readonly description: "What this actor can do through the change if it is compromised or hostile (\"nothing: it cannot reach it\", and why, if so).";
                    };
                    readonly acceptable: {
                        readonly type: "boolean";
                        readonly description: "Whether that is acceptable.";
                    };
                    readonly why: {
                        readonly type: "string";
                        readonly description: "Why it is acceptable, or what stops it; or why it is not.";
                    };
                };
            };
        };
        readonly advice: {
            readonly type: "string";
            readonly description: "What is wrong and how to fix it (patch or test). Empty if nothing.";
        };
        readonly design_change: {
            readonly type: "boolean";
            readonly description: "true if the change is design-level: a new top-level module or package, a change to a public CLI or API surface or to a file format, a new dependency, or an architecture change. A human then reviews it before it merges.";
        };
        readonly design_reason: {
            readonly type: "string";
            readonly description: "When design_change is true: what about the design changes, in one sentence.";
        };
        readonly claims: {
            readonly type: "array";
            readonly description: "Every claim you make, each labeled: measured (you ran the command or check and read its output: basis names it and what it showed), inferred (reasoned from code or evidence you read, not run: basis says from what) or guess (basis says why you could not check it).";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["claim", "label", "basis"];
                readonly properties: {
                    readonly claim: {
                        readonly type: "string";
                        readonly maxLength: 500;
                    };
                    readonly label: {
                        readonly type: "string";
                        readonly enum: readonly ["measured", "inferred", "guess"];
                    };
                    readonly basis: {
                        readonly type: "string";
                        readonly maxLength: 500;
                    };
                };
            };
        };
    };
};
/** What the owner chooses from after an investigation; the investigator recommends one (`recommended`). */
export declare const INVESTIGATION_OPTIONS: readonly ["approve-fix", "investigate-more", "close"];
export declare const INVESTIGATION_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["summary", "findings", "recommendation", "recommended", "confidence"];
    readonly properties: {
        readonly summary: {
            readonly type: "string";
            readonly description: "The answer in 2-4 sentences.";
        };
        readonly findings: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["claim", "evidence"];
                readonly properties: {
                    readonly claim: {
                        readonly type: "string";
                    };
                    readonly evidence: {
                        readonly type: "string";
                        readonly description: "file:line, a command and its output, or a query and its result. No claim without evidence.";
                    };
                };
            };
        };
        readonly recommendation: {
            readonly type: "string";
            readonly description: "What should happen next (a fix, more investigation, or nothing) and why, for the owner to decide.";
        };
        readonly recommended: {
            readonly type: "string";
            readonly enum: readonly ["approve-fix", "investigate-more", "close"];
            readonly description: "The one option you recommend to the owner: approve-fix (make the fix), investigate-more, or close (nothing to do). Just the option; your reasoning goes in recommendation.";
        };
        readonly confidence: {
            readonly type: "string";
            readonly enum: readonly ["high", "medium", "low"];
        };
        readonly unverified: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Anything you could not confirm.";
        };
    };
};
/** The chat's running summary: these headings, in this order, every turn (chat-summary.ts keeps it). */
export declare const SUMMARY_HEADINGS: readonly [readonly ["goal", "Goal"], readonly ["files_touched", "Files touched"], readonly ["done", "Done"], readonly ["pending", "Pending"], readonly ["errors_fixes", "Errors & fixes"], readonly ["current_state", "Current state"], readonly ["next_step", "Next step"]];
/** The dashboard chat's answer (chief_of_staff role): text with its sources, and proposals for the owner to confirm. */
export declare const CHAT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["answer", "citations", "summary"];
    readonly properties: {
        readonly summary: {
            readonly type: "object";
            readonly description: "The conversation summary, updated for this turn: keep what still holds, change what changed, drop what no longer matters. Each section a few short lines.";
            readonly additionalProperties: false;
            readonly required: ("done" | "pending" | "goal" | "files_touched" | "errors_fixes" | "current_state" | "next_step")[];
            readonly properties: {
                [k: string]: {
                    type: string;
                    description: "Goal" | "Files touched" | "Done" | "Pending" | "Errors & fixes" | "Current state" | "Next step";
                };
            };
        };
        readonly answer: {
            readonly type: "string";
            readonly description: "The answer, in plain sentences. Say what you could not find rather than guess.";
        };
        readonly citations: {
            readonly type: "array";
            readonly description: "Every event, run, pull request or issue the answer relies on, by the id shown in the context files.";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["kind", "id"];
                readonly properties: {
                    readonly kind: {
                        readonly type: "string";
                        readonly enum: readonly ["event", "run", "pr", "issue"];
                    };
                    readonly id: {
                        readonly type: "string";
                    };
                };
            };
        };
        readonly issue_draft: {
            readonly type: "object";
            readonly description: "Only when asked to draft an issue: its title and body, the body in five parts (**Outcome:**, **Sources:**, **Constraints:**, **Deliverable:** with the ```done_when block, **Review point:**).";
            readonly additionalProperties: false;
            readonly required: readonly ["title", "body"];
            readonly properties: {
                readonly title: {
                    readonly type: "string";
                };
                readonly body: {
                    readonly type: "string";
                };
            };
        };
        readonly actions: {
            readonly type: "array";
            readonly description: "Only when asked: changes for the owner to confirm. You never make them.";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["kind"];
                readonly properties: {
                    readonly kind: {
                        readonly type: "string";
                        readonly enum: readonly ["settings", "decision", "pause", "resume"];
                    };
                    readonly key: {
                        readonly type: "string";
                        readonly description: "settings: which setting";
                    };
                    readonly value: {
                        readonly description: "settings: the new value";
                    };
                    readonly id: {
                        readonly type: "string";
                        readonly description: "decision: its id";
                    };
                    readonly answer: {
                        readonly type: "string";
                        readonly description: "decision: one of its options";
                    };
                    readonly why: {
                        readonly type: "string";
                    };
                };
            };
        };
    };
};
/** Every role with a built-in prompt. */
export declare function defaultRoles(): string[];
/** The engine's built-in prompt for a role ('' for an unknown role). */
export declare function defaultRolePrompt(role: string): string;
/**
 * A role's prompt: the project's roles/<role>.md, else the engine default. A config read from the default branch
 * carries its role prompts (`roles`, src/config/live.ts) and those are used; otherwise the file in `dir`.
 */
export declare function rolePrompt(project: string | {
    dir: string;
    roles?: Record<string, string>;
}, role: string): string;
export declare function issueBrief(issue: Issue, doneWhen: DoneWhenList, extra?: string[]): string;
