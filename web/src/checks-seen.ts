// WHY (#569): the Repo config form reads the checks GitHub ran on the default branch's tip again after a refresh or a
// merged config PR, so what its status slot says has to be about the tip that answer was for: "no checks yet" names
// that tip's short sha, and an answer for a later tip replaces the whole slot (its note and its checks), never adds to it.

/** The checks-seen endpoint's answer: the checks on the tip, the tip's sha (absent from its error replies), or why not. */
export interface ChecksSeenAnswer {
  checks: string[];
  sha?: string;
  error?: string;
}

/**
 * What the form shows for one answer: the checks to offer, and the status slot's note (null: the slot says the
 * checks found are offered below). `starterBelow`: no required check is chosen yet, so the starter CI is below.
 */
export function checksSeenSlot(r: ChecksSeenAnswer, starterBelow: boolean): { seen: string[]; note: string | null } {
  if (r.error) return { seen: r.checks, note: r.error };
  if (r.checks.length) return { seen: r.checks, note: null };
  return { seen: [], note: `no checks yet on ${r.sha ? r.sha.slice(0, 7) : 'its tip'}${starterBelow ? ': add a starter CI below' : ''}` };
}
