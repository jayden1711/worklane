import type { ReviewConfig } from './config/schema.js';
export type Level = 'L0' | 'L1' | 'L2' | 'L3';
/**
 * The agents' own instructions: the config folder's roles and skills (the one part of it agents may edit), the root
 * AGENTS.md and every CLAUDE.md. Always high-risk, so their PRs never auto-merge (merge-policy.ts
 * waitCategoriesOf), whatever review.yaml says; review.yaml can't redefine, drop or loosen it.
 */
export declare const AGENT_INSTRUCTIONS = "agent-instructions";
/**
 * The harness changing its own controls: the merge policy, the main watch and the push guard, the updater, the review
 * levels and guardrails, the machine's setup scripts and CI workflows, sign-in and credentials, and who may approve.
 * Always L3 and never auto-merged (merge-policy.ts waitCategoriesOf), whatever review.yaml says; review.yaml can't
 * redefine, drop or loosen it. Each part says, in the words "Waiting on you" shows, what such a change changes; the
 * first part a file matches names it. Every glob matches a real file in the engine's repo (a test checks).
 */
export declare const SELF_MODIFICATION = "self-modification";
export declare const SELF_MODIFICATION_PARTS: {
    what: string;
    globs: string[];
}[];
export declare const LOCKED_CATEGORIES: Record<string, string[]>;
/** What a change to this path changes, in plain words (the self-modification part it falls in), or null. */
export declare function selfModificationPart(path: string): string | null;
/** Built-in categories; review.yaml `categories` adds to them or replaces one by name. */
export declare const DEFAULT_CATEGORIES: Record<string, string[]>;
export interface ChangeFile {
    path: string;
    added: number;
    removed: number;
    /** Added lines, for content checks (data deletion). */
    addedLines?: string[];
    /** Removed lines, for telling a comment-only change from a code change. */
    removedLines?: string[];
}
export interface LevelInput {
    files: ChangeFile[];
    labels: string[];
    /** Money-path regexes or globs (from money_path_source). */
    moneyPaths: RegExp[];
    verdict?: {
        patch_correct: boolean;
        test_correct: boolean;
        confidence: 'high' | 'medium' | 'low';
    };
    /** An agent may ask for more review, never less. */
    requested?: Level;
}
export interface LevelResult {
    level: Level;
    reasons: string[];
    categories: Record<string, string[]>;
}
/**
 * Money paths from the project's source of truth. A pattern containing
 * regex literals (/.../) yields those; otherwise each line is a glob.
 */
export declare function loadMoneyPaths(root: string, src: ReviewConfig['money_path_source']): RegExp[];
export declare function computeLevel(input: LevelInput, cfg: ReviewConfig, extraCategories?: Record<string, string[]>): LevelResult;
