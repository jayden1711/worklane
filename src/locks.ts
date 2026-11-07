// Crash-safe file locks: a lock is a file, created atomically, holding the
// owner's pid, place and process identity. Only a holder proved gone in the same known place can be taken over.
// Liveness, not a timeout, decides staleness (precedent: claude-code-merge-queue).
// A lock in the slot dir is a slot path (#772): every file operation on it here goes through src/slot-file.ts.
import { createHash } from 'node:crypto';
import { processIdentity, processIdentityInPlace, processPlace, UNKNOWN_IDENTITY } from './os/index.js';
import { makeSlotFileDir, readRegularSlotFile, removeSlotFile, slotSibling, trySlotFileGuard, writeSlotFile, type SlotPathLike } from './slot-file.js';

export interface LockInfo {
  pid: number;
  owner: string;
  acquiredAt: string;
  /** Missing on older locks. Unknown or different places are never judged stale. */
  place?: ReturnType<typeof processPlace>;
  /** Boot and start time, not just a pid that another process may have reused. */
  identity?: string | null;
  /** A test-run slot: the longest the run can take once it holds it (its setup and tiers' caps), for the updater's drain. */
  limit_ms?: number;
}

export interface Lock {
  path: SlotPathLike;
  release(): void;
}

function readLock(path: SlotPathLike): LockInfo | null {
  return parseLock(readFileSafe(path) ?? '');
}

/**
 * Historical claim-age limit, kept for callers that import it. Age no longer proves abandonment: a slow live
 * claimant must keep its exclusion. Claims are cleared only when their recorded process is proved gone (#960).
 */
export const CLAIM_ABANDONED_MS = 60_000;

/**
 * Try once. Returns the lock, or the current holder if it's busy.
 *
 * The lock's contents are written to a private temp file and hard-linked
 * into place (writeSlotFile, replace: false), so the lock appears whole or
 * not at all (link fails if the lock exists). A competitor never reads a half-written lock and mistakes
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
 * A stale holder must have a known host, boot and pid namespace matching this process's, and a recorded process
 * identity. Only a gone process or a different known identity proves stale; unreadable identity is never gone.
 * Legacy, malformed, foreign and unknown records stay busy, including claims; an operator must remove such a
 * record only after independently establishing no holder runs. Platforms without a known process place are refused too.
 * A native per-resource guard is held before inspecting any record, throughout takeover, and until release.
 * Competing reapers cannot inspect the same dead claim concurrently; its replacement cannot be removed using
 * a delayed inspection. The permanent guard inode is never a JSON lock or a cleanup target. See docs/slots.md.
 */
/** Points inside a takeover where tests interleave other processes' steps. */
export interface TakeoverHooks {
  /** A stale lock was read and judged stale. */
  inspected?(): void;
  /** The takeover's exclusive step is done, before it is acted on. */
  taking?(): void;
}

export function tryLock(path: SlotPathLike, owner: string, hooks: TakeoverHooks = {}, extra: Pick<LockInfo, 'limit_ms'> = {}): { lock: Lock } | { holder: LockInfo | null } {
  makeSlotFileDir(path);
  const guard = trySlotFileGuard(path);
  if (!guard) return { holder: readLock(path) };
  let transferred = false;
  try {
    const result = tryGuardedLock(path, owner, hooks, extra, guard);
    transferred = 'lock' in result;
    return result;
  } finally { if (!transferred) guard.release(); }
}

function tryGuardedLock(path: SlotPathLike, owner: string, hooks: TakeoverHooks, extra: Pick<LockInfo, 'limit_ms'>, guard: { release(): void }): { lock: Lock } | { holder: LockInfo | null } {
  const place = processPlace();
  const info: LockInfo = { pid: process.pid, owner, acquiredAt: new Date().toISOString(), place, identity: processIdentity(process.pid), ...(extra.limit_ms === undefined ? {} : { limit_ms: extra.limit_ms }) };
  const ownText = JSON.stringify(info);
  if (Buffer.byteLength(ownText) > LOCK_MAX_BYTES) throw new RangeError('lock record exceeds its bounded reader');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeSlotFile(path, ownText, { replace: false });
      let released = false;
      return {
        lock: {
          path,
          release() {
            if (released) return;
            released = true;
            try { if (readFileSafe(path) === ownText) removeSlotFile(path); }
            finally { guard.release(); }
          },
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const seen = readFileSafe(path);
    if (seen === null) continue; // released in between: try again
    const holder = parseLock(seen);
    if (!holder) return { holder: null };
    const current = processIdentity(holder.pid);
    if (current === UNKNOWN_IDENTITY || current === holder.identity) return { holder };
    // The existing hook may add a refusal (the signer does). It cannot replace the proof below.
    if (current === null || holder.identity) hooks.inspected?.();
    if (!provedGone(holder, place, current)) return { holder };
    // Claim this exact, proved-stale lock before touching it.
    const claim = slotSibling(path, `.${createHash('sha256').update(seen).digest('hex').slice(0, 16)}.claim`);
    try {
      writeSlotFile(claim, JSON.stringify({ pid: info.pid, place, identity: info.identity, at: Date.now() }), { replace: false });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (claimAbandoned(claim, place)) unlinkQuiet(claim);
      continue; // another process is taking over this same stale lock
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
}

function claimAbandoned(claim: SlotPathLike, place: ReturnType<typeof processPlace>): boolean {
  const c = parseProcess(readFileSafe(claim) ?? '');
  return c !== null && provedGone(c, place, processIdentity(c.pid));
}

function unlinkQuiet(path: SlotPathLike): void {
  try {
    removeSlotFile(path);
  } catch {
    // already gone
  }
}

/** A lock or claim is small. Never follow a link, wait for a FIFO writer, or read an unbounded record. */
const LOCK_MAX_BYTES = 4096;
function readFileSafe(path: SlotPathLike): string | null {
  try {
    const read = readRegularSlotFile(path, LOCK_MAX_BYTES);
    return read.kind === 'file' ? read.text : null;
  } catch {
    return null;
  }
}

function parseLock(text: string): LockInfo | null {
  const info = parseProcess(text);
  return info && Object.hasOwn(info, 'owner') && typeof info.owner === 'string' && Object.hasOwn(info, 'acquiredAt') && typeof info.acquiredAt === 'string' ? info as LockInfo : null;
}

type ProcessRecord = Pick<LockInfo, 'pid' | 'place' | 'identity'> & { owner?: unknown; acquiredAt?: unknown };
function parseProcess(text: string): ProcessRecord | null {
  try {
    const value = JSON.parse(text) as ProcessRecord | null;
    return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'pid') && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647 ? value : null;
  } catch {
    return null;
  }
}

function provedGone(record: ProcessRecord, here: ReturnType<typeof processPlace>, current: string | null): boolean {
  const there = record.place;
  if (!here.host || !here.boot || !here.pidns || !Object.hasOwn(record, 'place') || !there || typeof there !== 'object') return false;
  if (!Object.hasOwn(there, 'host') || !Object.hasOwn(there, 'boot') || !Object.hasOwn(there, 'pidns') || there.host !== here.host || there.boot !== here.boot || there.pidns !== here.pidns) return false;
  if (!Object.hasOwn(record, 'identity') || !processIdentityInPlace(record.identity, here)) return false;
  return current === null || (current !== UNKNOWN_IDENTITY && current !== record.identity);
}

/** Wait up to waitMs for the lock. Never returns "success" without holding it. */
export async function acquireLock(
  path: SlotPathLike,
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
