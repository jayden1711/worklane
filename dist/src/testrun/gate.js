// The one gate in front of every test run: runTestRun (./run.ts), the only function that starts one, asks it first and
// refuses with TestRunHeld while any of its refusal sources says no. A source is a named function giving a reason or
// null, added with addStartGate. The coordinator adds `disk` (src/disk-guard.ts: free disk below the floor, or the
// event log's writes waiting in memory on a full disk); another reason (an updater's drain, say) is one more source.
// Previews (src/preview/) ask the same gate before one launches. Each caller holds a refused run (re-queued, or
// tried again on its next pass), never records it as a test result. test/test-run-gate.test.ts keeps every other
// path from starting a run around it.
/** A test run refused at the gate: held, not failed. */
export class TestRunHeld extends Error {
    reason;
    refusals;
    constructor(reason, refusals = []) {
        super(`test run held: ${reason}`);
        this.reason = reason;
        this.refusals = refusals;
        this.name = 'TestRunHeld';
    }
}
const sources = new Map();
/**
 * Add a refusal source under `name` (one per name: adding it again replaces it). Returns its removal. A source must be
 * cheap and must not throw: it is asked before every test run.
 */
export function addStartGate(name, fn) {
    sources.set(name, fn);
    return () => {
        if (sources.get(name) === fn)
            sources.delete(name);
    };
}
/** Remove every source (a coordinator stopping; tests). */
export function clearStartGates() {
    sources.clear();
}
/** Every source refusing now, in the order they were added. */
export function startRefusals() {
    const out = [];
    for (const [source, fn] of sources) {
        const reason = fn();
        if (reason)
            out.push({ source, reason });
    }
    return out;
}
/** Why no test run may start now (every refusal, joined), or null. */
export function startRefusal() {
    const r = startRefusals();
    return r.length ? r.map((x) => x.reason).join('; ') : null;
}
/** Throws TestRunHeld when any source refuses. */
export function passGate() {
    const r = startRefusals();
    if (r.length)
        throw new TestRunHeld(r.map((x) => x.reason).join('; '), r);
}
/**
 * Time a piece of work spent held at the gate, per key, so a caller's own timeout counts only the time it could run.
 * held(key, now, true) while refused, held(key, now, false) once it goes on; ms(key, now) is the total so far.
 */
export class HeldTime {
    since = new Map();
    total = new Map();
    held(key, now, held) {
        const s = this.since.get(key);
        if (held) {
            if (s === undefined)
                this.since.set(key, now);
        }
        else if (s !== undefined) {
            this.total.set(key, (this.total.get(key) ?? 0) + Math.max(0, now - s));
            this.since.delete(key);
        }
    }
    ms(key, now) {
        const s = this.since.get(key);
        return (this.total.get(key) ?? 0) + (s === undefined ? 0 : Math.max(0, now - s));
    }
}
//# sourceMappingURL=gate.js.map