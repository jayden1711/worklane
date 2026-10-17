/** The categories a browser check traces: main-thread tasks, and the frame pipeline. */
export declare const TRACE_CATEGORIES: string[];
/** A main-thread task at least this long counts as a long task (the web's own definition). */
export declare const LONG_TASK_MS = 50;
export interface TraceEvent {
    name?: string;
    ph?: string;
    pid?: number;
    tid?: number;
    dur?: number;
    args?: Record<string, unknown>;
}
export interface TraceSummary {
    /** Main-thread tasks of LONG_TASK_MS or more. */
    longTasks: number;
    /** The longest main-thread task, in ms (0 when there was none). */
    maxTaskMs: number;
    /** The share of frames dropped, 0-100; null when the trace has no frame events to judge by. */
    droppedFramePct: number | null;
    frames: number;
}
export declare function summarizeTrace(events: TraceEvent[]): TraceSummary;
