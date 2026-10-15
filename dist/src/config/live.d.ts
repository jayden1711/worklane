import { type Config, type ConfigError } from './load.js';
/** The incident an invalid config on the default branch raises, by instance (resolved once a valid one is back). */
export declare const CONFIG_INCIDENT = "config_invalid";
/** The git tree of the config directory at `rev`, or null (no such rev, or no config there). */
export declare function configTree(repo: string, rev: string): string | null;
/** A setting that only takes effect at a restart: what is running, and what the default branch now says. */
export interface RestartSetting {
    path: string;
    running: unknown;
    wanted: unknown;
}
type Section = 'project' | 'agents' | 'guardrails' | 'tests' | 'review' | 'deploy' | 'app' | 'roles';
/**
 * Settings the engine reads once, at start, to build something that lives as long as the process: a change to one
 * on the default branch keeps the running value and says a restart is needed, never half-applied.
 * `restart`: whether this change needs one (absent: any change does).
 */
export declare const RESTART_ONLY: {
    path: string;
    why: string;
    restart?: (running: unknown, wanted: unknown) => boolean;
}[];
/** The new config as it can run now: every restart-only setting kept at its running value, and which ones those were. */
export declare function liveMerge(running: Config, wanted: Config): {
    cfg: Config;
    restart: RestartSetting[];
};
/** The top-level sections that differ between two configs (for the record). */
export declare function changedSections(a: Config, b: Config): Section[];
export type ConfigPoll = {
    kind: 'same';
}
/** The first poll: the default branch's config is the one running, and it validated (nothing to swap in). */
 | {
    kind: 'confirmed';
    sha: string | null;
}
/** The default branch's config is valid again (or back to the one running) after an invalid one. */
 | {
    kind: 'recovered';
    sha: string | null;
} | {
    kind: 'applied';
    sha: string;
    cfg: Config;
    restart: RestartSetting[];
    changed: Section[];
} | {
    kind: 'invalid';
    sha: string;
    errors: ConfigError[];
};
export interface LiveConfigOptions {
    repo: string;
    remote: string;
    branch: string;
    /** The config tree the running config was loaded from; absent: the checkout's HEAD (what loadConfig read). */
    tree?: string | null;
    /** Checks beyond the schema (an instance's: the repo may only tighten its policy). */
    check?: (cfg: Config) => ConfigError[];
}
/** The config at <remote>/<branch>, polled: a new tree is loaded and validated once, whatever it holds. */
export declare class LiveConfig {
    private readonly o;
    private good;
    private bad;
    /** Whether a poll has run: the first one validates the default branch's config even when it is the running one. */
    private polled;
    private readonly ref;
    constructor(o: LiveConfigOptions);
    /** Whether the default branch's config differs from the running one, and if so, the config to swap in. */
    poll(running: Config): ConfigPoll;
    private sha;
}
/**
 * The config to start with: the default branch's, read from git after a fetch, when it is there and valid;
 * otherwise the checkout's (`fallback`), and why. `tree` is what the running config was loaded from.
 */
export declare function startConfig(o: {
    repo: string;
    remote: string;
    fallback: Config;
    check?: (cfg: Config) => ConfigError[];
}): {
    cfg: Config;
    tree: string | null;
    note: string | null;
};
export {};
