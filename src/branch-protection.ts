// The default branch's protection as the harness recommends it, from config.yaml (`required_checks` and
// `protection.strict`). Advice only: nothing here calls GitHub or changes a repo's protection; the owner applies it.
//
// Not strict by default: a PR's required checks must pass, but the PR need not be up to date with the default
// branch first. Post-merge CI on the default branch and the main watch catch what strict would have, and PRs don't
// queue behind one another merging main in and rerunning CI. `protection.strict: true` opts a repo in.
import type { ProjectConfig } from './config/schema.js';

type Input = Pick<ProjectConfig, 'required_checks' | 'protection'>;

/** The `required_status_checks` rule of a repository ruleset (POST/PUT repos/{repo}/rulesets, `rules[]`). */
export function rulesetChecksRule(c: Input) {
  return {
    type: 'required_status_checks' as const,
    parameters: {
      strict_required_status_checks_policy: c.protection.strict,
      required_status_checks: c.required_checks.map((context) => ({ context })),
    },
  };
}

/** The `required_status_checks` part of classic branch protection (PUT repos/{repo}/branches/{branch}/protection). */
export function classicChecks(c: Input) {
  return { strict: c.protection.strict, contexts: [...c.required_checks] };
}

/** One line for the checklist: what to require, and whether up to date is part of it. */
export function protectionAdvice(c: Input): string {
  const n = c.required_checks.length;
  const checks = n ? `require the ${n} required_checks` : 'require your CI checks (config.yaml required_checks is empty)';
  return c.protection.strict
    ? `recommended: ${checks}, strict (PRs must be up to date first; config.yaml protection.strict: true)`
    : `recommended: ${checks}, not strict (post-merge CI and the main watch catch the rest; config.yaml protection.strict: true opts in)`;
}
