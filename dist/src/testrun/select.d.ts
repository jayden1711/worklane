import { type Plan } from './affected.js';
import type { TestRunConfig } from './config.js';
export type SelectMode = 'imports' | 'repo' | 'off';
/** The mode a config runs: its own, else `repo` when a tier passes {changed_files} (a planner of the repo's), else off. */
export declare function selectMode(c: Pick<TestRunConfig, 'tiers'> & {
    select?: SelectMode | undefined;
}): SelectMode;
/** A JS/TS test file: *.test.* or *.spec.*, or anything under __tests__/. */
export declare const isJsTest: (f: string) => boolean;
/** Changed files every test may depend on without importing them: the whole suite runs. */
export declare function jsForceAll(f: string): string | null;
/** Each file's contents at `sha`, through one git cat-file --batch. A file over 1 MB reads as empty (built output). */
export declare function readAt(repo: string, sha: string, files: readonly string[]): Map<string, string>;
/** The plan for a change at `sha` in the clone at `repo`: the JS/TS test files it can affect, or the whole suite. */
export declare function importsPlan(repo: string, sha: string, changed: readonly string[]): Plan;
/** A tier's {tests}: the test files, shell-quoted and space-separated; '' for the whole suite (a runner given no files runs them all). */
export declare function testsArg(tests: readonly string[] | null): string;
