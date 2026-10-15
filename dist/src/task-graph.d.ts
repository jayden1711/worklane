import type { Issue } from './backlog/types.js';
/** WHY: code (fenced or inline) and HTML comments are skipped, so an example in a code block is never an edge. */
export declare function dependsOn(body: string): number[];
/** INVARIANT: returns a cycle reachable from `start` (one behind it blocks it just the same), in order; null when none. */
export declare function findCycle(start: number, edges: (n: number) => readonly number[]): number[] | null;
export declare const cycleWords: (cycle: readonly number[]) => string;
export type DepState = {
    open: number[];
    unreadable: number[];
    cycle: number[] | null;
};
/** WHY: one wording for the hold line, shared by the event, the dashboard and the digest. */
export declare function dependencyReason(s: DepState): string;
/**
 * WHY: a closed dependency is cached for good (it stays satisfied) and an open one only for `openTtlMs`,
 * so a close is seen within that without reading every dependency on every tick.
 */
export declare class DependencyGate {
    private readonly get;
    private readonly now;
    private readonly openTtlMs;
    private known;
    constructor(get: (n: number) => Promise<Pick<Issue, 'number' | 'state' | 'body'>>, now?: () => number, openTtlMs?: number);
    /** WHY: the ready list is already in hand; seeding it saves a tracker read per ready issue. */
    seed(issues: readonly Pick<Issue, 'number' | 'state' | 'body'>[]): void;
    private read;
    /** INVARIANT: an unreadable dependency holds the issue (reported) rather than being taken as closed. */
    check(issue: Pick<Issue, 'number' | 'body'>): Promise<DepState>;
}
