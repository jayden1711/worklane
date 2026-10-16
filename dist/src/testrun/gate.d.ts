/** Why a test run may not start: the source that refused (`disk`, ...) and its reason. */
export interface StartRefusal {
    source: string;
    reason: string;
}
/** A test run refused at the gate: held, not failed. */
export declare class TestRunHeld extends Error {
    readonly reason: string;
    readonly refusals: StartRefusal[];
    constructor(reason: string, refusals?: StartRefusal[]);
}
/**
 * Add a refusal source under `name` (one per name: adding it again replaces it). Returns its removal. A source must be
 * cheap and must not throw: it is asked before every test run.
 */
export declare function addStartGate(name: string, fn: () => string | null): () => void;
/** Remove every source (a coordinator stopping; tests). */
export declare function clearStartGates(): void;
/** Every source refusing now, in the order they were added. */
export declare function startRefusals(): StartRefusal[];
/** Why no test run may start now (every refusal, joined), or null. */
export declare function startRefusal(): string | null;
/** Throws TestRunHeld when any source refuses. */
export declare function passGate(): void;
/**
 * Time a piece of work spent held at the gate, per key, so a caller's own timeout counts only the time it could run.
 * held(key, now, true) while refused, held(key, now, false) once it goes on; ms(key, now) is the total so far.
 */
export declare class HeldTime {
    private since;
    private total;
    held(key: string, now: number, held: boolean): void;
    ms(key: string, now: number): number;
}
