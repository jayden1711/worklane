// WHY: the dispatch loop's dependency holds and file ownership live here, apart from the loop
// itself, so the loop gains two calls and nothing else (src/task-graph.ts, src/ownership.ts).
import { BRAND } from '../brand.js';
import { FileClaims, normFiles } from '../ownership.js';
import { cycleWords, DependencyGate, dependencyReason, dependsOn } from '../task-graph.js';
const OWNERSHIP_POLL_MS = 15_000;
export class TaskGraph {
    d;
    claims = new FileClaims();
    gate;
    constructor(d) {
        this.d = d;
        this.gate = new DependencyGate((n) => d.backlog.get(n), d.now ?? Date.now);
    }
    now() {
        return (this.d.now ?? Date.now)();
    }
    lastDep(issue) {
        return this.d.read(['dependency.held', 'dependency.unblocked']).filter((e) => e.payload.issue === issue).at(-1);
    }
    /** WHY: one tracker read per ready issue is saved each pass; call once per dispatch pass. */
    seed(ready) {
        this.gate.seed(ready);
    }
    /** INVARIANT: true while `issue` waits on an open, unreadable or cyclic dependency; each hold and unblock is recorded once. */
    async held(issue) {
        const last = this.lastDep(issue.number);
        const waiting = last?.type === 'dependency.held' ? last.payload : null;
        if (!dependsOn(issue.body).length && !waiting)
            return false;
        const s = await this.gate.check(issue);
        if (s.cycle)
            await this.reportCycle(issue.number, s.cycle);
        const on = [...new Set([...(s.cycle ?? []).filter((n) => n !== issue.number), ...s.open, ...s.unreadable])].sort((a, b) => a - b);
        const isHeld = !!s.cycle || on.length > 0;
        if (isHeld) {
            const reason = dependencyReason(s);
            if (!waiting || waiting.reason !== reason)
                this.d.emit('dependency.held', { issue: issue.number, on, reason });
            return true;
        }
        if (waiting)
            this.d.emit('dependency.unblocked', { issue: issue.number, on: waiting.on, waited_ms: this.waited(last), why: 'closed' });
        return false;
    }
    /** WHY: a held issue that is closed or relabeled must not show as held forever. */
    dropNotReady(stillReady) {
        const last = new Map();
        for (const e of this.d.read(['dependency.held', 'dependency.unblocked']))
            last.set(e.payload.issue, e);
        for (const [n, e] of last) {
            if (e.type !== 'dependency.held' || stillReady.has(n))
                continue;
            this.d.emit('dependency.unblocked', { issue: n, on: e.payload.on, waited_ms: this.waited(e), why: 'not_ready' });
        }
    }
    waited(e) {
        return Math.max(0, Math.round(this.now() - Date.parse(e.ts)));
    }
    async reportCycle(issue, cycle) {
        const said = this.d.read(['dependency.cycle']).some((e) => {
            const p = e.payload;
            return p.issue === issue && p.cycle.join() === cycle.join();
        });
        if (said)
            return;
        this.d.emit('dependency.cycle', { issue, cycle });
        await this.d.backlog.comment(issue, `[${BRAND.cli}] Not starting: its "Depends on" issues form a cycle (${cycleWords(cycle)}), so none of them can ever start. Remove one of those lines to break it; it starts on its own once nothing it waits on is open.`);
    }
    /**
     * INVARIANT: returns once `issue` owns `files`. While another running task owns any of them it waits; a wait
     * cycle lets its lowest issue go ahead (reported), and a claim with no live task is dropped (reported).
     * `halted` throws to end the wait on a stop.
     */
    async own(issue, files, o) {
        const want = normFiles(files);
        try {
            for (;;) {
                for (const s of this.claims.dropStale(o.live))
                    this.d.emit('ownership.stale', s);
                const h = this.claims.clash(issue, want);
                if (!h)
                    break;
                o.onHold(h);
                this.claims.wait(issue, h.by);
                const cycle = this.claims.cycle(issue);
                if (cycle && Math.min(...cycle) === issue) {
                    this.d.emit('ownership.deadlock', { issue, cycle, files: h.files, proceeds: issue });
                    break;
                }
                o.halted();
                await new Promise((r) => setTimeout(r, this.d.pollMs ?? OWNERSHIP_POLL_MS));
                o.halted();
            }
        }
        finally {
            this.claims.unwait(issue);
        }
        this.claims.add(issue, want);
        o.onFree();
    }
}
//# sourceMappingURL=task-graph.js.map