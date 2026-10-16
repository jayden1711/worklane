import { Corrections } from './corrections.js';
export declare abstract class Delegation extends Corrections {
    checkDelegation(): Promise<void>;
    /** Each harness PR merged since the last look: its review categories (from its own diff) and whether it merged as proposed. */
    private observeMerged;
    /** The owner's answers: loosen or tighten files the review.yaml change as an issue; keep changes nothing. */
    private answerDelegation;
}
