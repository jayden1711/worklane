// Crash-safe file locks: a lock is a file, created atomically, holding the
// owner's pid. A lock whose owner is dead is stale and can be taken over.
// Liveness, not a timeout, decides staleness (precedent: claude-code-merge-queue).
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
export function tryLock(path: string, owner: string): { lock: Lock } | { holder: LockInfo | null } {
  mkdirSync(dirname(path), { recursive: true });
  const info: LockInfo = { pid: process.pid, owner, acquiredAt: new Date().toISOString() };
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
              if (cur?.pid === process.pid && cur.acquiredAt === info.acquiredAt) unlinkSync(path);
            },
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const seen = readFileSafe(path);
      if (seen === null) continue; // released in between: try again
      const holder = parseLock(seen);
      if (holder && pidAlive(holder.pid)) return { holder };
      // Stale (dead owner, or unreadable): move it aside, then make sure it was the one we inspected.
      const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
      try {
        renameSync(path, aside);
      } catch {
        continue; // someone else moved or released it
      }
      if (readFileSafe(aside) !== seen) {
        // We moved a fresh lock that replaced the stale one: put it back if the slot is still free.
        try {
          linkSync(aside, path);
        } catch {
          // someone took the lock meanwhile; theirs stands
        }
      }
      unlinkSync(aside);
    }
    return { holder: readLock(path) };
  } finally {
    unlinkSync(tmp);
  }
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseLock(text: string): LockInfo | null {
  try {
    return JSON.parse(text) as LockInfo;
  } catch {
    return null;
  }
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
