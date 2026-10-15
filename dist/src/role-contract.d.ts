export declare const CONTRACT_PARTS: readonly ["Own", "Sources", "Output", "Approval", "Failure", "Never"];
/** The Failure rule every role states, word for word. */
export declare const FAILURE_RULE = "If a source is missing, stale or contradictory, report it; never guess or fill from memory.";
/** What is wrong with a role prompt's shape ([] when it follows the contract). */
export declare function contractProblems(prompt: string): string[];
