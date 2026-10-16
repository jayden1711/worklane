import type { RequiredCheck } from './pr-watch.js';
import type { LevelResult } from './review.js';
/**
 * docs-only: every changed file is documentation (`*.md` anywhere, or under `docs/`). protected: it touches a
 * category the merge policy always leaves to the owner (money path, auth, secrets, CI, setup scripts, the harness's
 * own controls and the agents' instructions, plus the repo's own wait list). logic: anything else.
 */
export type RiskClass = 'docs-only' | 'logic' | 'protected';
export declare const RISK_CLASSES: RiskClass[];
/** The owner's definition of documentation for the fast path: narrower than review.ts's `docs` category. */
export declare const DOCS_ONLY_GLOBS: string[];
export declare const isDocPath: (p: string) => boolean;
export interface ClassResult {
    cls: RiskClass;
    /** Why, in plain words: the high-risk categories (protected), or a short note. */
    why: string[];
}
/**
 * The risk class computed from the changed paths: the merge policy's high-risk categories (review.yaml's L3, CI
 * config, the locked self-modification and agent-instructions categories, the repo's wait list) and the money-path
 * config, all already in `level` (computeLevel). Protected wins over docs-only (AGENTS.md is a .md file).
 */
export declare function riskClassOf(o: {
    paths: string[];
    level: LevelResult;
    waitCategories: string[];
}): ClassResult;
/** The class a PR goes out with: the computed one, raised (never lowered) by the agent's own claim. */
export declare function effectiveClass(computed: RiskClass, claimed: RiskClass | undefined | null): RiskClass;
export declare const INTENT_PREFIX = "**Intent:** ";
export declare const CLASS_PREFIX = "**Risk class:** ";
/** One paragraph: the worker's intent with blank lines and runs of whitespace folded into single spaces. */
export declare function oneParagraph(text: string | undefined | null): string;
/** The head of every agent PR body: the intent paragraph, then the risk class (and why). */
export declare function prBodyHead(o: {
    intent: string;
    cls: RiskClass;
    why: string[];
}): string;
/**
 * Why an agent PR body is refused (empty: it's fine). It must start with a one-paragraph intent and then a risk
 * class, and that class may not be lower than the one computed from the changed paths.
 */
export declare function prBodyProblems(body: string, computed: RiskClass): string[];
/** Lockfiles: never counted toward the size limit. */
export declare const LOCKFILE_GLOBS: string[];
/** One file of a change (git diff -M): its added and removed lines. A pure rename has none, a binary file none. */
export interface SizeFile {
    path: string;
    added: string[];
    removed: string[];
}
export type SizeVerdict = {
    ok: true;
    lines: number;
    why: string;
} | {
    ok: false;
    lines: number;
    why: string;
};
/**
 * Over `maxLines` changed lines (added plus removed; lockfiles and generated files not counted), a change is sent
 * back to be split, unless it's mechanical: whitespace ignored and blank lines dropped, its added lines are exactly
 * its removed lines (renames, moves, reindents, formatting). A pure rename counts 0 lines (rename detection).
 */
export declare function sizeVerdict(files: SizeFile[], o: {
    maxLines: number;
    generated: string[];
}): SizeVerdict;
/** The change base..head as sizeVerdict reads it: one `git diff -M -U0`, each file under its new path. */
export declare function sizeFiles(cwd: string, base: string, head: string): SizeFile[];
/**
 * The required checks the harness's own merge call waits on for a PR: every required check, or for a docs-only PR
 * the light ones (review.yaml docs_only_checks, those of them that are required). Empty docs_only_checks: no fast path.
 * GitHub's ruleset still requires every required check before it lets the merge through (see docs).
 */
export declare function checksFor(o: {
    cls: RiskClass;
    required: string[];
    docsOnlyChecks: string[];
}): {
    checks: string[];
    fast: boolean;
};
/**
 * A docs-only PR the harness decided on its light checks, while GitHub reports it blocked: the ruleset still
 * requires every required check. Those still running (or not reported yet): wait, and look again on the next poll.
 * One that failed: a human looks (the light checks don't speak for it). None outstanding: blocked for another
 * reason, which the merge policy reports as usual.
 */
export declare function rulesetHold(full: RequiredCheck[]): {
    act: 'wait';
} | {
    act: 'hold';
    why: string;
} | {
    act: 'none';
};
