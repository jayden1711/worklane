import type { Level } from './review.js';
import { route } from './routing.js';
export interface EvalRouting {
    /** Judges changes at `cheap_levels` (docs-only, tests-only, comment-only by default). */
    cheap_model: string;
    cheap_levels: Level[];
    /** A failed or uncertain verdict from the cheap model goes to the stronger model once. */
    escalate: boolean;
}
export declare const DEFAULT_EVAL_ROUTING: EvalRouting;
export declare function evalRouting(agents: Parameters<typeof route>[0]): EvalRouting;
/**
 * The level used to route the evaluation: the computed review level, except that a comment-only change routes
 * as L0 (it can't change behavior). Only routing; the change's review level for merging is untouched.
 */
export declare function routingLevel(level: Level, files: {
    path: string;
    addedLines: string[];
    removedLines: string[];
}[]): Level;
/** The model that judges a change at `level`: the cheap model for its levels, else the evaluator role's model. */
export declare function evaluatorModel(level: Level, strongModel: string, r?: EvalRouting): string;
export interface Verdict {
    patch_correct: boolean;
    confidence: 'high' | 'medium' | 'low';
}
/**
 * Whether a verdict goes to the stronger model before it counts: only a verdict from the cheap model (never one
 * the stronger model gave), and only when it isn't a confident pass: a rejection, an uncertain approval, or no
 * verdict at all. One escalation; the stronger model's verdict is final.
 */
export declare function shouldEscalate(o: {
    usedModel: string;
    strongModel: string;
    verdict: Verdict | null;
    escalated: boolean;
    routing?: EvalRouting;
}): boolean;
/**
 * A change that only adds, edits or removes comments (and blank lines): every changed line, both sides, is a
 * comment or blank in a file whose comment syntax is known. Unknown file types are never comment-only.
 */
export declare function commentOnly(files: {
    path: string;
    addedLines: string[];
    removedLines: string[];
}[]): boolean;
