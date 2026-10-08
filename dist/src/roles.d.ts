import type { DoneWhenList, Issue } from './backlog/types.js';
export declare const WORKER_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["summary", "lesson"];
    readonly properties: {
        readonly summary: {
            readonly type: "string";
            readonly description: "What you changed and how you verified it, in 2-5 sentences.";
        };
        readonly lesson: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["worked", "failed", "fix"];
            readonly properties: {
                readonly worked: {
                    readonly type: "string";
                };
                readonly failed: {
                    readonly type: "string";
                };
                readonly fix: {
                    readonly type: "string";
                };
            };
        };
        readonly blocked: {
            readonly type: "string";
            readonly description: "Set only if you could not finish: what blocks you.";
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
                };
                readonly recommendation: {
                    readonly type: "string";
                };
            };
        };
        readonly raise_review: {
            readonly type: "string";
            readonly enum: readonly ["L1", "L2", "L3"];
            readonly description: "Ask for more review than the computed level, with your reason in summary.";
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
export declare const VERDICT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["patch_correct", "test_correct", "confidence", "advice"];
    readonly properties: {
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
        };
        readonly advice: {
            readonly type: "string";
            readonly description: "What is wrong and how to fix it (patch or test). Empty if nothing.";
        };
    };
};
export declare const INVESTIGATION_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["summary", "findings", "recommendation", "confidence"];
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
            readonly description: "What should happen next (a fix, more investigation, or nothing), for the owner to decide.";
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
export declare function rolePrompt(projectDir: string, role: string): string;
export declare function issueBrief(issue: Issue, doneWhen: DoneWhenList, extra?: string[]): string;
