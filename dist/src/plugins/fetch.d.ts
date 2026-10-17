import { type Inspection } from './inspect.js';
import { type TreeFile } from './tree.js';
export declare const SHA: RegExp;
/** An https git URL on a named host: no credentials in it, no query, no fragment. */
export declare const GIT_URL: RegExp;
/** A subdirectory inside the repository: plain segments only. */
export declare const SUBDIR: RegExp;
export interface GitSource {
    url: string;
    sha: string;
    /** The plugin's directory inside the repository; the root when unset. */
    path?: string;
}
export declare class FetchError extends Error {
}
/** Why a source can't be fetched, or null. */
export declare function sourceProblem(s: GitSource, o?: {
    allowFileUrls?: boolean;
}): string | null;
/**
 * git, with nothing from the machine or the user: no system or global config, no prompts, no hooks, no LFS; no
 * redirect followed (a host can't send the fetch elsewhere); and, when `pin` is given (host:443:address), only that
 * address for that host (http.curloptResolve), so DNS can't change it after it was checked (src/plugins/hosts.ts).
 */
export declare function gitSafety(allowFile: boolean, pin?: string): string[];
/**
 * Fetch `s` into `dest` (which must not exist): the files of exactly that commit, at `s.path`, with no .git. Symlinks
 * are copied as symlinks so the tree hash refuses them; nothing is followed. Throws FetchError.
 */
export declare function fetchGitPlugin(s: GitSource, dest: string, o?: {
    allowFileUrls?: boolean;
    pin?: string;
}): void;
export interface Materialized {
    tree: string;
    files: TreeFile[];
    /** Each change made to the plugin as fetched, in words, for the approval record and the review page. */
    transform: string[];
}
/**
 * The approved copy of an inspected plugin, at `dest` (must not exist): its files as inspected, minus its MCP server
 * config, which the broker runs in Claude Code's place (.mcp.json removed; `mcpServers` removed from plugin.json and
 * the files it names). Refuses a plugin with refusals, or one whose files changed since inspection.
 */
export declare function materialize(src: string, ins: Inspection, dest: string): Materialized;
