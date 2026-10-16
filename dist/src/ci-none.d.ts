import type { CommitCheck } from './backlog/types.js';
import type { ProjectConfig, TestsConfig } from './config/schema.js';
import type { StoredEvent } from './events/types.js';
/** What No CI means, said the same way on the step, the PR and merge views, and the main watch. */
export declare const CI_NONE_MEANS = "No CI (ci: none): a PR is ready when this machine's test runs (tests.yaml test_run, in the test-run sandbox) pass on its exact head and the evaluator approves it; GitHub runs nothing";
/** The main watch's off detail under No CI. */
export declare const CI_NONE_MAIN_WATCH = "No CI (ci: none): a PR is ready when this machine's test runs (tests.yaml test_run, in the test-run sandbox) pass on its exact head and the evaluator approves it; GitHub runs nothing. The main watch can't judge merges by checks here, and auto-merge relies on this machine's runs: every tier runs on each merge commit, and main is judged by that run";
/** Why No CI is refused where there is no test_run. */
export declare const CI_NONE_NEEDS_TEST_RUN = "ci: none judges PRs by this machine's test runs (tests.yaml test_run, in the test-run sandbox on a Linux server), and this config has none: add the starter CI on the First-run page's Required checks step instead";
export declare const ciIsNone: (p: Pick<ProjectConfig, "ci">) => boolean;
/** Cross-file problems with `ci` (src/config/load.ts crossCheck): refused, never half-applied. */
export declare function ciNoneProblems(p: Pick<ProjectConfig, 'ci' | 'required_checks'>, tests: Pick<TestsConfig, 'test_run'> | undefined): {
    path: string;
    message: string;
}[];
/** Every test_run tier's check name, as the test run names them (tests.yaml test_run.checks, else test-run/<tier>). */
export declare function testRunCheckNames(tests: Pick<TestsConfig, 'test_run'>): string[];
/**
 * The test run's checks on commit `sha`, read only from the event log: per check name, its tiers' latest results on
 * exactly this commit. A check passes only when every one of its tiers passed. A run that ended in an error (its setup
 * failed) fails the tiers it reports; a cancelled or interrupted one says nothing. A run queued or running on it, and
 * no result yet: in progress. Neither: the check isn't there (missing).
 */
export declare function localRunChecks(events: StoredEvent[], sha: string, tests: Pick<TestsConfig, 'test_run'>): CommitCheck[];
/**
 * The checks a PR's head is judged by under No CI: GitHub's, with every one named like a test-run check taken out,
 * and the event log's in their place. Elsewhere (ci: github), GitHub's as they are.
 */
export declare function headChecks(o: {
    project: Pick<ProjectConfig, 'ci'>;
    tests: Pick<TestsConfig, 'test_run'>;
    github: CommitCheck[];
    events: () => StoredEvent[];
    sha: string;
}): CommitCheck[];
/** The checks a PR must pass: required_checks, or under No CI every test-run tier's check. */
export declare function requiredFor(project: Pick<ProjectConfig, 'ci' | 'required_checks'>, tests: Pick<TestsConfig, 'test_run'>): string[];
