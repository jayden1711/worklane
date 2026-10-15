import { type Config } from './config/load.js';
export interface RepoConfigValues {
    writers: string[];
    required_checks: string[];
    daily_budget_usd: number;
    workers_count: number;
    workers_model: string;
}
export declare function repoConfigValues(cfg: Config): RepoConfigValues;
export interface RepoConfigForm {
    values: RepoConfigValues;
    owner: string;
    /** The default branch the change is proposed against. */
    branch: string;
    repo: string;
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
};
/** The branch prefix the form proposes from: the only PRs its Merge takes. */
export declare const CONFIG_BRANCH_PREFIX: string;
/**
 * The merge of a Repo config PR, as the page does it: only an open PR from one of the form's own branches into the
 * default branch, merged with the first method the repo allows. Refused otherwise; nothing is merged here.
 */
export declare function configPrMerge(o: {
    repo: string;
    base: string;
    number: unknown;
    gh: (args: string[]) => {
        status: number | null;
        stdout: string;
        stderr: string;
    };
}): {
    number: number;
    url: string;
    command: string[];
};
export {};
