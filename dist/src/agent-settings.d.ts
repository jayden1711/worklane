/** Leading env assignment that marks our hook commands (the shell ignores it otherwise). */
export declare const HOOK_MARKER: string;
/** The file in an instance's home that holds its agents' hooks and rules. */
export declare const AGENT_SETTINGS_FILE = "agent-settings.json";
export declare const agentSettingsPath: (instanceHome: string) => string;
/** The hook events every agent run must carry, each failing closed. */
export declare const GUARDED_EVENTS: readonly ["PreToolUse", "SessionStart", "SessionEnd"];
export interface HookEntry {
    matcher?: string;
    hooks: {
        type: 'command';
        command: string;
        timeout?: number;
    }[];
}
export type Settings = Record<string, unknown> & {
    hooks?: Record<string, HookEntry[]>;
    permissions?: {
        allow?: string[];
        deny?: string[];
        ask?: string[];
    } & Record<string, unknown>;
    env?: Record<string, string>;
    disableAllHooks?: boolean;
};
export declare class AgentSettingsError extends Error {
}
export interface HookCheck {
    event: string;
    ok: boolean;
    detail: string;
}
/**
 * Whether settings carry each guarded hook once, failing closed for agents, with its engine present.
 * `enginePath` maps the path in a command to a file on this machine (e.g. $CLAUDE_PROJECT_DIR expanded).
 */
export declare function hookChecks(s: Settings, enginePath?: (p: string) => string): HookCheck[];
/** Every way an instance's agent settings fall short: the hooks, and disableAllHooks pinned off. */
export declare function agentSettingsProblems(s: Settings): string[];
/** An instance's agent settings, checked. Missing, unreadable or incomplete: an error, never "no hooks". */
export declare function readAgentSettings(instanceHome: string): Settings;
/** A checkout's own .claude/settings.json, when it carries our hooks: where installs before agent settings put them. */
export declare function legacyProjectHooks(dir: string): boolean;
/** The command that writes an instance's agent settings, run as its coordinator user. */
export declare const installCommand: (instance: string, checkout: string) => string;
/**
 * The guardrail settings for an instance's agent runs: its agent settings, and nothing else. Hooks in a checkout's
 * own .claude/settings.json (where installs before agent settings put them) never stand in: without agent
 * settings, the run and the coordinator refuse to start, naming the command that fixes it.
 */
export declare function guardrailSettings(instanceHome: string, instance: string, checkout: string): Settings;
/**
 * Why an agent run in `cwd` must not start because of the checkout's .claude/settings.json, or null. Deny and ask
 * rules only tighten and hooks only add, so they're fine; an allow rule our settings don't have would widen what
 * the agent may do, and any other key (env, sandbox, additionalDirectories, defaultMode, ...) could loosen the run.
 * .claude/settings.local.json isn't checked: the runner loads project settings only (--setting-sources project).
 */
export declare function projectSettingsRefusal(cwd: string, ours: Settings): string | null;
/**
 * The settings one agent run gets with --settings: the instance's guardrails, the lane's own (its sandbox and deny
 * rules) and the run's harness variables, pinned so no project file can change them. disableAllHooks stays false.
 */
export declare function runSettings(ours: Settings, lane: object | undefined, pinnedEnv: Record<string, string>): Settings;
