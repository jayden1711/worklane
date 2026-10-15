/** Never loosened: the default L3 categories, CI config and dependencies (design-level), the locked ones (review.ts). The repo's own L3 too. */
export declare const NEVER_LOOSEN: readonly ["money-path", "migration", "auth", "secrets", "deploy-config", "release-config", "harness-config", "guardrail-config", "deletes-data", "ci-config", "dependency"];
export declare function protectedCategories(review: {
    levels: {
        L3_human: {
            when: string[];
        };
    };
}): Set<string>;
/** Why a review.yaml's `merge.loosened` is refused: every protected category listed in it. */
export declare function loosenedProblems(review: {
    levels: {
        L3_human: {
            when: string[];
        };
    };
    merge: {
        loosened?: string[];
    };
}): string[];
export type Outcome = 'clean' | 'changed' | 'reverted' | 'main_red' | 'later_fix';
type Ev = {
    id?: number;
    ts: string;
    type: string;
    payload: unknown;
};
export interface CategoryRecord {
    category: string;
    /** Waits for the owner today (merge.wait_categories). */
    waits: boolean;
    loosened: boolean;
    protected: boolean;
    /** Counted since the last decision on this category. */
    prs: number[];
    clean: number;
    changed: number;
    reverted: number;
    mainRed: number;
    laterFix: number;
    /** Evidence lines: one per PR counted, with its outcome. */
    evidence: string[];
}
/**
 * Each category's record from the log: `delegation.observed` (a merged PR, its categories and whether it merged
 * unchanged), then what happened after (a revert or red main after it, a later fix naming it), counted since the
 * last `delegation.decided` on the category.
 */
export declare function categoryRecords(events: Ev[], review: {
    levels: {
        L3_human: {
            when: string[];
        };
    };
    merge: {
        wait_categories: string[];
        loosened?: string[];
    };
}): CategoryRecord[];
export interface Suggestion {
    category: string;
    direction: 'loosen' | 'tighten';
    question: string;
    options: string[];
    recommendation: string;
    receipts: string[];
}
/**
 * What to put to the owner now: loosen a waiting, unprotected category with at least `minClean` PRs approved unchanged
 * and no revert, red main or later fix since the last decision; tighten a loosened category that had any of those.
 * `open`: categories with a suggestion still waiting for an answer (never asked twice).
 */
export declare function suggestions(records: CategoryRecord[], o: {
    minClean: number;
    open: Set<string>;
}): Suggestion[];
/**
 * A command that passes only once review.yaml has `category` out of merge.wait_categories and in merge.loosened
 * (loosen), or the other way round (tighten): it fails on the unchanged file. Reads flow (`[a, b]`) and block
 * (`- a`) lists. Shell-safe on POSIX and Windows: double-quoted, with no backslash, `$` or double quote inside.
 */
export declare function reviewListCheck(file: string, category: string, direction: 'loosen' | 'tighten'): string;
/** The five-part issue for an answer: the review.yaml change, built into a PR the owner reviews. */
export declare function delegationIssue(category: string, direction: 'loosen' | 'tighten', configDir: string, evidence: string[]): {
    title: string;
    body: string;
};
/** The dashboard's view: every category's record, and each suggestion with its evidence and answer. */
export interface DelegationView {
    categories: CategoryRecord[];
    suggestions: {
        category: string;
        direction: 'loosen' | 'tighten';
        at: string;
        decision: string;
        receipts: string[];
        answer: string | null;
        by: string | null;
        issue: number | null;
    }[];
}
export declare function delegationView(events: Ev[], review: Parameters<typeof categoryRecords>[1]): DelegationView;
export {};
