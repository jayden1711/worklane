import type { CoordinatorDeps } from '../coordinator/shared.js';
import type { EventPayload, EventType } from '../events/types.js';
import { type AgentRunner, type RunRequest, type RunResult } from '../runner.js';
import { type TaskScore } from './score.js';
import { type LoadedTask } from './tasks.js';
/**
 * The run's budget over every agent run in it: each run is capped at what is left, and once it is spent no run
 * starts (it ends as budget_exhausted, as a real budget stop does), so the replay in flight stops and no other starts.
 */
export declare class BudgetRunner implements AgentRunner {
    private inner;
    readonly budgetUsd: number;
    spent: number;
    hit: boolean;
    constructor(inner: AgentRunner, budgetUsd: number);
    get left(): number;
    /** Under a cent left counts as spent: no run can do anything with it. */
    get exhausted(): boolean;
    run(req: RunRequest): Promise<RunResult>;
}
/**
 * The scratch instance's config, committed on top of the base: a file backlog, direct landing into the local remote,
 * and nothing scheduled, paid or networked beyond the agents (no nightly runs, test runs, deploy gate, PR previews,
 * gardener, optimization pass, checks from feedback, or harness evals of its own). Intake is never wired into it. The daily
 * budget is at most the run's.
 */
export declare function scratchConfig(root: string, budgetUsd: number): void;
export interface ReplayOptions {
    runner: BudgetRunner;
    /** Where scratch clones go (each in its own new directory, deleted after). */
    workDir: string;
    /** Where to fetch the task's base from: a local clone that has it, or the repository's URL. */
    source: (t: LoadedTask) => string;
    sample: number;
    /** Ticks before a replay that hasn't finished is given up (unfinished). */
    maxTicks?: number;
    /** Wall-clock cap per replay. */
    timeoutMs?: number;
    /** Keep the scratch clone (debugging). */
    keep?: boolean;
    signal?: AbortSignal;
    /** Instance wiring passed through to the scratch coordinator (agents as their own user). */
    deps?: Pick<CoordinatorDeps, 'commandsAs' | 'agentTasks' | 'depCacheRoot' | 'commitIdentity'>;
    /** Readings for the scratch coordinator's machine gates (tests); default: never held by load or disk. */
    machine?: CoordinatorDeps['machine'];
    say?: (line: string) => void;
}
export interface ReplayResult extends TaskScore {
    wallMs: number;
}
export declare function replayTask(t: LoadedTask, o: ReplayOptions): Promise<ReplayResult>;
export interface SuiteOptions extends Omit<ReplayOptions, 'sample' | 'runner'> {
    tasks: LoadedTask[];
    samples: number;
    budgetUsd: number;
    /** The agents (the instance's runner, or a CLI runner); wrapped in the run's budget. */
    runner: AgentRunner;
    trigger: EventPayload<'harness_eval.run'>['trigger'];
    engine: string | null;
    pr: number | null;
    /** Records each event in the instance's own log. */
    emit: <T extends EventType>(type: T, payload: EventPayload<T>) => void;
    /** Replays a task (tests inject this); default: replayTask. */
    replay?: (t: LoadedTask, o: ReplayOptions) => Promise<ReplayResult>;
}
/**
 * Run the suite: every task, `samples` times, in order, within the budget. Each replay is recorded as it ends
 * (harness_eval.task, and its spend as a run.cost so the instance's daily budget counts it); then the run
 * (harness_eval.run). Once the budget is spent, nothing more starts and the run says it stopped there.
 */
export declare function runSuite(o: SuiteOptions): Promise<EventPayload<'harness_eval.run'>>;
