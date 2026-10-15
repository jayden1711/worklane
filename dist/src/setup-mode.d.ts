import { type Question } from './auto-config.js';
import { type Config } from './config/load.js';
import { type InitIo } from './init.js';
import type { RunResult } from './setup-steps.js';
export declare const needsSetupMode: (root: string, instance?: string | null) => boolean;
/** The checkout's own config loads now: setup mode is over. */
export declare function configReady(root: string): boolean;
/** INVARIANT: a stand-in, read from the templates in a temporary folder and never written into the checkout. */
export declare function setupModeConfig(root: string, owner?: string): Config;
export declare class SetupModeError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
/** Record answers to auto-config's open questions (the same check as `init --answer`); an answered question closes. */
export declare function saveAnswers(file: string, root: string, given: Record<string, unknown>): {
    saved: string[];
    open: Question[];
};
/** The origin a checkout without one gets: the GitHub repo picked, and the commands that set it. */
export declare function originPlan(root: string, repo: unknown): {
    repo: string;
    commands: string[][];
};
export type Run = (cmd: string, args: string[], o?: {
    cwd?: string;
}) => RunResult;
export declare function setOrigin(root: string, repo: unknown, run: Run): string;
/** The repos this gh login may push to, newest first: the origin picker's choices. */
export declare function pushableRepos(run: Run): {
    repos: string[];
    error?: string;
};
export interface DraftJob {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    lines: string[];
    /** auto-config's answer: what stopped it, or merged (the checkout has its config now). */
    result: {
        status: 'done' | 'failed' | 'skipped';
        detail: string;
    } | {
        status: 'merged';
        detail: string;
    } | null;
}
export declare const newDraftJob: () => DraftJob;
/**
 * Run auto-config as `init` does (no terminal: an open question is recorded, never guessed), in the background; the
 * job keeps what it said. It runs the project's commands on a scratch worktree of the default branch, as this user.
 */
export declare function startDraft(o: {
    root: string;
    file: string;
    job: DraftJob;
    io?: InitIo;
}): Promise<void>;
/** How the setup PR would be merged: the first method the repo allows, of merge, squash, rebase. */
export declare function mergeMethod(repo: string, run: Run): string;
/** The setup PR as init recorded it, and the gh command that merges it; refused unless it is open. */
export declare function setupPrMerge(file: string, root: string, run: Run): {
    number: number;
    url: string;
    repo: string;
    command: string[];
};
/**
 * INVARIANT: what the setup-mode command prints and opens never carries the dashboard's key: the URL is #357's
 * key-free wizard URL, and only the key file's path is named (the page asks for the key once, in a hidden field).
 */
export declare function setupModeLines(root: string, port: number): {
    url: string;
    lines: string[];
};
