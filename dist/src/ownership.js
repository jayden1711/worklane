/** INVARIANT: plan paths are compared repo-relative, without "./" and surrounding blanks. */
export const normFiles = (files) => [...new Set(files.map((f) => f.trim().replace(/^\.\//, '')).filter(Boolean))].sort();
export class FileClaims {
    claims = new Map();
    /** INVARIANT: a waiter waits on exactly one owner at a time; the edge is gone once it owns its files. */
    waits = new Map();
    set(issue, files) {
        this.claims.set(issue, new Set(normFiles(files)));
    }
    add(issue, files) {
        const s = this.claims.get(issue) ?? new Set();
        for (const f of normFiles(files))
            s.add(f);
        this.claims.set(issue, s);
    }
    release(issue) {
        this.claims.delete(issue);
        this.waits.delete(issue);
    }
    files(issue) {
        return [...(this.claims.get(issue) ?? [])].sort();
    }
    /** WHY: the shape pickDispatch takes, so a dispatch hold and an in-task hold judge overlap the same way. */
    running() {
        return [...this.claims].map(([issue, s]) => ({ issue, hotspots: [...s].sort() }));
    }
    /** INVARIANT: a task never clashes with itself; null means every file in `files` is free. */
    clash(issue, files) {
        const want = normFiles(files);
        for (const [other, owned] of this.claims) {
            if (other === issue)
                continue;
            const both = want.filter((f) => owned.has(f));
            if (both.length)
                return { issue, by: other, files: both };
        }
        return null;
    }
    wait(issue, on) {
        this.waits.set(issue, on);
    }
    unwait(issue) {
        this.waits.delete(issue);
    }
    /** INVARIANT: only a cycle through `issue` counts; one further along is found by its own members. */
    cycle(issue) {
        const path = [issue];
        for (let n = this.waits.get(issue); n !== undefined; n = this.waits.get(n)) {
            if (n === issue)
                return path;
            if (path.includes(n))
                return null;
            path.push(n);
        }
        return null;
    }
    /** WHY: a claim outliving its task would hold every overlapping task forever; each one is dropped and returned for the report. */
    dropStale(live) {
        const out = [];
        for (const issue of [...this.claims.keys()]) {
            if (live(issue))
                continue;
            out.push({ issue, files: this.files(issue) });
            this.release(issue);
        }
        return out;
    }
}
//# sourceMappingURL=ownership.js.map