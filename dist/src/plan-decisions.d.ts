import type { StoredEvent } from './events/types.js';
/** The whole section when nothing recorded bears on the plan. Never beside citations. */
export declare const NOTHING_RECORDED = "nothing recorded on this";
/** Decision record files, repo-relative; each one present (exact name) is indexed by its headings. */
export declare const DECISION_FILES: string[];
/** Decision record folders: each markdown file in one is an entry (one decision per file). */
export declare const DECISION_DIRS: string[];
export interface DecisionEntry {
    /** How a plan cites it: `decision <id>` or `<file> § <heading>` (or `<file>` for a one-decision file). */
    ref: string;
    /** Every accepted citation of it, normalized (see normRef). */
    aliases: string[];
    /** One line: the heading, or the question and the answer that stands. */
    title: string;
    /** Its text, for plan review (capped). */
    text: string;
}
/** A citation as compared: case, markup, spacing, a trailing period and `#` vs `§` don't matter. */
export declare function normRef(s: string): string;
/**
 * The sections of a markdown file: each heading (outside code fences) and its text up to the next heading. The
 * document's title (a level-1 heading) is not a section when the file has deeper headings.
 */
export declare function sectionsOf(md: string): {
    heading: string;
    text: string;
}[];
/** The decision records the checkout keeps, as index entries. */
export declare function recordEntries(repo: string): DecisionEntry[];
/** The decisions already made: each answered question (the first answer stands), redacted, citable by id. */
export declare function madeEntries(events: readonly StoredEvent[]): DecisionEntry[];
/** The decisions index a plan is checked against: the decisions already made, then the checkout's records. */
export declare function decisionIndex(repo: string, events: readonly StoredEvent[]): DecisionEntry[];
/** The entry a citation names, or null. */
export declare function resolveRef(index: readonly DecisionEntry[], ref: string): DecisionEntry | null;
/** The index as the planner and the plan reviewer see it: one line per entry, each with the exact way to cite it. */
export declare function indexLines(index: readonly DecisionEntry[], max?: number): string[];
export interface Citation {
    /** The entry's canonical ref (DecisionEntry.ref). */
    ref: string;
    /** How the plan relies on it (rests on), or why it goes ahead anyway (argues against). */
    note: string;
}
export type DecisionsSection = {
    nothing: true;
} | {
    nothing: false;
    restsOn: Citation[];
    arguesAgainst: Citation[];
};
/** The section's format, as the planner is told it and as a refusal repeats it. */
export declare const DECISIONS_FORMAT = "\"Rests on:\" then one line per entry, \"- [<entry>] how the plan relies on it\"; \"Argues against:\" then one line per recorded entry that cuts against the plan, \"- [<entry>] why the plan goes ahead anyway\"; \"- none\" under a part with nothing. Or, when nothing recorded bears on the plan, the whole section is exactly \"nothing recorded on this\".";
/**
 * The plan contract's Decisions check: the section parsed, every citation found in the index, or why the plan is
 * refused. "nothing recorded on this" passes only as the whole section.
 */
export declare function checkDecisions(text: unknown, index: readonly DecisionEntry[]): DecisionsSection | {
    invalid: string;
};
/** The section as posted and as briefed: one line per citation, with the entry's canonical ref. */
export declare function decisionsLines(s: DecisionsSection | undefined): string[];
