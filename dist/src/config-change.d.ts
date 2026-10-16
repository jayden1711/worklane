import { type Config } from './config/load.js';
export interface RepoConfigValues {
    writers: string[];
    required_checks: string[];
    daily_budget_usd: number;
    workers_count: number;
    workers_model: string;
    /** Which CI judges a PR (#469): github (required_checks), or none (this machine's test runs, src/ci-none.ts). */
    ci: 'github' | 'none';
}
/**
 * WHY (#468): the models the form offers the workers, from the engine's own list (the tiers routing and the model cap
 * know), and the one the engine builds with by default; the page reads both from here, never a copy of its own.
 */
export declare const WORKER_MODELS: readonly string[];
export declare const DEFAULT_WORKER_MODEL: string;
export declare function repoConfigValues(cfg: Config): RepoConfigValues;
export interface RepoConfigForm {
    values: RepoConfigValues;
    owner: string;
    /** The default branch the change is proposed against. */
    branch: string;
    repo: string;
    /** The workers' models the form offers, and the engine's default among them. */
    models: readonly string[];
    defaultModel: string;
    /** Whether the config's worker model is one the engine lists (an alias, or a full Anthropic model id). */
    modelListed: boolean;
}
export declare const repoConfigForm: (cfg: Config) => RepoConfigForm;
export declare class ConfigChangeError extends Error {
}
export interface ConfigChange {
    file: string;
    key: string;
    from: unknown;
    to: unknown;
}
type Git = (args: string[], cwd: string) => {
    status: number | null;
    stdout: string;
    stderr: string;
};
/**
 * The config files `show` gives with these values applied (only the files they change, comments kept), and what
 * changes. WHY (#468): the same edit for the default branch's config and for setup mode's held draft.
 */
export declare function applyConfigValues(show: (file: string) => string | null, now: RepoConfigValues, values: Partial<Record<keyof RepoConfigValues, unknown>>, where: string): {
    texts: Record<string, string>;
    changes: ConfigChange[];
    read: (f: string) => string | null;
};
/** What these values would change on the default branch, checked like any config; nothing is written. */
export declare function planConfigChange(o: {
    root: string;
    cfg: Config;
    values: Partial<Record<keyof RepoConfigValues, unknown>>;
    git?: Git;
}): ConfigChange[];
export interface ProposeIo {
    git: Git;
    gh: (args: string[], cwd: string) => {
        status: number | null;
        stdout: string;
        stderr: string;
    };
    now?: () => Date;
}
/**
 * Propose the change as a PR: a scratch worktree of origin/<default>, the edited files, the config loaded from it,
 * one commit, pushed to a branch of its own (never the default branch), and a PR opened. The worktree is removed after.
 */
export declare function proposeConfigChange(o: {
    root: string;
    cfg: Config;
    values: Partial<Record<keyof RepoConfigValues, unknown>>;
    by: string;
    io?: Partial<ProposeIo>;
}): {
    changes: ConfigChange[];
    branch: string;
    url: string;
    head: string;
};
/** The branch prefix the form proposes from: the only PRs its Merge takes. */
export declare const CONFIG_BRANCH_PREFIX: string;
export {};
