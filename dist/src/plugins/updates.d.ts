import type { AllowlistEntry } from './approval.js';
import type { Preview } from './root-ops.js';
import { diffSnapshots } from '../mcp/snapshot.js';
export declare const UPDATES_FILE = "plugin-updates.json";
export declare const UPDATE_EVERY_MS: number;
export interface PluginUpdate {
    id: string;
    kind: 'plugin' | 'npm';
    from: string;
    to: string;
    /** What "Fetch the update" asks for. */
    fetch: Record<string, string>;
}
type FetchJson = (url: string) => Promise<unknown>;
/** owner/repo of a github.com git URL, or null (other hosts are checked by hand). */
export declare const githubRepoOfUrl: (url: string) => string | null;
/** What is newer than each approved entry's pin. Errors for one entry skip it, never the others. */
export declare function checkUpdates(entries: readonly AllowlistEntry[], fetchJson?: FetchJson): Promise<PluginUpdate[]>;
/**
 * The cached updates, refreshed in the background when older than a day. Returns what is cached now (the page shows
 * it; the next load shows the refreshed list).
 */
export declare function cachedUpdates(stateDir: string, entries: readonly AllowlistEntry[], o?: {
    now?: number;
    fetchJson?: FetchJson;
}): {
    at: string | null;
    updates: PluginUpdate[];
};
export interface PreviewDiff {
    added: string[];
    removed: string[];
    changed: string[];
    tools?: ReturnType<typeof diffSnapshots> | undefined;
}
/** How a preview differs from the approved entry with its id: files for a plugin, tools for an MCP server. */
export declare function previewDiff(instance: string, p: Preview, approved: AllowlistEntry | undefined): PreviewDiff | null;
export {};
