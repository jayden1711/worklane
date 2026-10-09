// Crash-safe file locks: a lock is a file, created atomically, holding the
// owner's pid. A lock whose owner is dead is stale and can be taken over.
// Liveness, not a timeout, decides staleness (precedent: claude-code-merge-queue).
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * A takeover's claim counts as abandoned when its owner is dead or it is
 * older than this. A takeover takes microseconds; this bounds how long a
 * crashed one can block the lock.
 */
export const CLAIM_ABANDONED_MS = 60_000;

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

export function tryLock(path: string, owner: string, hooks: TakeoverHooks = {}): { lock: Lock } | { holder: LockInfo | null } {
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
      // Stale (dead owner, or unreadable): claim this exact stale lock before touching it.
      hooks.inspected?.();
      const claim = `${path}.${createHash('sha256').update(seen).digest('hex').slice(0, 16)}.claim`;
      const mine = `${tmp}.claim`;
      writeFileSync(mine, JSON.stringify({ pid: process.pid, at: Date.now() }));
      try {
        linkSync(mine, claim);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (claimAbandoned(claim)) unlinkQuiet(claim); // its taker died or stalled; the next try claims it afresh
        continue; // another process is taking over this same stale lock
      } finally {
        unlinkQuiet(mine);
      }
      hooks.taking?.();
      try {
        // Ours alone to remove now: if the lock is still the stale one we read, nothing can replace it before this.
        if (readFileSafe(path) === seen) unlinkQuiet(path);
      } finally {
        unlinkQuiet(claim);
      }
    }
    return { holder: readLock(path) };
  } finally {
    unlinkSync(tmp);
  }
}

function claimAbandoned(claim: string): boolean {
  const c = parseLock(readFileSafe(claim) ?? '') as { pid?: number; at?: number } | null;
  return !c || typeof c.pid !== 'number' || !pidAlive(c.pid) || Date.now() - (c.at ?? 0) > CLAIM_ABANDONED_MS;
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
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
