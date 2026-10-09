/** Leading env assignment that marks our hook commands (the shell ignores it otherwise). */
export declare const HOOK_MARKER: string;
export declare const GIT_HOOK_MARKER: string;
/** The engine's packaged templates directory. */
export declare function templatesDir(): string;
export declare const MISSING_ENGINE_WARNING: string;
/**
 * Hook command (POSIX sh; Claude Code runs hooks through bash on every OS).
 * A crashing engine always blocks (`|| exit 2`). A missing engine blocks
 * agent sessions; a human session gets a one-line warning at session start
 * and is otherwise unaffected.
 */
export declare function hookCommand(enginePath: string, event: string): string;
/** Engine entry as Claude Code should call it: relative to $CLAUDE_PROJECT_DIR when inside the project. */
export declare function engineRef(root: string, engineCli: string): string;
interface HookEntry {
    matcher?: string;
    hooks: {
        type: 'command';
        command: string;
        timeout?: number;
    }[];
}
type Settings = Record<string, unknown> & {
    hooks?: Record<string, HookEntry[]>;
    permissions?: {
        allow?: string[];
        deny?: string[];
        ask?: string[];
    } & Record<string, unknown>;
};
export declare function mergeSettings(existing: Settings, enginePath: string, preApproved: string[], domains: string[], stopTimeoutS: number, secretPaths?: string[]): Settings;
/**
 * The engine as installed in the project's node_modules, if present. Preferred
 * over the running engine's own path, which Node resolves through symlinks
 * (npm link, workspaces) to a machine-specific location.
 */
export declare function projectLocalEngine(root: string): string | null;
export interface InstallOptions {
    root: string;
    /** Path to the engine's cli.js (defaults to this running engine). */
    engineCli?: string;
    gitHooks?: boolean;
}
export interface InstallReport {
    scaffolded: boolean;
    settingsPath: string;
    gitHook?: string;
    notes: string[];
}
export declare function install(opts: InstallOptions): InstallReport;
/** gitleaks pre-commit hook in the repo's common hooks dir, chaining any existing hook. */
export declare function installGitHook(root: string): string;
export {};
