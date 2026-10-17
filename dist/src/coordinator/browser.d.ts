import type { DoneWhenList } from '../backlog/types.js';
import type { AppConfig } from '../config/schema.js';
import { runBrowserCheck } from '../browser/check.js';
import { type BrowserGate } from '../browser/gate.js';
import { runFlow, type FlowEvidence } from '../browser/run.js';
import type { RunAs } from '../runner.js';
import { type WorktreeOptions } from '../worktrees.js';
/** A flow's run at the base commit: its evidence, or why there is none. */
export type BaselineRun = {
    evidence: FlowEvidence;
} | {
    unavailable: string;
};
/** Where the baselines come from: the base commit, a run per flow, and a cleanup that always runs. */
export interface BaselineSource {
    base: string;
    run(flow: string): Promise<BaselineRun>;
    /** Remove the base worktree (if one was made). Never throws: a failure is returned as a note. */
    close(): Promise<string | null>;
}
/**
 * Baselines at `base`: the worktree is opened on the first flow not already cached, and removed by close().
 * `cache` outlives the call (the coordinator keeps it), so a retry of the same task reuses its baselines.
 */
export declare function baselineSource(o: {
    base: string;
    app: AppConfig;
    cache: Map<string, BaselineRun>;
    open: () => Promise<{
        path: string;
        setupErrors: string[];
    }>;
    remove: () => void;
    outDir: string;
    chrome: string;
    runAs?: RunAs;
    run?: typeof runFlow;
}): BaselineSource;
export interface BrowserCheckRecord {
    check: string;
    status: 'pass' | 'fail' | 'unavailable';
    kind: 'browser';
    exitCode: null;
    tail: string;
    duration_ms?: number;
}
export interface BrowserChecks {
    gate: BrowserGate;
    /** What verify() adds to its checks: every asked flow, and every gated flow that ran. */
    checks: BrowserCheckRecord[];
    /** The PR description's section; empty when the project has no app and the issue asked for nothing. */
    lines: string[];
}
/** Baselines from a worktree of the project at `base` (named `name`, set up like any task's), always removed. */
export declare function worktreeBaseline(o: {
    wt: WorktreeOptions;
    name: string;
    base: string;
    app: AppConfig;
    cache: Map<string, BaselineRun>;
    outDir: string;
    chrome: string;
    runAs?: RunAs;
}): BaselineSource;
/** The change proposed at `head`: its base and files. None for a head no change was proposed at (the base itself). */
export declare function changeAt(events: readonly {
    type: string;
    payload: unknown;
}[], head: string): {
    base: string;
    files: string[];
} | null;
export declare function browserChecks(o: {
    app: AppConfig | undefined;
    doneWhen: DoneWhenList;
    /** The change's files (repo-relative); none when verifying an unchanged base. */
    changed: readonly string[];
    cwd: string;
    /** Where each flow's evidence (its screenshot) goes. */
    outDir: string;
    runAs?: RunAs;
    /** Tests: null means no browser on this machine. */
    chrome?: string | null;
    run?: typeof runBrowserCheck;
    /** The base the change is measured against, given a browser: each flow's baseline (src/coordinator/browser.ts). */
    baseline?: (chrome: string) => BaselineSource;
}): Promise<BrowserChecks>;
