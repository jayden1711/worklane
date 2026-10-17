/** The longest instance name on a machine: wl-<n>-agent and wl-<n>-eval stay within a 32-character user name. */
export declare const INSTANCE_NAME_MAX = 21;
/**
 * The longest name an instance file may hold. `instance init` has taken up to 41 since instances began, for an
 * instance that runs as its owner's own user (no wl- users); such a home must still load.
 */
export declare const INSTANCE_FILE_NAME_MAX = 41;
/** What each name the scripts make is derived from: an instance name, a CI runner name, or nothing (a fixed name). */
export type NameOf = 'instance' | 'runner' | 'fixed' | 'test-run' | 'test-run-legacy' | 'snapshot' | 'exp-step';
/** Every user, group and systemd unit the setup scripts make, with <n> the instance or runner name. */
export declare const ENGINE_NAMES: readonly {
    readonly pattern: string;
    readonly of: NameOf;
}[];
/**
 * Why `s` can't name an instance, or null when it can. The shape first (lowercase letters, digits and dashes, starting
 * with a letter, at most `max`), then each name that would be another's, named.
 */
export declare function instanceNameProblem(s: unknown, max?: number): string | null;
/** A name an instance may have on a machine (scripts/setup, the machine helper and add-project take exactly these). */
export declare function instanceNameOk(s: unknown): s is string;
/**
 * Why `s` can't name a CI runner (scripts/setup/ci-runner.sh --name; lib.sh ci_runner_name_problem), or null: an
 * instance's shape, never a name whose wl-ci-<r> is instance ci's own (agent, eval, work), nor one whose units are
 * another runner's (ending in -docker or -reset).
 */
export declare function ciRunnerNameProblem(s: unknown): string | null;
