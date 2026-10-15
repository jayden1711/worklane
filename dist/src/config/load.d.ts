import { type BenchmarksConfig } from '../optimize.js';
import { type AgentsConfig, type AppConfig, type DeployConfig, type GuardrailsConfig, type ProjectConfig, type ReviewConfig, type TestsConfig } from './schema.js';
export interface Config {
    root: string;
    dir: string;
    project: ProjectConfig;
    agents: AgentsConfig;
    guardrails: GuardrailsConfig;
    tests: TestsConfig;
    review?: ReviewConfig;
    deploy?: DeployConfig;
    /** The project's app, for browser checks; absent: browser checks are off (Track B is inactive). */
    app?: AppConfig;
    /** The project's declared benchmarks, for the weekly optimization pass (src/optimize.ts); absent: none. */
    benchmarks?: BenchmarksConfig;
    /** Role prompts (roles/<role>.md by role) as committed, for a config read from git; absent: read from `dir`. */
    roles?: Record<string, string>;
}
export interface ConfigError {
    file: string;
    path: string;
    message: string;
}
export declare class ConfigInvalid extends Error {
    readonly errors: ConfigError[];
    constructor(errors: ConfigError[]);
}
/** Load and validate every config file. Throws ConfigInvalid listing all errors. */
export declare function loadConfig(root: string): Config;
/**
 * The config committed at `rev` (e.g. origin/main), read from git and never from the working tree: the same files,
 * schema and checks as loadConfig. Throws ConfigInvalid listing all errors. `dir` stays the checkout's.
 */
export declare function loadConfigAt(root: string, rev: string): Config;
/** Parse, validate and cross-check every config file `read` returns (null: the file is absent). */
export declare function configFrom(root: string, read: (file: string) => string | null): Config;
