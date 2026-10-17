// Crash-safe file locks: a lock is a file, created atomically, holding the
// owner's pid. A lock whose owner is dead is stale and can be taken over.
// Liveness, not a timeout, decides staleness (precedent: claude-code-merge-queue).
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pidAlive } from './os/index.js';
function readLock(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
/**
 * A takeover's claim counts as abandoned when its owner is dead or it is
 * older than this. A takeover takes microseconds; this bounds how long a
 * crashed one can block the lock.
 */
export const CLAIM_ABANDONED_MS = 60_000;
export function tryLock(path, owner, hooks = {}, extra = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const info = { pid: process.pid, owner, acquiredAt: new Date().toISOString(), ...extra };
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                linkSync(tmp, path);
                return {
                    lock: {
                        path,
                        release() {
                            const cur = readLock(path);
                            if (cur?.pid === process.pid && cur.acquiredAt === info.acquiredAt)
                                unlinkSync(path);
                        },
                    },
                };
            }
            catch (e) {
                if (e.code !== 'EEXIST')
                    throw e;
            }
            const seen = readFileSafe(path);
            if (seen === null)
                continue; // released in between: try again
            const holder = parseLock(seen);
            if (holder && pidAlive(holder.pid))
                return { holder };
            // Stale (dead owner, or unreadable): claim this exact stale lock before touching it.
            hooks.inspected?.();
            const claim = `${path}.${createHash('sha256').update(seen).digest('hex').slice(0, 16)}.claim`;
            const mine = `${tmp}.claim`;
            writeFileSync(mine, JSON.stringify({ pid: process.pid, at: Date.now() }));
            try {
                linkSync(mine, claim);
            }
            catch (e) {
                if (e.code !== 'EEXIST')
                    throw e;
                if (claimAbandoned(claim))
                    unlinkQuiet(claim); // its taker died or stalled; the next try claims it afresh
                continue; // another process is taking over this same stale lock
            }
            finally {
                unlinkQuiet(mine);
            }
            hooks.taking?.();
            try {
                // Ours alone to remove now: if the lock is still the stale one we read, nothing can replace it before this.
                if (readFileSafe(path) === seen)
                    unlinkQuiet(path);
            }
            finally {
                unlinkQuiet(claim);
            }
        }
        return { holder: readLock(path) };
    }
    finally {
        unlinkSync(tmp);
    }
}
function claimAbandoned(claim) {
    const c = parseLock(readFileSafe(claim) ?? '');
    return !c || typeof c.pid !== 'number' || !pidAlive(c.pid) || Date.now() - (c.at ?? 0) > CLAIM_ABANDONED_MS;
}
function unlinkQuiet(path) {
    try {
        unlinkSync(path);
    }
    catch {
        // already gone
    }
}
function readFileSafe(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
function parseLock(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
/** Wait up to waitMs for the lock. Never returns "success" without holding it. */
export async function acquireLock(path, owner, waitMs, pollMs = 250) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const r = tryLock(path, owner);
        if ('lock' in r || Date.now() >= deadline)
            return r;
        await new Promise((res) => setTimeout(res, pollMs));
    }
}
//# sourceMappingURL=locks.js.map