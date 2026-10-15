// WHY (#469): an empty required_checks in PR mode means no PR is ever marked ready, so nothing ever merges, and
// before this nothing said so. The loader still accepts it (an existing config keeps loading and its coordinator
// keeps starting), but it is a config problem everywhere a person looks: the config_invalid incident (raised by the
// coordinator's live-config check), doctor's and the first-run page's "Required checks named" step, and `init`,
// which won't finish until a choice is made.
import { BRAND } from './brand.js';
import type { Config } from './config/load.js';

type Project = Pick<Config['project'], 'land_mode' | 'required_checks'> & Partial<Pick<Config['project'], 'ci'>>;

/** The fix, as every place that reports the problem says it. */
export const CI_CHOICE_FIX = `on the dashboard's First-run page, "Required checks named": add the starter CI (a GitHub Actions workflow you commit through a PR) and name its check once it has run, or list your CI's checks in ${BRAND.configDir}/config.yaml required_checks, or (where tests.yaml has test_run) choose No CI, ci: none`;

/**
 * Why this config can never mark a PR ready, or null when it can. Only PR mode reads required_checks: a direct-land
 * config lands without PRs and has nothing to name.
 */
export function ciChoiceProblem(p: Project): string | null {
  if (p.land_mode !== 'pr') return null;
  if (p.required_checks.length || p.ci === 'none') return null;
  return `required_checks is empty and no CI is chosen: no PR is ever marked ready, so nothing ever merges. Fix: ${CI_CHOICE_FIX}`;
}
