export interface Cron {
    minute: number;
    hours: Set<number>;
    days: Set<number>;
    months: Set<number>;
    weekdays: Set<number>;
    /** Day-of-month and day-of-week were both given (not *): either matching is enough. */
    either: boolean;
}
export declare function parseCron(text: string): {
    ok: true;
    cron: Cron;
} | {
    ok: false;
    why: string;
};
/** Wall-clock fields of a local slot. */
interface Wall {
    y: number;
    mo: number;
    d: number;
    h: number;
    mi: number;
}
export declare const slotKey: (w: Wall) => string;
/**
 * The most recent slot at or before `now` within `windowMin` minutes, or null: its key and the instant it falls on
 * (a slot the clocks skipped falls just after the change). At most one: an older missed slot never fires once a
 * newer one exists.
 */
export declare function latestSlot(c: Cron, now: Date, windowMin: number): {
    key: string;
    at: Date;
} | null;
/** The next `count` slots after `now` (for the dashboard: "next at"), looking at most 400 days ahead. */
export declare function nextSlots(c: Cron, now: Date, count: number): Date[];
/** A schedule in plain words, for the dashboard (the cron itself is shown beside it). */
export declare function describeCron(text: string): string;
export {};
