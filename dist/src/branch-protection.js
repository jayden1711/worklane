/** The `required_status_checks` rule of a repository ruleset (POST/PUT repos/{repo}/rulesets, `rules[]`). */
export function rulesetChecksRule(c) {
    return {
        type: 'required_status_checks',
        parameters: {
            strict_required_status_checks_policy: c.protection.strict,
            required_status_checks: c.required_checks.map((context) => ({ context })),
        },
    };
}
/** The `required_status_checks` part of classic branch protection (PUT repos/{repo}/branches/{branch}/protection). */
export function classicChecks(c) {
    return { strict: c.protection.strict, contexts: [...c.required_checks] };
}
/** One line for the checklist: what to require, and whether up to date is part of it. */
export function protectionAdvice(c) {
    const n = c.required_checks.length;
    const checks = n ? `require the ${n} required_checks` : 'require your CI checks (config.yaml required_checks is empty)';
    return c.protection.strict
        ? `recommended: ${checks}, strict (PRs must be up to date first; config.yaml protection.strict: true)`
        : `recommended: ${checks}, not strict (post-merge CI and the main watch catch the rest; config.yaml protection.strict: true opts in)`;
}
//# sourceMappingURL=branch-protection.js.map