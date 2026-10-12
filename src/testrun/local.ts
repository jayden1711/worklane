// Agents skip local full runs (owner decision 3): with tests.yaml test_run on and full tiers in it, the coordinator's
// test run is the full run, posted as the PR's checks, so neither an agent nor the coordinator's own verify of an
// agent's change runs the full suite on the machine as well. A done_when `suite: full` is checked locally with the
// changed suite, and the full one is left to the test run. Nothing CI checks is removed: the full tiers still run,
// once per batch, as the test run's checks the PR waits for. With test_run off, nothing changes.
import type { DoneWhenList } from '../backlog/types.js';
import type { TestsConfig } from '../config/schema.js';

/** Whether the coordinator's test runs are the full run for this project. */
export function fullRunIsTestRun(tests: Pick<TestsConfig, 'test_run'>): boolean {
  return !!tests.test_run?.tiers.some((t) => t.kind === 'full');
}

/** The done_when an agent run and its verify use: `suite: full` becomes `suite: changed` when the test run is the full run. */
export function localDoneWhen(list: DoneWhenList, tests: Pick<TestsConfig, 'test_run'>): DoneWhenList {
  if (!fullRunIsTestRun(tests)) return list;
  return list.map((d) => ('suite' in d && d.suite === 'full' ? { ...d, suite: 'changed' as const } : d)) as DoneWhenList;
}
