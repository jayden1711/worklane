import type { Config } from './config/load.js';
type Project = Pick<Config['project'], 'land_mode' | 'required_checks'> & Partial<Pick<Config['project'], 'ci'>>;
/** The fix, as every place that reports the problem says it. */
export declare const CI_CHOICE_FIX: string;
/**
 * Why this config can never mark a PR ready, or null when it can. Only PR mode reads required_checks: a direct-land
 * config lands without PRs and has nothing to name.
 */
export declare function ciChoiceProblem(p: Project): string | null;
export {};
