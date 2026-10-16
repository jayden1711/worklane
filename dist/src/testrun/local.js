/** Whether the coordinator's test runs are the full run for this project. */
export function fullRunIsTestRun(tests) {
    return !!tests.test_run?.tiers.some((t) => t.kind === 'full');
}
/** The done_when an agent run and its verify use: `suite: full` becomes `suite: changed` when the test run is the full run. */
export function localDoneWhen(list, tests) {
    if (!fullRunIsTestRun(tests))
        return list;
    return list.map((d) => ('suite' in d && d.suite === 'full' ? { ...d, suite: 'changed' } : d));
}
//# sourceMappingURL=local.js.map