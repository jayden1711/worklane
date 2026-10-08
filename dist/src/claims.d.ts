export interface Lease {
    instance: string;
    run_id: string;
    issue: number;
    expires_at: string;
    base: string;
}
export interface ClaimOptions {
    /** A clone of the project repo; the coordinator's own checkout. */
    repo: string;
    remote?: string;
}
export declare const claimRef: (issue: number) => string;
/** The current lease on an issue, read from the remote (never a local cache). */
export declare function readClaim(issue: number, opts: ClaimOptions): {
    sha: string;
    lease: Lease;
} | null;
export type ClaimResult = {
    won: true;
    sha: string;
} | {
    won: false;
    holder: Lease | null;
};
export declare function claim(lease: Lease, opts: ClaimOptions, now?: number, graceMs?: number): ClaimResult;
export declare function renew(lease: Lease, currentSha: string, opts: ClaimOptions): string | null;
export declare function release(issue: number, currentSha: string, opts: ClaimOptions): boolean;
