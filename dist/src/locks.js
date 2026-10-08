// Crash-safe file locks: a lock is a file created with O_EXCL holding the
// owner's pid. A lock whose owner is dead is stale and can be taken over.
// Liveness, not a timeout, decides staleness (precedent: claude-code-merge-queue).
import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
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
/** Try once. Returns the lock, or the current holder if it's busy. */
export function tryLock(path, owner) {
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(path, 'wx');
            const info = { pid: process.pid, owner, acquiredAt: new Date().toISOString() };
            writeSync(fd, JSON.stringify(info));
            closeSync(fd);
            return {
                lock: {
                    path,
                    release() {
                        const cur = readLock(path);
                        if (cur?.pid === process.pid)
                            unlinkSync(path);
                    },
                },
            };
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            const holder = readLock(path);
            if (holder && pidAlive(holder.pid))
                return { holder };
            // Stale (dead owner, or a torn write): remove and retry once.
            try {
                unlinkSync(path);
            }
            catch {
                // someone else cleaned it up
            }
        }
    }
    return { holder: readLock(path) };
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