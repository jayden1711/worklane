// The value report's shape (src/value-report.ts builds it, GET /api/value serves it, web/src/pages/Value.tsx shows
// it). Types only, so the web page can read them without pulling the engine in.

/** A held PR's reason kind, by the one prefix table (src/hold-words.ts, #706); anything unknown is `other`, never dropped. */
import type { HoldKind } from './hold-words.js';
export type { HoldKind };

/** What became of a held PR. `merged_by_person` is inferred: pr.closed records no actor. */
export type HeldOutcome = 'approved' | 'merged_by_person' | 'closed' | 'waiting';

/** What the main watch said about a merged PR's commit; `none` when nothing was recorded. */
export type MainSaid = 'green' | 'red' | 'reverted' | 'none';

/** The hours-saved estimate's constants, in minutes (a guess until calibrated). */
export interface ValueConstants {
  base_min: number;
  per_100_lines_min: number;
  cap_min: number;
}

/** Where the constants came from: the instance's policy.yaml (value_report.hours_estimate), or the engine's defaults. */
export type ConstantsFrom = 'policy' | 'default';

export interface PostMerge {
  /** PRs merged in the window, in this group. */
  merged: number;
  /** Of those, PRs whose commit went red on main (the post-merge result, or the main watch's flag). */
  mainRed: number;
  /** Of those, PRs reverted (a revert PR from merge.stopped, the main watch, or fix-forward). */
  reverts: number;
  /** Fix-forward outcomes attributed to the group's PRs. */
  fixForward: { fixed: number; reverted: number; gave_up: number };
}

export interface ValueReport {
  window: { days: number; since: string; until: string };
  /**
   * Events of the kinds this report reads that failed their schema: skipped. A garbled merge.decided or merge.done
   * that still names its PR makes that PR unsure (counts.unsure); one that names no PR shows only here.
   */
  unreadable: number;
  /** Per PR, judged at its last merge decision in the window. */
  counts: {
    /** The engine merged it on an auto decision. */
    auto: number;
    /** Its last decision held it for a person. */
    held: number;
    /** Decided auto, not merged (yet): in neither number. */
    autoNotMerged: number;
    /** A garbled decision or merge names it, so how it merged can't be told: in neither number, nor hours or spend. */
    unsure: number;
    /** held / (held + auto); null when there are none: "no data", never 0% or NaN. */
    holdRate: number | null;
  };
  /** Held PRs by reason kind: a PR counts once in each kind it has, and once in the held total. */
  heldByKind: { kind: HoldKind; prs: number }[];
  heldOutcomes: Record<HeldOutcome, number>;
  /** From a PR's first hold to its merge or close, over the held PRs that were resolved. */
  heldWait: { medianMs: number | null; resolved: number };
  /** Held PRs whose only reasons are the kill switch ("held only by the kill switch"). */
  wouldHaveMerged: { count: number; prs: { number: number; outcome: HeldOutcome; main: MainSaid }[] };
  /** The estimate, with the constants it used and where they came from, so whoever reads the figure can tell. */
  hoursSaved: { estimate: number; prs: number; withoutStats: number; formula: string; constants: ValueConstants; constantsFrom: ConstantsFrom; label: string };
  /** Agent spend (run.cost) on the auto-merged PRs' issues, measured. */
  spend: { usd: number; perAutoPr: number | null };
  postMerge: { auto: PostMerge; person: PostMerge };
}
