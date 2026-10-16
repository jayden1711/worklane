import { type Ask, type EvalComparison } from './skilleval.js';
export interface EvalRolesOptions {
    base: string;
    roles: string[];
    model: string;
    judge: string;
    samples: number;
    cap: number;
    /** Write a held-out set for a role that has none (a separate case-writer run per role). */
    writeHeldOut: boolean;
    /** Score the current prompts only (no base): what each role's prompt scores now. */
    scoreOnly: boolean;
}
export declare function evalRolesOptions(argv: string[]): EvalRolesOptions;
/** An Ask whose every call is recorded as run.cost (role, model, the CLI's estimate). */
export declare function recordingAsk(ask: Ask, role: string, record: (cost: {
    role: string;
    model: string;
    usd: number;
    turns: number;
}) => void): Ask;
/** The report for one role (its line, then each case that changed), and whether the run fails for it. */
export declare function roleReport(c: EvalComparison): {
    lines: string[];
    fails: boolean;
};
