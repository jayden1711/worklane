/** Whether `w` is node:sqlite's experimental-feature warning, and nothing else. */
export declare function isSqliteExperimentalWarning(w: Error): boolean;
/** Put the filter in front of the warning printers there are now. Doing it twice changes nothing. */
export declare function silenceSqliteExperimentalWarning(): void;
