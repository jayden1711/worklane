import type { IncomingReport } from './report.js';
/** Runs one read-only SELECT and returns its output line ({rows: [...]}), like prodRead. */
export type ReadOnlyQuery = (sql: string) => {
    ok: boolean;
    output: string;
    error?: string;
};
export declare function readCursor(stateDir: string): string;
/** The query with `:after` filled in: a number or an ISO timestamp only, as a quoted literal. */
export declare function withCursor(query: string, after: string): string;
/**
 * Pull reports newer than the stored cursor, oldest first. The cursor is not moved here but in BugStoreIntake.ack,
 * once what was pulled is recorded, so a crash between the pull and the record pulls the same rows again (and the
 * seen ledger takes each once). `skipped`: rows with no text, which nothing will record.
 */
export declare function pullBugReports(stateDir: string, query: string, run: ReadOnlyQuery, now?: () => Date): {
    reports: IncomingReport[];
    skipped: string[];
};
/** The bug store as an intake source: pulled on each pass, its cursor advanced only past what is recorded. */
export declare class BugStoreIntake {
    private o;
    readonly name: "bug-store";
    /** Ids pulled and not yet behind the cursor, and whether each is recorded (or needs no record). */
    private pending;
    constructor(o: {
        stateDir: string;
        query: string;
        run: ReadOnlyQuery;
        now?: () => Date;
    });
    take(): Promise<IncomingReport[]>;
    /** These ids are recorded: move the cursor past every pulled id up to the first one that isn't. */
    ack(ids: string[]): Promise<void>;
    /** In-product reports have no thread to reply into. */
    reply(): Promise<boolean>;
    private advance;
}
