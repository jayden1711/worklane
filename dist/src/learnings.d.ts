import type { EventPayload, StoredEvent } from './events/types.js';
import { MIN_SIGHTINGS } from './gardener.js';
import type { RunRecord } from './run-record.js';
import { type Stage } from './stage-label.js';
export { MIN_SIGHTINGS };
export declare const AGENTS_MD = "AGENTS.md";
export declare const LEARNINGS_HEADING = "## Learnings";
export declare const MAX_LINE = 300;
type Note = EventPayload<'learning.noted'>;
/** INVARIANT: one note per failed run (keyed by issue, role and end time), so noting a task twice adds nothing. */
export declare function taskNotes(events: StoredEvent[], issue: number, records?: RunRecord[], doneWhen?: string[]): Note[];
export interface LearningGroup {
    fingerprint: string;
    root: string;
    outcome: string;
    cause: string;
    count: number;
    issues: number[];
    /** WHY: code's stage when the note was made, else the weekly judge's later label for that run. */
    stages: {
        stage: Stage | 'unlabelled';
        count: number;
    }[];
    first: string;
    last: string;
    ready: boolean;
    line: string;
    promotion: {
        state: 'requested' | 'filed' | 'failed';
        by: string;
        line: string;
        pr: string | null;
        detail: string;
    } | null;
}
export interface LearningsView {
    minSightings: number;
    groups: LearningGroup[];
}
export declare function suggestedLine(g: Pick<LearningGroup, 'outcome' | 'cause' | 'count'>): string;
export declare function learningsView(events: StoredEvent[]): LearningsView;
/** INVARIANT: a promote names a group seen MIN_SIGHTINGS+ times, not promoted already, with one short line. */
export declare function promoteRefusal(view: LearningsView, fp: unknown, line: unknown): {
    status: 400 | 404 | 409;
    error: string;
} | null;
/** INVARIANT: null when the line is in AGENTS.md already, so a retried promote never adds it twice. */
export declare function withLearning(md: string | null, line: string): string | null;
