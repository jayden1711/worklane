import type { LogEntry, StudyState } from './state.js';
import type { Study } from './study.js';
/** Entries shown whole; older ones get one line each. */
export declare const LOG_FULL = 40;
/** One entry in the fixed template. Seeds of a stage-2 round are folded into their candidate's entry. */
export declare function renderEntry(e: LogEntry): string;
/** The whole log for a session: the goal and the metric in words, the best, then the entries (newest last). */
export declare function renderLog(study: Study, s: StudyState): string;
