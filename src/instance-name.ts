// Instance names, and every machine name the setup scripts derive from one. An instance <n> gets the users wl-<n>,
// wl-<n>-agent and wl-<n>-eval, the group wl-<n>-work, the test user wl-test-<n> and the units <cli>-<n>.service,
// <cli>-dashboard-<n>.service and <cli>-test-<n>-docker.service; a CI runner <r> gets wl-ci-<r> and its units; the
// hub has wl-dash and its own units. A name is refused when any of its names could be another's: an instance named
// test-shop would be wl-test-shop, the test user of instance shop, with that user's sandbox and none of a coordinator's.
// The setup scripts (scripts/setup/lib.sh instance_name_problem, and the testrun helper's copy of it) and the machine
// helper (scripts/machine/, instanceName) hold the same rules, word for word; test/instance-name.test.ts keeps them
// equal, and keeps ENGINE_NAMES equal to the names the scripts make, so a new kind of user can't collide unseen.
import { BRAND } from './brand.js';

/** The longest instance name on a machine: wl-<n>-agent and wl-<n>-eval stay within a 32-character user name. */
export const INSTANCE_NAME_MAX = 21;
/**
 * The longest name an instance file may hold. `instance init` has taken up to 41 since instances began, for an
 * instance that runs as its owner's own user (no wl- users); such a home must still load.
 */
export const INSTANCE_FILE_NAME_MAX = 41;

/** What each name the scripts make is derived from: an instance name, a CI runner name, or nothing (a fixed name). */
export type NameOf = 'instance' | 'runner' | 'fixed' | 'test-run' | 'test-run-legacy';
/** Every user, group and systemd unit the setup scripts make, with <n> the instance or runner name. */
export const ENGINE_NAMES: readonly { readonly pattern: string; readonly of: NameOf }[] = [
  { pattern: 'wl-<n>', of: 'instance' },
  { pattern: 'wl-<n>-agent', of: 'instance' },
  { pattern: 'wl-<n>-eval', of: 'instance' },
  { pattern: 'wl-<n>-work', of: 'instance' },
  { pattern: 'wl-test-<n>', of: 'instance' },
  { pattern: 'wl-ci-<n>', of: 'runner' },
  { pattern: 'wl-dash', of: 'fixed' },
  { pattern: `${BRAND.cli}-<n>.service`, of: 'instance' },
  { pattern: `${BRAND.cli}-dashboard-<n>.service`, of: 'instance' },
  { pattern: `${BRAND.cli}-test-<n>-docker.service`, of: 'instance' },
  // A test run's transient unit: <instance>_<run id>_<pid>. Neither part holds an underscore, so it is one run's alone.
  { pattern: `${BRAND.cli}-test-<n>_<n>_<n>.service`, of: 'test-run' },
  // The same, as a helper before protocol 9 named it (<instance>-<run id>-<pid>), which an update can leave behind: never
  // another kind's (the last part is digits), but two instances' can be equal, so the helper tells them apart by User=.
  { pattern: `${BRAND.cli}-test-<n>-<n>-<n>.service`, of: 'test-run-legacy' },
  { pattern: `${BRAND.cli}-ci-<n>@.service`, of: 'runner' },
  { pattern: `${BRAND.cli}-ci-<n>-docker@.service`, of: 'runner' },
  { pattern: `${BRAND.cli}-ci-<n>-reset@.service`, of: 'runner' },
  { pattern: `${BRAND.cli}-ci-<n>-firewall.service`, of: 'runner' },
  { pattern: `${BRAND.cli}-dashboard-hub.service`, of: 'fixed' },
  { pattern: `${BRAND.cli}-dashboard-hub-setup.service`, of: 'fixed' },
  { pattern: `${BRAND.cli}-update.service`, of: 'fixed' },
  { pattern: `${BRAND.cli}-update.timer`, of: 'fixed' },
  { pattern: `${BRAND.cli}-claude-account.service`, of: 'fixed' },
  { pattern: `${BRAND.cli}-tailscale.service`, of: 'fixed' },
  { pattern: `${BRAND.cli}-test.slice`, of: 'fixed' },
  { pattern: `${BRAND.cli}-ci.slice`, of: 'fixed' },
];

/**
 * Why `s` can't name an instance, or null when it can. The shape first (lowercase letters, digits and dashes, starting
 * with a letter, at most `max`), then each name that would be another's, named.
 */
export function instanceNameProblem(s: unknown, max = INSTANCE_NAME_MAX): string | null {
  if (typeof s !== 'string' || !new RegExp(`^[a-z][a-z0-9-]{0,${max - 1}}$`).test(s)) return `lowercase letters, digits and dashes, starting with a letter, at most ${max}`;
  if (s === 'dash') return 'wl-dash is the dashboard viewer';
  if (s === 'hub' || s === 'hub-setup') return `${BRAND.cli}-dashboard-${s}.service is the dashboard hub's`;
  if (s === 'update' || s === 'tailscale' || s === 'claude-account') return `${BRAND.cli}-${s}.service is the machine's own`;
  if (s === 'agent' || s === 'eval' || s === 'work') return `its test user wl-test-${s} would be instance test's ${s} name, and wl-ci-${s} the ${s} name of instance ci`;
  if (s.startsWith('test-')) return `wl-${s} is the test user of instance ${s.slice(5)}`;
  if (s.startsWith('ci-')) return `wl-${s} is the user of CI runner ${s.slice(3)}`;
  if (s.startsWith('dashboard-')) return `${BRAND.cli}-${s}.service is the dashboard of instance ${s.slice(10)}`;
  const m = /^(.+)-(agent|eval|work)$/.exec(s);
  if (m) return `wl-${s} is instance ${m[1]}'s ${m[2]} name`;
  return null;
}

/** A name an instance may have on a machine (scripts/setup, the machine helper and add-project take exactly these). */
export function instanceNameOk(s: unknown): s is string {
  return instanceNameProblem(s) === null;
}

/**
 * Why `s` can't name a CI runner (scripts/setup/ci-runner.sh --name; lib.sh ci_runner_name_problem), or null: an
 * instance's shape, never a name whose wl-ci-<r> is instance ci's own (agent, eval, work), nor one whose units are
 * another runner's (ending in -docker or -reset).
 */
export function ciRunnerNameProblem(s: unknown): string | null {
  if (typeof s !== 'string' || !/^[a-z][a-z0-9-]{0,20}$/.test(s)) return `lowercase letters, digits and dashes, starting with a letter, at most ${INSTANCE_NAME_MAX}`;
  if (s === 'agent' || s === 'eval' || s === 'work') return `wl-ci-${s} is instance ci's ${s} name`;
  const m = /^(.+)-(docker|reset)$/.exec(s);
  if (m) return `${BRAND.cli}-ci-${s}@.service is CI runner ${m[1]}'s ${m[2]} unit`;
  return null;
}
