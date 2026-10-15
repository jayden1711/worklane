import { prsView, project } from './projection.js';
import { findCycle } from './task-graph.js';
/** WHY: more nodes than this are unreadable on a page; the rest are counted and said, never silently dropped. */
export const MAX_NODES = 60;
/** WHY: bounds the cycle search (one findCycle per child) on a goal whose split event is unexpectedly large. */
const MAX_READ = 500;
/** WHY: a URL from an event is shown as a link only when it is a plain https URL, never javascript: or similar. */
export function safeUrl(u) {
    if (typeof u !== 'string')
        return null;
    try {
        return new URL(u).protocol === 'https:' ? u : null;
    }
    catch {
        return null;
    }
}
/** One rotation of a cycle (smallest first), so the same cycle found from two starts is counted once. */
const canon = (c) => {
    const i = c.indexOf(Math.min(...c));
    return [...c.slice(i), ...c.slice(0, i)];
};
export function goalGraph(i) {
    const cap = i.maxNodes ?? MAX_NODES;
    const split = [...i.events].reverse().find((e) => e.type === 'goal.split' && e.payload.issue === i.goal);
    if (!split)
        return { goal: i.goal, split: false, nodes: [], edges: [], cycles: [], total: 0, capped: false };
    const children = split.payload.children.slice(0, MAX_READ);
    const ids = new Set(children.map((c) => c.number));
    // Each child's dependencies: what the split filed, plus any cycle the dispatch loop found among them since (an
    // owner's edit to a "Depends on" line; src/coordinator/task-graph.ts), each one depending on the next.
    const deps = new Map(children.map((c) => [c.number, c.depends_on.filter((d) => ids.has(d) && d !== c.number)]));
    for (const e of i.events) {
        if (e.type !== 'dependency.cycle')
            continue;
        const cyc = e.payload.cycle;
        if (!cyc.length || !cyc.every((n) => ids.has(n)))
            continue;
        cyc.forEach((n, k) => {
            const next = cyc[(k + 1) % cyc.length];
            const l = deps.get(n);
            if (next !== n && !l.includes(next))
                l.push(next);
        });
    }
    const depsOf = (n) => deps.get(n) ?? [];
    // Cycles, found the way the dispatch loop finds them (src/task-graph.ts), each counted once.
    const cycles = [];
    const seenCycle = new Set();
    for (const c of children) {
        const found = findCycle(c.number, depsOf);
        if (!found)
            continue;
        const k = canon(found);
        if (!seenCycle.has(k.join())) {
            seenCycle.add(k.join());
            cycles.push(k);
        }
    }
    const onCycle = new Set(cycles.flat());
    const cycleEdge = new Set();
    for (const c of cycles)
        c.forEach((n, k) => cycleEdge.add(`${c[(k + 1) % c.length]}>${n}`));
    // Columns: the longest chain of non-cycle edges before each task. At most one pass per task, so it ends even
    // if a cycle were missed above.
    const layer = new Map(children.map((c) => [c.number, 0]));
    const ordering = children.flatMap((c) => depsOf(c.number).filter((d) => !cycleEdge.has(`${d}>${c.number}`)).map((d) => [d, c.number]));
    for (let pass = 0; pass < children.length; pass++) {
        let moved = false;
        for (const [from, to] of ordering) {
            const want = Math.min(layer.get(from) + 1, children.length);
            if (want > layer.get(to)) {
                layer.set(to, want);
                moved = true;
            }
        }
        if (!moved)
            break;
    }
    const p = project([...i.events]);
    const tasks = new Map(p.tasks.map((t) => [t.issue, t]));
    const prs = prsView([...i.events]).prs;
    const nodes = children.map((c) => {
        const t = tasks.get(c.number);
        const mine = prs.filter((x) => x.issue === c.number);
        const pr = mine.find((x) => x.state === 'open') ?? mine[0] ?? null;
        const url = pr ? safeUrl(pr.url) : null;
        return {
            issue: c.number,
            key: c.key || null,
            title: t?.title ?? `#${c.number}`,
            status: t?.status ?? null,
            pr: pr && url ? { number: pr.number, url } : null,
            run: i.runOf ? i.runOf(c.number) : null,
            cycle: onCycle.has(c.number),
            layer: layer.get(c.number),
        };
    });
    nodes.sort((a, b) => a.layer - b.layer || a.issue - b.issue);
    const shown = nodes.slice(0, cap);
    const kept = new Set(shown.map((n) => n.issue));
    const edges = [];
    for (const c of children)
        for (const d of depsOf(c.number))
            if (kept.has(d) && kept.has(c.number))
                edges.push({ from: d, to: c.number, cycle: cycleEdge.has(`${d}>${c.number}`) });
    return { goal: i.goal, split: true, nodes: shown, edges, cycles, total: nodes.length, capped: nodes.length > shown.length };
}
//# sourceMappingURL=goal-graph.js.map