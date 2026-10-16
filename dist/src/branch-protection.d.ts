import type { ProjectConfig } from './config/schema.js';
type Input = Pick<ProjectConfig, 'required_checks' | 'protection'>;
/** The `required_status_checks` rule of a repository ruleset (POST/PUT repos/{repo}/rulesets, `rules[]`). */
export declare function rulesetChecksRule(c: Input): {
    type: "required_status_checks";
    parameters: {
        strict_required_status_checks_policy: boolean;
        required_status_checks: {
            context: string;
        }[];
    };
};
/** The `required_status_checks` part of classic branch protection (PUT repos/{repo}/branches/{branch}/protection). */
export declare function classicChecks(c: Input): {
    strict: boolean;
    contexts: string[];
};
/** One line for the checklist: what to require, and whether up to date is part of it. */
export declare function protectionAdvice(c: Input): string;
export {};
