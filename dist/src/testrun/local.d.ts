import type { DoneWhenList } from '../backlog/types.js';
import type { TestsConfig } from '../config/schema.js';
/** Whether the coordinator's test runs are the full run for this project. */
export declare function fullRunIsTestRun(tests: Pick<TestsConfig, 'test_run'>): boolean;
/** The done_when an agent run and its verify use: `suite: full` becomes `suite: changed` when the test run is the full run. */
export declare function localDoneWhen(list: DoneWhenList, tests: Pick<TestsConfig, 'test_run'>): DoneWhenList;
