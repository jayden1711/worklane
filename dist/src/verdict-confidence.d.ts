import { OTHER_ACTOR } from './roles.js';
export { OTHER_ACTOR };
export type Confidence = 'high' | 'medium' | 'low';
/** The actors the "compromised component" question asks about (src/roles.ts, where the evaluator's schema names them). */
export declare const ACTORS: readonly [readonly ["agent-user", "the agent user (the account agents run as)"], readonly ["coordinator", "the coordinator user and its dashboard"], readonly ["other-instance", "another instance's coordinator"], readonly ["hub-viewer", "a hub viewer"], readonly ["local-os-user", "a local OS user"]];
export type Actor = (typeof ACTORS)[number][0];
/** One actor's answer: what it can do through the change if compromised or hostile, and whether that's acceptable. */
export interface CompromisedAnswer {
    actor: string;
    can_do: string;
    acceptable: boolean;
    why: string;
}
/** The longest reason recorded (eval.verdict's bound). */
export declare const REASON_MAX = 2000;
/**
 * Why a verdict is refused as given: a confidence other than high without a reason, or claims not each labeled
 * measured, inferred or guess. Null: accepted. The text is what the evaluator is told when it's asked once more.
 */
export declare function verdictRefusal(s: {
    confidence?: unknown;
    confidence_reason?: unknown;
    claims?: unknown;
} | undefined): string | null;
/** What is wrong with a verdict's labeled claims, as one doubt; null when every claim is labeled. */
export declare function claimDoubt(claims: unknown): string | null;
/**
 * For a change to a protected surface: one doubt per actor whose answer is missing or empty, and per answer that says
 * what the actor can do is not acceptable. Empty for a change to no protected surface, or when every actor's answer
 * holds.
 */
export declare function compromisedDoubts(answers: unknown, protectedSurface: boolean): string[];
/**
 * The confidence recorded and its reason. The evaluator's own, lowered for claims no record backs (never evidence)
 * and, for a protected surface, to at most medium by any compromised-component doubt, and by any other doubt given
 * (claims left unlabeled, a check handed to the reader instead of run). A confidence other than high
 * always has a reason: the evaluator's, what lowered it, or, when it gave none even when asked again, that it gave none.
 */
export declare function calibrated(o: {
    confidence: Confidence;
    reason?: unknown;
    unverified: number;
    compromised: string[];
    doubts?: string[];
}): {
    confidence: Confidence;
    confidence_reason?: string;
};
/** The brief line for a change to a protected surface: what it touches, and the question to answer for each actor. */
export declare function protectedBrief(why: string[]): string;
