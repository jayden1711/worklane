import { waitingOnYou } from '../digest.js';
/** Closes land on GitHub's clock, not ours: each listing reaches this far before the last one. */
const MARGIN_MS = 5 * 60_000;
export class ClosedIssueWatch {
    /** When the last listing was asked for, and the held issues it covered from then on. */
    last = null;
    /** The held issues now closed on GitHub, to record as `issue.closed`. No held issue: no call. */
    async check(events, backlog, now = new Date()) {
        const held = new Map();
        for (const i of waitingOnYou(events, now).items) {
            if (i.issue === null || i.pr !== null)
                continue;
            const t = Date.parse(i.since);
            held.set(i.issue, Math.min(held.get(i.issue) ?? t, t));
        }
        if (!held.size) {
            this.last = null;
            return [];
        }
        // From the last listing, for issues it covered; from when its hold began, for any issue held since.
        let from = this.last?.at ?? Infinity;
        for (const [n, t] of held)
            if (!this.last?.covered.has(n))
                from = Math.min(from, t);
        const closed = new Set(await backlog.closedSince(new Date(from - MARGIN_MS).toISOString()));
        this.last = { at: now.getTime(), covered: new Set(held.keys()) };
        return [...held.keys()].filter((n) => closed.has(n)).sort((a, b) => a - b);
    }
}
//# sourceMappingURL=closed-issues.js.map