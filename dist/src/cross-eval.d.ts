export declare const CROSS_FAMILY_OFF = "off";
/** The provider model routing names for the second verdict, or null when it is off (or names no hosted provider). */
export declare function crossFamilyModel(value: string | undefined): string | null;
/** Why a routing value may not be the cross-family evaluator (null: it may): off, or a hosted provider. */
export declare function crossFamilyRefusal(value: string): string | null;
/**
 * Why this change is not sent to the cross-family evaluator (null: it may be): it touches held-out eval cases, or
 * secrets (the review category).
 */
export declare function crossFamilySkip(o: {
    paths: string[];
    categories: Record<string, string[]>;
}): string | null;
export interface SideVerdict {
    patch_correct: boolean;
    confidence: 'high' | 'medium' | 'low';
    /** Why: its confidence reason, else its advice. */
    reason: string;
}
/**
 * The two verdicts disagree when one approves and the other rejects, or their confidence is two steps apart (high
 * and low). The doubt names both sides and their reasons; null when they agree.
 */
export declare function crossDisagreement(primary: SideVerdict, second: SideVerdict & {
    provider: string;
}): string | null;
