/** Each setup step's cap (the tiers have their own, test_run.tiers[].timeout_s). */
export declare const SETUP_TIMEOUT_S = 1800;
/** A step stopped at its own cap, as its check says it: "tier e2e timed out after 30 min (its timeout_s, 1800)". */
export declare function timedOutLine(what: string, seconds: number, field: string): string;
