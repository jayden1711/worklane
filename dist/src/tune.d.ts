import type { Backlog } from './backlog/types.js';
import type { TestsConfig } from './config/schema.js';
import { type PushLimits } from './push-check.js';
import { type ProfileRun, type TuneProfile } from './tuning.js';
import { type WorktreeOptions } from './worktrees.js';
export type WorkerSetting = {
    kind: 'template';
} | {
    kind: 'var';
    name: string;
    value: number;
};
/** How the project's test worker count is set: already `{cores}`, a fixed number in a worker variable, or not at all. */
export declare function workerSetting(tests: Pick<TestsConfig, 'env' | 'runner'>): WorkerSetting | null;
/** The worker counts to try: 1, 2, 4 and every core, as far as the machine has them. */
export declare function profileCounts(cores: number): number[];
/** One run's settings: the worker count in the env and in the command. */
export declare function settingsFor(setting: WorkerSetting, env: Record<string, string>, command: string, workers: number): {
    env: Record<string, string>;
    command: string;
};
export type SuiteRunner = (command: string, env: Record<string, string>, cwd: string) => {
    seconds: number;
    ok: boolean;
    peakWorkerMb: number | null;
};
/** The suite as a task would run it: through the project's command path, as the agent user, timed. */
export declare function suiteRunner(runAs?: {
    user: string;
    home: string;
}, timeoutMs?: number): SuiteRunner;
export declare function runProfile(o: {
    command: string;
    cwd: string;
    env: Record<string, string>;
    setting: WorkerSetting;
    counts: number[];
    run: SuiteRunner;
}): ProfileRun[];
/** tests.yaml with the recommendation applied, comments and layout kept: `cores.max`, and a fixed count made `{cores}`. */
export declare function applyTuning(testsYaml: string, workers: number, setting: WorkerSetting): string;
export interface TuneOptions {
    wt: WorktreeOptions;
    tests: TestsConfig;
    /** main's tip to profile and to base the PR on. */
    base: string;
    /** The default branch the PR targets. */
    mainBranch: string;
    /** The full suite instead of the fast tier (slower, more representative). */
    full?: boolean;
    /** Profile and write the change locally; no push, no PR. */
    dryRun?: boolean;
    remote?: string;
    limits: PushLimits;
    backlog?: Backlog;
    identity: {
        name: string;
        email: string;
    };
    stateDir: string;
    cores?: number;
    /** Memory available for test workers, in MB (default: what the machine reports now). */
    memAvailableMb?: number;
    run?: SuiteRunner;
    /** Record a refused push to the default branch (a push.blocked event). */
    onBlocked?: (ref: string, head: string) => void;
}
export interface TuneResult {
    profile: TuneProfile;
    recommendation: {
        workers: number;
        why: string;
    } | null;
    changed: boolean;
    pr?: {
        url: string;
        number: number;
    };
    refused?: string[];
}
export declare function tune(o: TuneOptions): Promise<TuneResult>;
