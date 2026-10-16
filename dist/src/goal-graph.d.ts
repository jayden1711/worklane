import type { StoredEvent } from './events/types.js';
import { type TaskStatus } from './projection.js';
/** WHY: more nodes than this are unreadable on a page; the rest are counted and said, never silently dropped. */
export declare const MAX_NODES = 60;
export interface GoalGraphNode {
    issue: number;
    /** The split's key for this child ("schema"), or null for one only a dependency cycle named. */
    key: string | null;
    title: string;
    /** The coordinator's state for it, as the rest of the dashboard shows it; null when it hasn't seen the issue yet. */
    status: TaskStatus | null;
    /** Its open PR, else its latest one; only an https URL as the PR event recorded it. */
    pr: {
        number: number;
        url: string;
    } | null;
    /** Its live run, else its latest recorded one; only for those who may read runs (null for everyone else). */
    run: string | null;
    /** Whether it is on a dependency cycle. */
    cycle: boolean;
    /** Its column: 0 for a task nothing orders before it, else one past its latest dependency. */
    layer: number;
}
/** `from` must finish before `to` starts ("to" says "Depends on #from"). */
export interface GoalGraphEdge {
    from: number;
    to: number;
    /** On a dependency cycle: drawn, but never used to order the columns. */
    cycle: boolean;
}
export interface GoalGraph {
    goal: number;
    /** Whether a split of this goal is recorded (in the events this asker may see). */
    split: boolean;
    nodes: GoalGraphNode[];
    edges: GoalGraphEdge[];
    /** Each distinct cycle, as findCycle gives it (each one depends on the next, the last on the first). */
    cycles: number[][];
    /** How many tasks the goal has; more than nodes.length when the graph was capped. */
    total: number;
    capped: boolean;
}
export interface GoalGraphInput {
    events: readonly StoredEvent[];
    goal: number;
    /** The run a node links to; omitted for those who may not read runs. */
    runOf?: (issue: number) => string | null;
    /** Tests lower it. */
    maxNodes?: number;
}
/** WHY: a URL from an event is shown as a link only when it is a plain https URL, never javascript: or similar. */
export declare function safeUrl(u: unknown): string | null;
export declare function goalGraph(i: GoalGraphInput): GoalGraph;
