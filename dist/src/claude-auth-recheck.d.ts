/** The dashboard's side: ask for a re-check (a second ask before it is taken replaces the first). */
export declare function requestAuthRecheck(stateDir: string, by: string, now?: Date): void;
/** The coordinator's side: the request, if there is one (taken: removed), else null. */
export declare function takeAuthRecheck(stateDir: string): {
    by: string;
    at: string;
} | null;
