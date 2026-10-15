export declare const TESTS_YAML: string;
/** Why a tier can't be judged on this head: what it lacks, and the config's commit. */
export interface Predates {
    /** The commit on the default branch that last changed test_run. */
    configCommit: string;
    /** What the head lacks, in a line: "`<path>` is not in this PR's head" or "its test runner rejects `--x`". */
    what: string;
    /** The tier wasn't run (the file it calls is missing), rather than run and failed. */
    notRun: boolean;
}
/** The commit, reachable from `base`, that last changed tests.yaml's test_run; null when none can be found. */
export declare function configCommit(repo: string, base: string): string | null;
/**
 * The config commit, when the head `sha` doesn't contain it (the head predates the config); null when it does, or
 * when there is no default branch or config commit to compare with.
 */
export declare function configBehind(repo: string, sha: string): string | null;
/**
 * The repo paths a command names, conservatively: words with a slash, inside the repo (relative, no `..`), and none
 * of the shell's or the placeholders' syntax (`$`, braces, globs, `=`, `:`). `bash ci/checks/x.sh`,
 * `node scripts/plan.mjs`: yes. `--flag=a/b`, `/usr/bin/x`, `$HOME/x`, `src/*.ts`, `https://…`: no.
 */
export declare function referencedPaths(command: string): string[];
/**
 * The first path the command names that the config's commit has and the head lacks; null when there is none. Only
 * paths on the default branch at the config's commit are required: anything else (an output path, a build
 * directory) the command may well make itself.
 */
export declare function missingReferencedPath(repo: string, sha: string, configCommitSha: string, command: string): string | null;
/**
 * Whether a failed tier's output says the head can't run the command as configured: exit 127 with "No such file"
 * for a path the command names, or exit 2 with the runner's own unknown-option message naming one of its options.
 * What it lacks, in a line; null for any other failure.
 */
export declare function oldHeadFailure(command: string, code: number | null, out: string): string | null;
