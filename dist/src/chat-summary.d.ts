import { SUMMARY_HEADINGS } from './roles.js';
export { SUMMARY_HEADINGS };
export type SummaryKey = (typeof SUMMARY_HEADINGS)[number][0];
export type ChatSummary = Record<SummaryKey, string>;
/** Each section's cap, and the whole summary's. */
export declare const SECTION_CHARS = 600;
export declare const SUMMARY_CHARS = 3000;
export declare const CHAT_SUMMARY_FILE: string;
export declare const EMPTY_SUMMARY: ChatSummary;
/**
 * The summary a turn returned, made safe to keep: every heading present (a missing or non-text one keeps the
 * previous turn's text), each section redacted and capped, and the whole under SUMMARY_CHARS (the longest
 * sections are cut first).
 */
export declare function acceptSummary(raw: unknown, previous?: ChatSummary): ChatSummary;
/** The summary as the prompt shows it: every heading, in order, "(none yet)" for an empty one. */
export declare function renderSummary(s: ChatSummary): string;
export declare function readSummary(stateDir: string): ChatSummary;
export declare function writeSummary(stateDir: string, s: ChatSummary): void;
