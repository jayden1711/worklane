export declare const TREE_PREFIX = "wl-tree-v1:sha256:";
/** Limits that bound what a plugin may be (and what one hash pass reads). */
export interface TreeLimits {
    maxFiles: number;
    maxBytes: number;
}
export declare const DEFAULT_TREE_LIMITS: TreeLimits;
export declare class TreeError extends Error {
}
export interface TreeFile {
    path: string;
    mode: '644' | '755';
    size: number;
    sha256: string;
}
/** Every regular file under `root`, with its mode class and content hash, in wl-tree-v1 order. Throws TreeError. */
export declare function treeFiles(root: string, limits?: TreeLimits): TreeFile[];
/** The wl-tree-v1 hash of a list of files (already in order). */
export declare function treeHashOf(files: readonly TreeFile[]): string;
/** The wl-tree-v1 hash of the directory at `root`. Throws TreeError for anything it can't hash. */
export declare function treeHash(root: string, limits?: TreeLimits): string;
