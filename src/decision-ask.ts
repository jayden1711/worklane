// A decision's recommendation is one of its options or nothing. Prose an agent put there (its reasoning) is
// moved, whole, into the decision's detail, where the dashboard shows it as wrapped text instead of a pill.

/** The detail line that carries a recommendation's reasoning (the dashboard's DecisionCard reads it). */
export const RECOMMENDATION_PREFIX = 'Recommendation: ';

/**
 * Settle what a decision records: a recommendation that is one of the options, word for word (surrounding
 * spaces aside), stays; anything else is appended to the detail as "Recommendation: …" and left empty.
 */
export function settleRecommendation(options: readonly string[], recommendation: string, receipts: readonly string[]): { recommendation: string; receipts: string[] } {
  const rec = recommendation.trim();
  if (!rec) return { recommendation: '', receipts: [...receipts] };
  if (options.includes(rec)) return { recommendation: rec, receipts: [...receipts] };
  return { recommendation: '', receipts: [...receipts, `${RECOMMENDATION_PREFIX}${rec}`] };
}
