/** Used when a repo lists none: lockfiles, registries and changelogs, shared test helpers. */
export declare const DEFAULT_HOTSPOTS: string[];
/** The hotspots among `files`, by the repo's globs (or the defaults). */
export declare function hotspotsIn(files: string[], globs?: string[]): string[];
/**
 * The repo files an issue is likely to touch, from its own text: paths it names (in backticks or bare,
 * matched against the repo's file list, by full path or by unique file name), plus the repo's lockfiles
 * when the issue is about dependencies. A cheap guess, never an agent run; an empty answer means "unknown".
 */
export declare function estimateFiles(text: string, repo: string[] | FileIndex, globs?: string[]): string[];
/** The repo's file list, indexed once and reused for every issue in a dispatch pass. */
export interface FileIndex {
    known: Set<string>;
    byName: Map<string, string[]>;
    hot: string[];
    lockfiles: string[];
}
export declare function fileIndex(repoFiles: string[], globs?: string[]): FileIndex;
export interface RunningTask {
    issue: number;
    hotspots: string[];
}
export interface Candidate {
    issue: number;
    hotspots: string[];
}
export type Hold = {
    issue: number;
    by: number;
    files: string[];
};
/**
 * Which ready tasks to start now, in order, given what's running and how many slots are free: a task whose
 * hotspots overlap a running (or just-picked) task's is held, with who holds it and why, and the next ready
 * task that doesn't overlap takes the slot, so no slot sits idle while other work could run.
 */
export declare function pickDispatch(ready: Candidate[], running: RunningTask[], freeSlots: number): {
    start: number[];
    held: Hold[];
};
/** The line shown for a held task (dashboard, event). */
export declare function holdReason(h: Hold): string;
