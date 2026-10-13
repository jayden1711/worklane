// tests.yaml `deploy_gate:` (docs/deploy-gate.md): a branch the project's host deploys production from, which the
// coordinator fast-forwards only to default-branch commits whose configured test-run tiers all passed on that exact
// commit. Absent (the default): no gate, nothing runs, nothing moves.
import { z } from 'zod';

/** The incident a deploy branch moved outside the gate raises (src/watchdog/incidents.ts KINDS). */
export const DEPLOY_GATE_INCIDENT = 'deploy_gate_diverged';

/** The check the gate posts on each default-branch commit it ran. */
export const DEPLOY_GATE_CHECK = 'deploy-gate';

const tierName = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'a test_run tier name');

/** A plain branch name: no `..`, no `.lock` end, no leading `-` or `/`, nothing git refuses in a ref. */
const branchName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/, 'a branch name (letters, digits, . _ / -)')
  .refine((b) => !b.includes('..') && !b.endsWith('.lock') && !b.endsWith('/') && !b.includes('//'), 'a branch name git accepts');

export const DeployGateConfig = z.strictObject({
  /** The branch the host's production services deploy from. Never the default branch (checked at start). */
  branch: branchName.default('deploy'),
  /** test_run tiers (fast or full) that must all pass on a default-branch commit before the branch moves to it. */
  tiers: z
    .array(tierName)
    .min(1)
    .refine((t) => new Set(t).size === t.length, 'each tier once'),
  /** ops: post to the Discord ops channel when the branch moves and when it is held; off: the dashboard only. */
  notify: z.enum(['ops', 'off']).default('ops'),
});
export type DeployGateConfig = z.infer<typeof DeployGateConfig>;

/** What the deploy gate needs of tests.yaml: test_run, and every tier it names in it. Each problem, with its path. */
export function deployGateProblems(gate: DeployGateConfig | undefined, testRunTiers: string[] | null): { path: (string | number)[]; message: string }[] {
  if (!gate) return [];
  if (testRunTiers === null) return [{ path: ['deploy_gate'], message: 'needs test_run: the gate runs its tiers' }];
  return gate.tiers.flatMap((t, i) => (testRunTiers.includes(t) ? [] : [{ path: ['deploy_gate', 'tiers', i], message: `no test_run tier named ${t}` }]));
}
