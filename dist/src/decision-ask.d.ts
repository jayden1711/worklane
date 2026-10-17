/** The detail line that carries a recommendation's reasoning (the dashboard's DecisionCard reads it). */
export declare const RECOMMENDATION_PREFIX = "Recommendation: ";
/**
 * Settle what a decision records: a recommendation that is one of the options, word for word (surrounding
 * spaces aside), stays; anything else is appended to the detail as "Recommendation: …" and left empty.
 */
export declare function settleRecommendation(options: readonly string[], recommendation: string, receipts: readonly string[]): {
    recommendation: string;
    receipts: string[];
};
