import { type HeldDraft, type Question } from './auto-config.js';
import { type ConfigChange, type RepoConfigValues } from './config-change.js';
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
/** What the preview shows first, in plain words: read from the drafted files themselves, never from elsewhere. */
export interface DraftSummary {
    owner: string;
    writers: string[];
    /** The test commands by slot (worktree setup, runner.full / changed / one); unset ones left out. */
    tests: {
        slot: string;
        command: string;
    }[];
    dailyBudgetUsd: number;
    /** Each enabled role and its model. */
    models: {
        role: string;
        model: string;
    }[];
    /** What waits for the owner, and what may merge by itself. */
    waits: string[];
    autoMerge: string;
}
/**
 * WHY (#468): the plain-language summary of a held draft, from the same files the preview lists below it (and
 * Confirm proposes): owners and writers, test commands, the daily budget, the models per role, the review levels.
 */
export declare function draftSummary(root: string, d: HeldDraft): DraftSummary;
/** The held draft as the page previews it: its summary and its files (read-only), or why it doesn't load. */
export declare function draftView(root: string, d: HeldDraft | null | undefined): {
    summary: DraftSummary | null;
    error: string | null;
    files: {
        name: string;
        text: string;
    }[];
    values: RepoConfigValues | null;
    at: string;
} | null;
/**
 * WHY (#468): Change on the preview, the Repo config form's values applied to the held draft (comments kept): what
 * they change, and with confirm, the draft changed, checked with the same loader first. Nothing is pushed.
 */
export declare function editDraft(file: string, root: string, values: Record<string, unknown>, confirm: boolean): ConfigChange[];
/** WHY (#468): Confirm on the preview: the held draft proposed as the setup PR (auto-config's own push and PR). */
export declare function proposeDraft(o: {
    file: string;
    root: string;
    io?: InitIo;
}): Promise<{
    number: number;
    url: string;
    head: string | null;
}>;
/**
 * INVARIANT: what the setup-mode command prints and opens never carries the dashboard's key: the URL is #357's
 * key-free wizard URL, and only the key file's path is named (the page asks for the key once, in a hidden field).
 */
export declare function setupModeLines(root: string, port: number, o?: {
    bold?: boolean;
}): {
    url: string;
    lines: string[];
};
