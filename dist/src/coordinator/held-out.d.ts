import type { Ask, EvalCase } from '../skilleval.js';
/** run.cost role of a case-writer run. */
export declare const CASE_WRITER_COST_ROLE = "eval-case-writer";
export declare function heldOutFor(o: {
    role: string;
    baseText: string | null;
    headText: string;
    stateDir: string;
    ask: Ask;
    model: string;
}): Promise<{
    cases: EvalCase[];
} | {
    error: string;
}>;
