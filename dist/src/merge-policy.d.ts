import { type LevelResult } from './review.js';
export interface MergeVerdict {
    patch_correct: boolean;
    test_correct: boolean;
    confidence: 'high' | 'medium' | 'low';
    /** Why the confidence isn't high (eval.verdict); absent on an older verdict. */
    confidence_reason?: string | undefined;
    advice?: string | undefined;
    unread?: string[] | undefined;
    design_change?: boolean | undefined;
    design_reason?: string | undefined;
}
/** The branches the harness's revert PRs come from (a red main after an auto-merge, the main watch). */
export declare const REVERT_BRANCH_PREFIX: string;
export declare const isRevertBranch: (branch: string) => boolean;
/** The branches of checks proposed from repeated feedback (src/checks-from-feedback.ts): a person merges each. */
export declare const FEEDBACK_CHECK_BRANCH_PREFIX: string;
/**
 * Why the harness may never merge this PR itself, whatever else holds: one it didn't open (a person's, a bot's: a
 * person merges it), its own revert PRs (a human approves a revert), and checks proposed from feedback. Empty: it
 * may, if the rest allows.
 */
export declare function neverAutoMerge(o: {
    branch: string;
    openedByHarness: boolean;
}): string[];
export interface MergeInput {
    /** The PR's branch (its head ref): a revert's never auto-merges. */
    branch: string;
    /** Whether this instance opened the PR (pr.opened): anyone else's never auto-merges. */
    openedByHarness: boolean;
    /** The instance policy's auto_merge (the kill switch). */
    policyOn: boolean;
    /** review.yaml merge.auto. */
    repoOn: boolean;
    /** Why auto-merge is stopped for this instance (main went red after one), or null. */
    stopped: string | null;
    /** Review categories of the whole change, with the paths in each (computeLevel). */
    level: LevelResult;
    /** Categories that always wait: L3's, plus ci-config and the repo's merge.wait_categories. */
    waitCategories: string[];
    limits: {
        max_lines: number;
        max_files: number;
    };
    lines: number;
    files: number;
    verdict: MergeVerdict | null;
    /** Top-level directories the change creates (a new module or package). */
    newTopLevel: string[];
    /** CI fix runs started on this PR. */
    ciFixRuns: number;
    /** The PR's head isn't the harness's own last push. */
    foreignPush: boolean;
    /** The change ever hit a push limit. */
    pushLimitHit: boolean;
    /** Why the evals of instructions the change touches don't clear it (instructionEvalReasons); empty: they do. */
    instructionEvals?: string[];
    /** A planned task: high-risk or design-level paths changed outside its approved plan (outsidePlanReasons). */
    outsidePlan?: string[];
    /** The worker raised the PR's risk class to protected (src/pr-rules.ts): protected waits for the owner. */
    claimedProtected?: boolean;
}
export interface InstructionEvalResult {
    target: string;
    base: {
        passed: number;
        total: number;
    } | null;
    result: {
        passed: number;
        total: number;
    } | null;
    dropped: boolean;
    incomplete: boolean;
    changes: {
        id: string;
        title: string;
        base: string;
        head: string;
    }[];
    cost_usd: number;
    error?: string | undefined;
    /** A role's held-out comparison (decides); null: no held-out cases; absent: the target isn't a role. */
    held_out?: {
        base: {
            passed: number;
            total: number;
        } | null;
        result: {
            passed: number;
            total: number;
        };
        dropped: boolean;
        incomplete: boolean;
        changes: {
            id: string;
            title: string;
            base: string;
            head: string;
        }[];
    } | null | undefined;
    held_out_error?: string | undefined;
}
/**
 * For each instructions target the change touches: a reason to wait unless its eval ran to the end without
 * a drop. A drop lists every case whose outcome changed, so the owner sees what got worse.
 */
export declare function instructionEvalReasons(targets: string[], results: InstructionEvalResult[]): string[];
export interface MergeDecision {
    auto: boolean;
    /** Why it waits for a human, grouped by kind (empty when it merges). */
    reasons: string[];
    /** Each high-risk category it touches, said plainly with the first file in it (whyHighRisk); "Waiting on you" shows these. */
    why: WaitWhy[];
    /** The evaluator's advice, when its verdict is one of the reasons it waits (the hold comment shows it). */
    advice?: string;
}
/** One high-risk category a change touches, in plain words: e.g. "changes the merge policy: src/merge-policy.ts". */
export interface WaitWhy {
    category: string;
    text: string;
}
/**
 * The categories that always wait for a human: review.yaml's L3, CI config, the agents' own instructions (built in;
 * no review.yaml removes it), and the repo's merge.wait_categories.
 */
export declare function waitCategoriesOf(review: {
    levels: {
        L3_human: {
            when: string[];
        };
    };
    merge: {
        wait_categories: string[];
    };
}): string[];
/**
 * Why a change is high-risk, plainly, one line per category it touches, naming the first file in it: "changes the
 * merge policy: src/merge-policy.ts" (self-modification says which part of the harness), "changes a database
 * migration: db/001.sql", or for the repo's own category "touches pricing: src/price.js".
 */
export declare function whyHighRisk(o: {
    level: LevelResult;
    waitCategories: string[];
}): WaitWhy[];
/**
 * THE mark of a high-risk reason (a category that always waits for a human: money path, auth, secrets, deploy and
 * release config, the harness's own controls, CI, a worker's protected claim). Every high-risk reason the merge
 * policy and plan mode give starts with it, and the one test of whether a reason is high-risk is isHighRiskReason:
 * a held plan with one is never approvable by voice (src/voice.ts).
 */
export declare const HIGH_RISK_REASON = "high-risk: ";
export declare const isHighRiskReason: (reason: string) => boolean;
/**
 * Why files (changed, or planned to change) need a human: high-risk categories, and design-level changes,
 * meaning a binding design flag (`design.by`: who raised it), dependency manifests, or a new top-level
 * module. One answer for the merge policy and for plan mode.
 */
export declare function riskAndDesignReasons(o: {
    level: LevelResult;
    waitCategories: string[];
    design?: {
        flag: boolean | undefined;
        reason?: string | undefined;
        by: string;
    };
    newTopLevel: string[];
}): string[];
/**
 * A planned task's PR: the high-risk and design-level paths it changes that its approved plan didn't list.
 * The same matchers as riskAndDesignReasons (the change's own categories), with the planned files taken out.
 */
export declare function outsidePlanReasons(o: {
    planFiles: string[];
    level: LevelResult;
    waitCategories: string[];
    newTopLevel: string[];
}): string[];
export declare function mergeDecision(i: MergeInput): MergeDecision;
