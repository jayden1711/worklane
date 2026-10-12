// Caps on the coordinator's waits: none of them may retry silently for ever. When a cap is reached the item is
// recorded (wait.capped), the owner is told on the issue or PR, and it waits for them (so it shows in the digest).
//   deferred landing     a land deferred because the machine-wide full-run slot was held, pass after pass, for
//                        tests.yaml land.defer_timeout_minutes (default 3 h) from the first such deferral in a row
//                        (an emergency stop's or a moved tip's deferral doesn't count: those end by themselves)
//   mergeable recheck    GitHub still computing whether a ready PR can merge, on MERGEABLE_CAP polls of one head
//   pending light check  the combined check found a conflict GitHub never reports, for LIGHT_PENDING_CAP polls
//   main checks          the required checks on an auto-merge's commit never all report, for MAIN_CHECKS_TIMEOUT_MS

/** Polls of one PR head whose mergeable state stays unknown before it waits for the owner. */
export const MERGEABLE_CAP = 10;
/** Polls of one PR head whose combined check says "conflict" while GitHub says it merges, before the owner. */
export const LIGHT_PENDING_CAP = 10;
/** How long the checks on an auto-merge's commit may take to report before the wait is given up. */
export const MAIN_CHECKS_TIMEOUT_MS = 2 * 3600_000;
/** At least this many polls of an auto-merge's checks, whatever the poll interval (it is 0 in tests). */
export const MAIN_CHECKS_MIN_POLLS = 20;

/** The polls a timeout allows at a poll interval: the timeout over the interval, never fewer than `min`. */
export function pollsFor(timeoutMs: number, pollMs: number, min: number): number {
  return pollMs > 0 ? Math.max(min, Math.ceil(timeoutMs / pollMs)) : min;
}

/** Counts consecutive polls of a waiting item (by key); forgotten on restart, which only restarts the count. */
export class PollCounter {
  private counts = new Map<string, number>();
  /** One more poll of `key` still waiting: the count so far, this one included. */
  bump(key: string): number {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }
  clear(key: string) {
    this.counts.delete(key);
  }
}

/**
 * When one queued land started waiting on the full-run slot: from its land.result outcomes since it was queued
 * (oldest first, each with its time in ms), the time of the first deferral in the trailing run of deferrals for a
 * held slot; null if it isn't in such a run. Another kind of deferral neither starts nor breaks the run.
 */
export function slotDeferringSince(results: { outcome: string; detail: string; at: number }[]): number | null {
  let since: number | null = null;
  for (const r of results) {
    if (r.outcome !== 'deferred') since = null;
    else if (/full-run slot/.test(r.detail) && since === null) since = r.at;
  }
  return since;
}
