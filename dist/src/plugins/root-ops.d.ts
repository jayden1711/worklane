import { type Inspection } from './inspect.js';
import { type TreeLimits } from './tree.js';
import { type Allowlist, type ApprovalRecord, canonicalJson, type McpRuntime, type PendingEntry, type PluginRecord } from './approval.js';
import { type Snapshot } from '../mcp/snapshot.js';
export declare class PluginOpError extends Error {
}
/** Limits for an npm MCP server's tree (its node_modules): larger than a plugin's. */
export declare const NPM_TREE_LIMITS: TreeLimits;
/** A plugin's preview: what the owner reviews before staging, written by root, readable by all. */
export interface PluginPreview {
    v: 1;
    kind: 'plugin';
    instance: string;
    id: string;
    source: PluginRecord['source'];
    fetched_at: string;
    inspection: Omit<Inspection, 'files'> & {
        files: {
            path: string;
            mode: string;
            size: number;
            sha256: string;
        }[];
    };
    /** Set when the inspection passed: the approved copy's hash and the changes made to it. */
    materialized: {
        tree: string;
        transform: string[];
    } | null;
}
/** An MCP server's preview: how it starts, and what it showed the model when started in quarantine. */
export interface McpPreview {
    v: 1;
    kind: 'mcp';
    instance: string;
    id: string;
    runtime: McpRuntime;
    /** Env names its config sets (a plugin's server): what its secrets are likely to be called. */
    envNames: string[];
    fetched_at: string;
    snapshot: Snapshot | null;
    /** Why there is no snapshot (it couldn't list its tools without its secrets, say). */
    snapshotError: string | null;
    /** Taken with the server's installed secrets and approved network (the second approval), or with neither. */
    snapshotWithSecrets: boolean;
    /** The network the snapshot was taken with (none in quarantine). */
    snapshotNetwork: string[];
    flags: string[];
    /** Why it can't be approved at all, or empty. */
    refusals: string[];
}
export type Preview = PluginPreview | McpPreview;
/** Write a file as root keeps them: 0644, through a temp name and a rename. */
export declare function writePublic(file: string, data: string): void;
/** What an MCP server stage adds to its record: the hosts it may reach and its secrets' names. */
export interface McpStageInputs {
    network: string[];
    secrets: string[];
}
/** The record a preview and the owner's choices make. Throws when the preview has nothing approvable. */
export declare function recordOf(p: Preview, roles: string[], mcp?: McpStageInputs): ApprovalRecord;
export declare function readPreview(instance: string, id: string): Preview;
/**
 * Whether this instance may start another fetch, or another snapshot or preview, now (Q13 and the owner's condition on
 * mcp-preview and mcp-snapshot: each kind rate-capped per instance per hour), recording it when it may.
 */
export declare function takeFetchSlot(instance: string, kind?: 'fetch' | 'snapshot', now?: number): void;
/**
 * Root, after the throwaway user's fetch: inspect `from` (never executing it), and when it passes, materialize the
 * approved copy into the instance's preview directory, replacing any earlier preview of that id. `from` must already
 * be root's (plugins.sh chowns it, links untouched, before calling this).
 */
export declare function ingest(o: {
    instance: string;
    id: string;
    source: PluginRecord['source'];
    from: string;
    approvedIds?: Set<string>;
}): PluginPreview;
/** Flags for a snapshot: what its text asks for, and the schema keywords the broker can't enforce. */
export declare function mcpFlags(s: Snapshot | null, otherTools?: string[]): string[];
/** The code an MCP server runs, where it is approved: its plugin's copy in the store, or its own npm tree. */
export declare function mcpCodeDir(instance: string, id: string, runtime: McpRuntime): string;
/**
 * Root: an MCP server preview for a server inside an approved plugin. Its code is that plugin's approved copy (no
 * fetch); `snapshot` is what it showed when started in quarantine (src/mcp/quarantine.ts), or why it couldn't.
 */
export declare function previewPluginServer(o: {
    instance: string;
    id: string;
    plugin: string;
    server: string;
    snapshot: {
        snapshot: Snapshot | null;
        error: string | null;
        withSecrets: boolean;
        network: string[];
    };
    allowlistOwnerUid?: number;
}): McpPreview;
/**
 * Root: an MCP server preview for a pinned npm package the throwaway user installed at `from` (src/mcp/npm.ts checked
 * its integrity and install scripts there). Its tree is copied into the preview, root's.
 */
export declare function previewNpmServer(o: {
    instance: string;
    id: string;
    from: string;
    runtime: Omit<Extract<McpRuntime, {
        type: 'npm';
    }>, 'tree'>;
    refusals: string[];
    snapshot: {
        snapshot: Snapshot | null;
        error: string | null;
        withSecrets: boolean;
        network: string[];
    };
}): McpPreview;
/** Root: record a snapshot (or why there is none) in an MCP server's preview. */
export declare function setPreviewSnapshot(instance: string, id: string, snap: {
    snapshot: Snapshot | null;
    error: string | null;
    withSecrets: boolean;
    network: string[];
}): McpPreview;
/** The previewed code of an MCP server: its npm tree in the preview, or its plugin's approved copy. */
export declare const previewCodeDir: (p: McpPreview) => string;
/**
 * Stage an approval (the helper's plugin-stage or mcp-stage, for the asking coordinator's instance): only when the
 * digest is the one the preview and these choices make now, so what is staged is what the owner reviewed. Grants nothing.
 */
export declare function stage(o: {
    instance: string;
    id: string;
    roles: string[];
    digest: string;
    by: string;
    mcp?: McpStageInputs;
    now?: number;
}): PendingEntry;
/** Take a staged approval back out (the helper's plugin-withdraw). */
export declare function withdraw(o: {
    instance: string;
    id: string;
    by: string;
}): boolean;
/** What confirm will write, for the admin to read before typing the id back. Throws when it can't be confirmed. */
export declare function confirmPlan(o: {
    instance: string;
    id: string;
    digest: string;
    allowlistOwnerUid?: number;
}): {
    record: ApprovalRecord;
    pending: PendingEntry;
};
/**
 * Confirm a staged approval: root only (plugins.sh confirm, at a root shell, after the id was typed back). Copies the
 * previewed files into the store, checks their hash there, and writes the allowlist entry (replacing an earlier pin
 * of the same id: an update is a new approval).
 */
export declare function confirm(o: {
    instance: string;
    id: string;
    digest: string;
    by: string;
    allowlistOwnerUid?: number;
}): Allowlist;
/** Remove an approved entry (the helper's plugin-remove): only ever deletes. Its store copy stays for runs in flight. */
export declare function remove(o: {
    instance: string;
    id: string;
    by: string;
    allowlistOwnerUid?: number;
}): boolean;
/** The record printed for the admin before they type the id back: every field, one per line. */
export declare function describeRecord(r: ApprovalRecord, digest: string): string;
export { canonicalJson };
