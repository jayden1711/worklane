export interface LockInfo {
    pid: number;
    owner: string;
    acquiredAt: string;
    /** A test-run slot: the longest the run can take once it holds it (its setup and tiers' caps), for the updater's drain. */
    limit_ms?: number;
}
export interface Lock {
    path: string;
    release(): void;
}
/**
 * A takeover's claim counts as abandoned when its owner is dead or it is
 * older than this. A takeover takes microseconds; this bounds how long a
 * crashed one can block the lock.
 */
export declare const CLAIM_ABANDONED_MS = 60000;
/**
 * Try once. Returns the lock, or the current holder if it's busy.
 *
 * The lock's contents are written to a private temp file and hard-linked
 * into place, so the lock appears whole or not at all (link fails if the
 * lock exists). A competitor never reads a half-written lock and mistakes
 * it for a stale one.
 *
 * Taking over a stale lock (its owner is dead) never removes a lock this
 * process didn't inspect. It first claims that exact stale lock: a claim
 * file named after a hash of its contents, which only one process can
 * create. Holding the claim, it re-reads the lock and removes it only if it
 * is still that stale lock. No one else may remove that one while the claim
 * stands, so it can't be replaced in between; a fresh lock is never removed.
 * Then it competes for the free lock like anyone else.
 *
 * Residual: a claim is cleared as abandoned when its owner is dead or it is
 * older than CLAIM_ABANDONED_MS. Two holders remain possible only if a
 * takeover stalls for longer than that between claiming and removing, or if
 * its owner dies in that step and two others then clear its claim at once.
 * (Established libraries accept a wider gap: proper-lockfile removes a stale
 * lock without such a check and detects a doubly taken lock afterwards.)
 */
/** Points inside a takeover where tests interleave other processes' steps. */
export interface TakeoverHooks {
    /** A stale lock was read and judged stale. */
    inspected?(): void;
    /** The takeover's exclusive step is done, before it is acted on. */
    taking?(): void;
}
export declare function tryLock(path: string, owner: string, hooks?: TakeoverHooks, extra?: Pick<LockInfo, 'limit_ms'>): {
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
