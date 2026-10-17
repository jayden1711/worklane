// WHY (#469, owner decision Q2): "No CI" (config.yaml `ci: none`) for a repo that runs no CI on GitHub. A PR is then
// ready when this machine's own test runs (tests.yaml test_run, every tier, run in the test-run sandbox) passed on
// its exact head, and the evaluator approved that head. Offered only where test_run is configured; elsewhere the
// config is refused, with the fix: add the starter CI.
//
// INVARIANT: the tier results a ci: none PR is judged by come only from this instance's event log (testrun.finished,
// recorded by the coordinator's test run), never from GitHub: a check of the same name, posted by anyone or anything,
// counts for nothing. The log lives in the coordinator's state, which the agent user can't write (scripts/setup/
// instance.sh makes the coordinator's home 0700; the CI job add-project (real systemd) proves the agent user can't
// write or append to the events DB).
import { checkName } from './testrun/config.js';
/** What No CI means, said the same way on the step, the PR and merge views, and the main watch. */
export const CI_NONE_MEANS = "No CI (ci: none): a PR is ready when this machine's test runs (tests.yaml test_run, in the test-run sandbox) pass on its exact head and the evaluator approves it; GitHub runs nothing";
/** The main watch's off detail under No CI. */
export const CI_NONE_MAIN_WATCH = `${CI_NONE_MEANS}. The main watch can't judge merges by checks here, and auto-merge relies on this machine's runs: every tier runs on each merge commit, and main is judged by that run`;
/** Why No CI is refused where there is no test_run. */
export const CI_NONE_NEEDS_TEST_RUN = "ci: none judges PRs by this machine's test runs (tests.yaml test_run, in the test-run sandbox on a Linux server), and this config has none: add the starter CI on the First-run page's Required checks step instead";
export const ciIsNone = (p) => p.ci === 'none';
/** Cross-file problems with `ci` (src/config/load.ts crossCheck): refused, never half-applied. */
export function ciNoneProblems(p, tests) {
    if (!ciIsNone(p))
        return [];
    const out = [];
    if (!tests?.test_run)
        out.push({ path: 'ci', message: CI_NONE_NEEDS_TEST_RUN });
    if (p.required_checks.length)
        out.push({ path: 'required_checks', message: `ci: none takes no required_checks (GitHub runs nothing a PR waits on): drop ${p.required_checks.join(', ')}, or drop ci: none` });
    return out;
}
/** Every test_run tier's check name, as the test run names them (tests.yaml test_run.checks, else test-run/<tier>). */
export function testRunCheckNames(tests) {
    const tr = tests.test_run;
    if (!tr)
        return [];
    return [...new Set(tr.tiers.map((t) => checkName(tr, t.name)))];
}
/**
 * The test run's checks on commit `sha`, read only from the event log: per check name, its tiers' latest results on
 * exactly this commit. A check passes only when every one of its tiers passed. A run that ended in an error (its setup
 * failed) fails the tiers it reports; a cancelled or interrupted one says nothing. A run queued or running on it, and
 * no result yet: in progress. Neither: the check isn't there (missing).
 */
export function localRunChecks(events, sha, tests) {
    const tr = tests.test_run;
    if (!tr)
        return [];
    const latest = new Map();
    const queued = new Set();
    const finished = new Set();
    for (const e of events) {
        if (e.type === 'testrun.queued') {
            const p = e.payload;
            if (p.sha === sha)
                queued.add(p.id);
        }
        else if (e.type === 'testrun.finished') {
            const p = e.payload;
            finished.add(p.id);
            if (p.sha !== sha || (p.outcome !== 'done' && p.outcome !== 'error'))
                continue;
            for (const r of p.results)
                latest.set(r.tier, r.ok && p.outcome === 'done');
        }
    }
    const running = [...queued].some((id) => !finished.has(id));
    const out = [];
    for (const name of testRunCheckNames(tests)) {
        const tiers = tr.tiers.filter((t) => checkName(tr, t.name) === name).map((t) => t.name);
        if (tiers.every((t) => latest.has(t))) {
            out.push({ name, source: 'check_run', status: 'completed', conclusion: tiers.every((t) => latest.get(t)) ? 'success' : 'failure' });
        }
        else if (running)
            out.push({ name, source: 'check_run', status: 'in_progress', conclusion: null });
    }
    return out;
}
/**
 * The checks a PR's head is judged by under No CI: GitHub's, with every one named like a test-run check taken out,
 * and the event log's in their place. Elsewhere (ci: github), GitHub's as they are.
 */
export function headChecks(o) {
    if (!ciIsNone(o.project))
        return o.github;
    const names = new Set(testRunCheckNames(o.tests));
    return [...o.github.filter((c) => !names.has(c.name)), ...localRunChecks(o.events(), o.sha, o.tests)];
}
/** The checks a PR must pass: required_checks, or under No CI every test-run tier's check. */
export function requiredFor(project, tests) {
    return ciIsNone(project) ? testRunCheckNames(tests) : project.required_checks;
}
//# sourceMappingURL=ci-none.js.map