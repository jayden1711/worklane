import { type Entry } from './keep.js';
/** An event as the fold reads it (a StoredEvent fits). */
export interface StudyEvent {
    type: string;
    ts: string;
    payload: Record<string, unknown>;
}
/** One research log entry: the fixed template's fields. */
export interface LogEntry extends Entry {
    ts: string;
    session: string;
    job: string | null;
    hypothesis: string;
    variable: string;
    motivation: string;
    expected_effect: string;
    config: Record<string, string | number>;
    commit: string | null;
    files: string[];
    approval: string[];
    gpu_minutes: number | null;
    waited_s: number | null;
    step: string | null;
    tail: string;
    why: string;
    timings: {
        train_ms: number;
        predict_ms: number;
        score_ms: number;
    } | null;
}
export type Phase = 'idle' | 'session' | 'awaiting_approval' | 'queued' | 'running';
export interface StudyState {
    version: string;
    entries: LogEntry[];
    phase: Phase;
    current: number | null;
    paused: boolean;
    archived: boolean;
    /** Three jobs in a row crashed, were refused or stopped: no new entry until someone resumes the study. */
    broken: boolean;
    best: {
        n: number;
        value: number;
    } | null;
}
export declare const BREAKER = 3;
export declare function foldStudy(events: readonly StudyEvent[], study: string, version: string): StudyState;
/** Why no new entry may start now, or null. */
export declare function sessionHold(s: StudyState): string | null;
/** The next entry's number: counted over every version of the study, so a job's id is never used twice. */
export declare function nextN(events: readonly StudyEvent[], study: string): number;
/** A job's id: the study and the entry's number. */
export declare const jobId: (study: string, n: number) => string;
