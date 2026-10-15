import type { StoredEvent } from './events/types.js';
/** With no reset time in claude's message: the subscription's five-hour window. */
export declare const DEFAULT_PAUSE_MS: number;
/** A reset sooner than this is taken as this (a clock skew or a reset already passing never means "retry now"). */
export declare const MIN_PAUSE_MS = 60000;
/** A reset further off than this (a week's window, and a day's slack) isn't believed: the default instead. */
export declare const MAX_PAUSE_MS: number;
/** claude's own words for the subscription's limit (not a short-lived 429 it retries by itself). */
export declare const USAGE_LIMIT_TEXT: RegExp;
export interface LimitHit {
    /** When the limit resets (ISO). */
    resetAt: string;
    /** `claude`: read from claude's own message; `default`: none there, DEFAULT_PAUSE_MS from the hit. */
    source: 'claude' | 'default';
    /** The window claude named (five_hour, seven_day, ...), when it did. */
    kind: string | null;
}
/** What the stream's rate_limit_event carries (src/runner.ts reads it). */
export interface RateLimitInfo {
    status?: string;
    resetsAt?: number | null;
    rateLimitType?: string | null;
}
/** The reset time a message's text names, or null: "|1760000000", "resets in 2h 30m", "resets 3pm (Europe/Paris)", "resets Oct 14, 9am". */
export declare function resetInText(text: string, now: number, localTz?: string): number | null;
/**
 * A run's limit as the pause takes it: the reset from claude's rate_limit_event, else from its text, else the
 * default; held to [MIN_PAUSE_MS, MAX_PAUSE_MS] from now (outside it, the default).
 */
export declare function limitHit(o: {
    info?: RateLimitInfo | null;
    text: string;
    now: number;
    localTz?: string;
}): LimitHit;
/** The pause in force, as the log has it: the last usage.paused with no usage.resumed after it. */
export interface UsagePause {
    since: string;
    resetAt: string;
    source: 'claude' | 'default';
    kind: string | null;
    /** The run that hit it: its issue (null for one with none) and role. */
    issue: number | null;
    role: string;
    /** The event's id: the Discord notice's key. */
    id: number;
}
export declare function pauseOf(events: StoredEvent[]): UsagePause | null;
/** What the dashboard shows of an instance's usage: the pause in force, and today's runs and limit hits (this machine's local day, src/local-day.ts). */
export interface UsageView {
    paused: UsagePause | null;
    today: {
        runs: number;
        limitHits: number;
    };
    /** The last time a run hit the limit (ISO), or null. */
    lastHit: string | null;
}
export declare function usageView(events: StoredEvent[], now?: number): UsageView;
/** Plain words for when a pause ends, for a comment or a post: the time in UTC and how far off it is. */
export declare function resetWords(resetAt: string, now: number): string;
/**
 * The incident model a watchdog keeps (one alert per incident, one when it's resolved). Optional: until an
 * instance has one, the pause reports through its own events, the dashboard and the asks channel only.
 */
export interface IncidentSink {
    raiseIncident(kind: string, key: string, detail: string, fix: string): void;
    resolveIncident(kind: string, key: string): void;
}
/** The incident a usage pause raises, by instance. */
export declare const USAGE_INCIDENT = "claude_usage_limit";
