import { HELD_OUT_ENV, HELD_OUT_GLOB } from './held-out-paths.js';
import { type Ask, type EvalCase } from './skilleval.js';
export { HELD_OUT_ENV, HELD_OUT_GLOB };
/** Held-out cases written per role. */
export declare const HELD_OUT_CASES = 5;
/** The held-out store: the coordinator's state, never a repository. */
export declare function heldOutDir(stateDir: string, env?: NodeJS.ProcessEnv): string;
/** A role's held-out cases, or null when it has none yet. */
export declare function readHeldOut(dir: string, role: string): EvalCase[] | null;
export declare function writeHeldOut(dir: string, role: string, md: string): string;
/**
 * The role's contract as the case writer sees it: each part's own line (label and text), in order. Nothing else
 * of the prompt: not its opening line, not the rules listed under a part.
 */
export declare function contractOf(prompt: string): string;
export declare const CASE_WRITER_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["cases"];
    readonly properties: {
        readonly cases: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["title", "situation", "correct", "wrong"];
                readonly properties: {
                    readonly title: {
                        readonly type: "string";
                        readonly maxLength: 80;
                    };
                    readonly situation: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly minItems: 2;
                        readonly maxItems: 5;
                    };
                    readonly correct: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly minItems: 1;
                        readonly maxItems: 3;
                    };
                    readonly wrong: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly minItems: 1;
                        readonly maxItems: 3;
                    };
                };
            };
        };
    };
};
/** The case writer's whole input: the role's name and its contract lines. No prompt text, no existing cases. */
export declare function caseWriterPrompt(role: string, contract: string, n?: number): string;
/** Cases as the eval files write them (src/skilleval.ts parseCases reads this back). */
export declare function renderCases(heading: string, cases: {
    title: string;
    situation: string[];
    correct: string[];
    wrong: string[];
}[]): string;
/**
 * Write a role's held-out cases with a separate agent run: its only input is the role's contract (contractOf), it
 * runs with no tools in a neutral directory, and nothing it writes compares plans. Returns the cases file's text.
 */
export declare function writeHeldOutCases(o: {
    role: string;
    prompt: string;
    ask: Ask;
    model: string;
    n?: number;
    maxBudgetUsd?: number;
}): Promise<{
    md: string;
    costUsd: number;
}>;
