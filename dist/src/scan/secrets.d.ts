export interface Finding {
    rule: string;
    file: string;
    line: number;
}
export type ScanResult = {
    status: 'clean';
} | {
    status: 'leaks';
    findings: Finding[];
} | {
    status: 'unavailable';
    error: string;
};
/** Scan a file or directory. Findings never include the secret itself. */
export declare function scanPath(path: string, binary?: string | null): ScanResult;
/** Scan what a `git commit` is about to record: staged changes, plus unstaged ones for `commit -a`. */
export declare function scanCommit(cwd: string, includeUnstaged: boolean, binary?: string | null): ScanResult;
/**
 * Scan exactly what a change adds: the commits in `range` (e.g. base..head).
 * Async, so a long scan doesn't stall the coordinator's other runs. Scanning
 * the commits rather than the worktree keeps dependencies (node_modules and
 * their bundled test keys) out of it.
 */
export declare function scanRange(cwd: string, range: string, binary?: string | null): Promise<ScanResult>;
