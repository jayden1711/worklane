/** Why `name` can't be a project variable, or null when it can. */
export declare function projectEnvProblem(name: string): string | null;
/** The variables that pass projectEnvProblem; anything else is dropped (the config check already refused it). */
export declare function safeProjectEnv(env: Record<string, string> | undefined): Record<string, string>;
