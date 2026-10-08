import type { ReviewConfig } from './config/schema.js';
export type Level = 'L0' | 'L1' | 'L2' | 'L3';
/** Built-in categories; review.yaml `categories` adds to or overrides them. */
export declare const DEFAULT_CATEGORIES: Record<string, string[]>;
export interface ChangeFile {
    path: string;
    added: number;
    removed: number;
    /** Added lines, for content checks (data deletion). */
    addedLines?: string[];
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
