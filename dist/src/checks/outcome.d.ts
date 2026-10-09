export type Outcome = 'pass' | 'fail' | 'hold';
/** GitHub check-run / commit-status fields as the API returns them. */
export interface GitHubCheck {
    name: string;
    status?: string | null;
    conclusion?: string | null;
    state?: string | null;
}
export declare function classifyGitHubCheck(c: GitHubCheck): Outcome;
export interface GateResult {
    outcome: Outcome;
    failed: string[];
    held: string[];
    missing: string[];
}
/**
 * Combine checks for a gate. Every required check must be present and pass;
 * a required check that never reported is a failure, not a pass.
 */
export declare function gate(required: string[], checks: GitHubCheck[]): GateResult;
/** Count outcomes for reports and the scorecard. Holds are never failures. */
export declare function tally(outcomes: Outcome[]): Record<Outcome, number>;
