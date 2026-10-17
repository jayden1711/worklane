import { type TreeFile, type TreeLimits } from './tree.js';
export interface McpServerSpec {
    /** The server key in the plugin's config. */
    name: string;
    /** argv with ${CLAUDE_PLUGIN_ROOT} kept as written; the broker resolves it against the materialized directory. */
    argv: string[];
    /** Environment variable names the config sets (values are never shown: they can carry credentials). */
    envNames: string[];
    /** Where it was declared. */
    from: string;
}
export interface Inspection {
    name: string | null;
    version: string | null;
    refusals: string[];
    skills: string[];
    agents: string[];
    commands: string[];
    outputStyles: string[];
    bin: string[];
    mcpServers: McpServerSpec[];
    /** userConfig option names (non-sensitive only; a sensitive one is a refusal). */
    options: string[];
    /** Things the owner should look at, not refusals: env vars, home paths and URLs that the plugin's text names. */
    flags: string[];
    files: TreeFile[];
    /** wl-tree-v1 of the directory as fetched; null when it can't be hashed (that is a refusal too). */
    tree: string | null;
}
export interface InspectOptions {
    /** Plugin ids (`name` or `name@marketplace`) already approved for this instance: the only dependencies allowed. */
    approved?: ReadonlySet<string>;
    limits?: TreeLimits;
}
type Json = unknown;
/** The YAML frontmatter of a Markdown file, and its body. A file with no frontmatter has `{}`. */
export declare function frontmatter(text: string): {
    data: Record<string, Json>;
    body: string;
    error?: string;
};
/** Inline shell Claude Code would run while rendering a skill or command: `` !`cmd` `` at a line start or after
 * whitespace, and ```! fenced blocks (skills docs, "Inject dynamic context"). */
export declare function hasInlineShell(body: string): boolean;
/** Inspect a fetched plugin directory. Never throws for anything the plugin contains: that is a refusal. */
export declare function inspectPlugin(root: string, opts?: InspectOptions): Inspection;
/** Whether a directory looks like a plugin root at all (a manifest or any default component). */
export declare function looksLikePlugin(root: string): boolean;
export {};
