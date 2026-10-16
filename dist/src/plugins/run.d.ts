import { type AllowlistEntry } from './approval.js';
/** The instance's own switch-off list (the dashboard's Disable; it can only remove what root approved). */
export declare const PLUGINS_OFF_FILE = "plugins-off.yaml";
export declare class PluginRunError extends Error {
}
export interface PluginRun {
    /** --plugin-dir for each, from root's store. */
    dirs: string[];
    /** The ids, for the run record. */
    ids: string[];
    /** CLAUDE_CODE_PLUGIN_CACHE_DIR: the instance's empty, root-owned plugins root; null when root hasn't made one yet. */
    pluginRoot: string | null;
}
/** The ids the owner switched off. A file that can't be read or parsed switches every plugin off (it only tightens). */
export declare function pluginsOff(instanceHome: string): {
    off: Set<string>;
    all: boolean;
    problem: string | null;
};
/**
 * The plugins one run of `role` loads. Throws PluginRunError (the run doesn't start) when the allowlist can't be
 * trusted (src/plugins/approval.ts readAllowlist) or an approved copy doesn't hash to its approved value.
 */
export declare function pluginsForRun(o: {
    instance: string;
    instanceHome: string;
    role: string;
    allowlistOwnerUid?: number;
    entries?: AllowlistEntry[];
}): PluginRun;
/** What a session's init event says it loaded, as the runner checks it. */
export interface InitLoaded {
    plugins?: {
        name?: string;
        path?: string;
        source?: string;
    }[];
    mcp_servers?: {
        name?: string;
        source?: string;
    }[];
}
/**
 * Why a session's init event shows something loaded that the run didn't pass, or null. Claude Code's own built-in
 * plugins (path "builtin") are part of the CLI the machine already runs, and are allowed.
 */
export declare function loadedSetProblem(init: InitLoaded, expected: {
    pluginDirs: string[];
    mcpServers: string[];
}): string | null;
