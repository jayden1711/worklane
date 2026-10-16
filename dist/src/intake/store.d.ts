import { ownerOnlyDir } from '../os/index.js';
import type { IncomingReport } from './report.js';
/** A stable id for a report: its source and the source's own id. */
export declare function reportId(r: Pick<IncomingReport, 'source' | 'sourceId'>): string;
/** A directory only the coordinator user can enter (0700). */
export declare const privateDir: typeof ownerOnlyDir;
/**
 * How long a report's id is remembered after it is first seen: far longer than the raw text is kept or a chat gateway
 * replays on resume, so a redelivery is never taken as new.
 */
export declare const SEEN_DAYS = 365;
/** Has this report (by the provider's message id) been taken before? Raw text may be long purged; the ledger isn't. */
export declare function seen(stateDir: string, r: Pick<IncomingReport, 'source' | 'sourceId'>): boolean;
/**
 * Record a message's id as seen without keeping any of its text (a reply in a setup step's thread, where a secret
 * might be typed by mistake); returns false if it was seen before.
 */
export declare function markSeen(stateDir: string, r: Pick<IncomingReport, 'source' | 'sourceId'>): boolean;
/**
 * Store a raw report and record its id as seen; returns false if it was seen before (a redelivery or retry). The raw
 * file is written first: a crash between the two still counts as seen, and recovery finds the raw file.
 */
export declare function storeRaw(stateDir: string, r: IncomingReport): boolean;
/** Report ids whose raw text is still kept. */
export declare function rawIds(stateDir: string): string[];
export declare function readRaw(stateDir: string, id: string): IncomingReport | null;
/** Delete raw reports older than `days`. Returns how many were removed. Their ids stay in the seen ledger. */
export declare function purgeRaw(stateDir: string, days: number, now?: number): number;
/** Forget seen ids older than `days` (SEEN_DAYS by default). */
export declare function purgeSeen(stateDir: string, days?: number, now?: number): number;
export type Admit = {
    ok: true;
} | {
    ok: false;
    reason: 'sender_cap' | 'flood';
};
/**
 * The daily counters behind the caps, persisted in the coordinator's state so a restart doesn't reset them. One
 * meter per coordinator; it is the only writer.
 */
export declare class IntakeMeter {
    private stateDir;
    private caps;
    private clock;
    /** Near-identical reports within this window count as a flood. */
    private flood;
    private file;
    constructor(stateDir: string, caps: {
        reports_per_sender_per_day: number;
        drafts_per_day: number;
        max_usd_per_day: number;
    }, clock?: () => number, 
    /** Near-identical reports within this window count as a flood. */
    flood?: {
        windowMs: number;
        max: number;
    });
    private load;
    private save;
    /** Take a report from `senderKey`, or refuse it (counted as a drop). */
    admit(senderKey: string, redactedText: string): Admit;
    /** May another draft be made today, within the draft count and the spend cap? */
    canDraft(): {
        ok: true;
    } | {
        ok: false;
        reason: 'drafts_cap' | 'spend_cap';
    };
    recordDraft(usd: number): void;
    /** Count a drop that happened before a report was taken (e.g. a sender not allowed): the reason only, nothing else. */
    countDrop(reason: string): void;
    /** Spend that isn't a draft (a casual reply): counted against the day's spend cap. */
    recordSpend(usd: number): void;
    /** May the chat channels run another turn today, within their own cap? */
    canChat(capUsd: number): boolean;
    /** The chat channels' spend today. */
    chatSpent(): number;
    /** A chat turn's spend: its own counter only (it has its own cap; the instance's daily budget counts it too). */
    recordChat(usd: number): void;
    /** Over the chat cap: true the first time today (the bot says so once), false after. */
    chatCapNotice(): boolean;
    /** What was dropped today, by reason (for the health panel). */
    dropped(): Record<string, number>;
}
