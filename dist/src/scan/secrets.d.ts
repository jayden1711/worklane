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
