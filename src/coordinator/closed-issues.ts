// Issues held for the owner (blocked, a decision, a held plan, a hotspot hold) that someone closed by hand on
// GitHub. Closing an issue records no event of the loop's own, so without this the projection and the digest
// would hold it forever. One listing of recently closed issues per tick covers every held issue at once.
import type { Backlog } from '../backlog/types.js';
import { waitingOnYou } from '../digest.js';
import type { StoredEvent } from '../events/types.js';

/** Closes land on GitHub's clock, not ours: each listing reaches this far before the last one. */
const MARGIN_MS = 5 * 60_000;

export class ClosedIssueWatch {
  /** When the last listing was asked for, and the held issues it covered from then on. */
  private last: { at: number; covered: Set<number> } | null = null;

  /** The held issues now closed on GitHub, to record as `issue.closed`. No held issue: no call. */
  async check(events: StoredEvent[], backlog: Backlog, now = new Date()): Promise<number[]> {
    const held = new Map<number, number>();
    for (const i of waitingOnYou(events, now).items) {
      if (i.issue === null || i.pr !== null) continue;
      const t = Date.parse(i.since);
      held.set(i.issue, Math.min(held.get(i.issue) ?? t, t));
    }
    if (!held.size) {
      this.last = null;
      return [];
    }
    // From the last listing, for issues it covered; from when its hold began, for any issue held since.
    let from = this.last?.at ?? Infinity;
    for (const [n, t] of held) if (!this.last?.covered.has(n)) from = Math.min(from, t);
    const closed = new Set(await backlog.closedSince(new Date(from - MARGIN_MS).toISOString()));
    this.last = { at: now.getTime(), covered: new Set(held.keys()) };
    return [...held.keys()].filter((n) => closed.has(n)).sort((a, b) => a - b);
  }
}
