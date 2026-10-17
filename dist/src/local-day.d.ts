/**
 * The calendar day (YYYY-MM-DD) of a moment in this machine's own time zone: what the dashboard's "today" means
 * (runs today, spend today, landed today). Event timestamps stay in UTC; only the day they fall on is read locally,
 * so an evening in a time zone west of UTC doesn't count as tomorrow.
 */
export declare function localDay(at?: number | string | Date): string;
/** The next local midnight after `at`: when the local day (and the daily budget's day) turns. */
export declare function nextLocalMidnight(at?: number | Date): Date;
