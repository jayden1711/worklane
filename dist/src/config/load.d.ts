import { type AgentsConfig, type DeployConfig, type GuardrailsConfig, type ProjectConfig, type ReviewConfig, type TestsConfig } from './schema.js';
export interface Config {
    root: string;
    dir: string;
    project: ProjectConfig;
    agents: AgentsConfig;
    guardrails: GuardrailsConfig;
    tests: TestsConfig;
    review?: ReviewConfig;
    deploy?: DeployConfig;
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
