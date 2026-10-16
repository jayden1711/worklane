import { type ClaimLabel } from './roles.js';
export { CLAIM_LABELS, LABELED_CLAIMS_FIELD, type ClaimLabel } from './roles.js';
export interface LabeledClaim {
    claim: string;
    label: ClaimLabel;
    /** measured: the command or check and what its output said; inferred: what it is reasoned from; guess: why. */
    basis: string;
}
/**
 * The labeled claims in an agent's output, and what is wrong with them: none given, a claim without one of the three
 * labels, or a measured claim that names no command or check. Problems are empty when every claim is labeled.
 */
export declare function readClaims(x: unknown): {
    claims: LabeledClaim[];
    problems: string[];
};
/** The sentences of `text` that hand the reader a check to run (at most 5, each at most 300 characters). */
export declare function handoffs(...texts: (string | undefined | null)[]): string[];
/** The doubt a handoff is: the change waits for a human, with the sentence. */
export declare const handoffDoubt: (who: string, sentences: string[]) => string;
/** A PR body's lines for one agent's labeled claims. */
export declare function claimLines(who: string, claims: LabeledClaim[], problems?: string[]): string[];
