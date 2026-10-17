import { HOOK_MARKER, type Settings } from './agent-settings.js';
import { type Config } from './config/load.js';
export { HOOK_MARKER };
export declare const GIT_HOOK_MARKER: string;
/** The engine's packaged templates directory. */
export declare function templatesDir(): string;
/** What a human session is told when the engine the hooks point at is missing. */
export declare function missingEngineWarning(enginePath: string): string;
/**
 * Hook command (POSIX sh; Claude Code runs hooks through bash on every OS).
 * A crashing engine always blocks (`|| exit 2`). A missing engine blocks
 * agent sessions; a human session gets a one-line warning at session start
 * and is otherwise unaffected.
 */
export declare function hookCommand(enginePath: string, event: string): string;
/** Engine entry as Claude Code should call it: relative to $CLAUDE_PROJECT_DIR when inside the project. */
export declare function engineRef(root: string, engineCli: string): string;
export declare function mergeSettings(existing: Settings, enginePath: string, preApproved: string[], domains: string[], secretPaths?: string[]): Settings;
export declare function gitRemoteRepo(root: string): string | null;
/** owner/name from a GitHub remote URL (https or ssh); null for anything else. */
export declare const githubRepoOf: (url: string) => string | null;
/**
 * The engine as installed in the project's node_modules, if present. Preferred
 * over the running engine's own path, which Node resolves through symlinks
 * (npm link, workspaces) to a machine-specific location.
 */
export declare function projectLocalEngine(root: string): string | null;
/**
 * The config folder from the templates, at `cfgDir`: the project's name and repo filled in, and, when given, its
 * owner (else the template's placeholder stays, for the person to set) and default branch.
 */
export declare function scaffoldConfig(cfgDir: string, o: {
    name: string;
    repo: string;
    owner?: string;
    defaultBranch?: string;
}): void;
export interface InstallOptions {
    root: string;
    /** Path to the engine's cli.js (defaults to this running engine). */
    engineCli?: string;
    gitHooks?: boolean;
    /**
     * The instance whose agents run this checkout: the hooks and rules go to its agent settings (in its home, which
     * only the coordinator user can read), never into the checkout.
     */
    instance?: string;
}
export interface InstallReport {
    scaffolded: boolean;
    settingsPath: string;
    gitHook?: string;
    /** The pre-push hook that refuses a push to the default branch. */
    prePushHook?: string;
    notes: string[];
}
/**
 * The engine as it was invoked, following one link only: a machine-wide command (/usr/local/bin/<cli> -> a stable
 * /opt/<cli>/current/... path) stays on the stable path, not the versioned release Node resolves it to, which an
 * engine update removes.
 */
export declare function invokedEngine(argv1?: string | undefined): string | undefined;
/** The hooks and rules for an instance's agent runs: our entries only, with every hook kept on. */
export declare function agentSettings(enginePath: string, preApproved: string[], domains: string[], secretPaths: string[]): Settings;
export declare function install(opts: InstallOptions): InstallReport;
/** WHY: `install --git-hooks` and the first-run page's Fix install the same hooks, from one place. */
export declare function installGitHooks(root: string, cfg: Config, engineCli?: string): {
    gitHook: string;
    prePushHook?: string;
    notes: string[];
};
/**
 * The pre-push hook in the repo's common hooks dir (every worktree's), refusing any push to the default branch:
 * `branches` (the config's, when there is one) and whatever origin/HEAD names at push time.
 */
export declare function installCheckoutPrePush(root: string, branches: string[], engineCli?: string, node?: string): string;
/** gitleaks pre-commit hook in the repo's common hooks dir, chaining any existing hook. */
export declare function installGitHook(root: string): string;
