export interface GpuHoldDeps {
    /** Root's file (tests: one of their own) and the uid that must own it. */
    file?: string;
    rootUid?: number;
    lockPath?: (index: number) => string;
    err?: (line: string) => void;
}
/** The arguments: --gpu indices (before `--`), and the command after it. */
export declare function parseGpuHold(args: readonly string[]): {
    gpus: number[];
    command: string[];
} | {
    error: string;
};
/** Whether this user is refused a lock (EACCES/EPERM on its directory or the file), as a non-member of the GPU group is. */
export declare function lockDenied(path: string): boolean;
/** Who holds a GPU's lock, as far as this user can tell: the helper's note in the file, and the holders' pids. */
export declare function gpuHolder(path: string): string;
/** Run `gpu hold`; its exit code is the command's (2 for a usage or setup problem, nothing run). */
export declare function gpuHoldCommand(args: readonly string[], d?: GpuHoldDeps): Promise<number>;
