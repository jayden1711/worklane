// Crash-safe file locks: a lock is a file created with O_EXCL holding the
// owner's pid. A lock whose owner is dead is stale and can be taken over.
// Liveness, not a timeout, decides staleness (precedent: claude-code-merge-queue).
import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { pidAlive } from './os/index.js';

export interface LockInfo {
  pid: number;
  owner: string;
  acquiredAt: string;
}

export interface Lock {
  path: string;
  release(): void;
}

function readLock(path: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/** Try once. Returns the lock, or the current holder if it's busy. */
export function tryLock(path: string, owner: string): { lock: Lock } | { holder: LockInfo | null } {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      const info: LockInfo = { pid: process.pid, owner, acquiredAt: new Date().toISOString() };
      writeSync(fd, JSON.stringify(info));
      closeSync(fd);
      return {
        lock: {
          path,
          release() {
            const cur = readLock(path);
            if (cur?.pid === process.pid) unlinkSync(path);
          },
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = readLock(path);
      if (holder && pidAlive(holder.pid)) return { holder };
      // Stale (dead owner, or a torn write): remove and retry once.
      try {
        unlinkSync(path);
      } catch {
        // someone else cleaned it up
      }
    }
  }
  return { holder: readLock(path) };
}

/** Wait up to waitMs for the lock. Never returns "success" without holding it. */
export async function acquireLock(
  path: string,
  owner: string,
  waitMs: number,
  pollMs = 250,
): Promise<{ lock: Lock } | { holder: LockInfo | null }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = tryLock(path, owner);
    if ('lock' in r || Date.now() >= deadline) return r;
    await new Promise((res) => setTimeout(res, pollMs));
  }
}
