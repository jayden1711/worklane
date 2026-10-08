export interface LockInfo {
    pid: number;
    owner: string;
    acquiredAt: string;
}
export interface Lock {
    path: string;
    release(): void;
}
/** Try once. Returns the lock, or the current holder if it's busy. */
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
