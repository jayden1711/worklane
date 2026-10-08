import type { StoredEvent } from './events/types.js';
export interface Lesson {
    issue: number;
    title: string;
    worked: string;
    failed: string;
    fix: string;
    at: string;
}
export declare function pendingLessons(events: StoredEvent[]): Lesson[];
/** Fix or worked texts that recur across lessons (all time): candidates to become skills. */
export declare function skillCandidates(events: StoredEvent[], minRepeats?: number): {
    text: string;
    count: number;
    issues: number[];
}[];
export declare function lessonsMarkdown(day: string, lessons: Lesson[], candidates: ReturnType<typeof skillCandidates>): string;
