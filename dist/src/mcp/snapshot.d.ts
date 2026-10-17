export interface SnapshotTool {
    name: string;
    title?: string | undefined;
    description?: string | undefined;
    inputSchema: unknown;
    outputSchema?: unknown;
    annotations?: unknown;
}
/** What is approved of one MCP server: what reaches the model, and nothing that varies between runs. */
export interface Snapshot {
    serverName: string | null;
    instructions: string | null;
    /** Sorted by name. */
    tools: SnapshotTool[];
}
/** A snapshot from an initialize result and the tools of every tools/list page. */
export declare function snapshotOf(init: {
    serverInfo?: {
        name?: unknown;
    };
    instructions?: unknown;
} | null, tools: unknown[]): Snapshot;
export declare const snapshotHash: (s: Snapshot) => string;
export interface SnapshotDiff {
    added: string[];
    removed: string[];
    changed: {
        name: string;
        fields: string[];
    }[];
    instructions: boolean;
    serverName: boolean;
}
/** What changed between an approved snapshot and a live one, for the incident and the review page. */
export declare function diffSnapshots(approved: Snapshot, live: Snapshot): SnapshotDiff;
/** Why each part of a snapshot deserves a second look: one line per finding. */
export declare function snapshotFlags(s: Snapshot, otherTools?: string[]): string[];
/** Make invisible characters visible as ⟨U+XXXX⟩, for showing a description exactly as approved, never hiding any. */
export declare function revealInvisible(text: string): string;
