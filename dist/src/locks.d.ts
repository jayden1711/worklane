export interface LockInfo {
    pid: number;
    owner: string;
    acquiredAt: string;
}
export interface Lock {
    path: string;
    release(): void;
}
/**
 * Try once. Returns the lock, or the current holder if it's busy.
 *
 * The lock's contents are written to a private temp file and hard-linked
 * into place, so the lock appears whole or not at all (link fails if the
 * lock exists). A competitor never reads a half-written lock and mistakes
 * it for a stale one. Taking over a stale lock renames it aside first:
 * only one process can win that rename, and if what it moved isn't the
 * stale lock it inspected, it puts it back.
 */
export declare function tryLock(path: string, owner: string): {
    lock: Lock;
} | {
    holder: LockInfo | null;
};
/** Wait up to waitMs for the lock. Never returns "success" without holding it. */
export declare function acquireLock(path: string, owner: string, waitMs: number, pollMs?: number): Promise<{
    lock: Lock;
} | {
    holder: LockInfo | null;
}>;
