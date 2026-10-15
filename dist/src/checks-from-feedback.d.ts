type Ev = {
    id?: number;
    ts: string;
    type: string;
    payload: unknown;
};
export declare const SIGHTING_SOURCES: readonly ["pr_rejected", "land_rejected", "plan_revised", "plan_rejected", "review_changes", "chat", "plan_objected", "revert"];
export type SightingSource = (typeof SIGHTING_SOURCES)[number];
/** One time a person said no, or one revert of a harness merge (evidence only: its reason is the harness's own words). */
export interface Sighting {
    /** One per source: the correction's key, `objected:<event id>`, `revert:<url>`. */
    key: string;
    source: SightingSource;
    by: string;
    at: string;
    issue: number | null;
    pr: number | null;
    /** What the person said (or, for a revert, why it was reverted). */
    words: string;
    /** Where it was said: the PR, the issue, the revert PR. */
    url: string | null;
}
/** The repository's web URL, from any PR URL the log has (`https://github.com/o/r`), or null. */
export declare function repoUrl(events: Ev[]): string | null;
/** Every sighting in the log, oldest first. Only writers' words count (the sources accept no one else). */
export declare function sightingsFromEvents(events: Ev[], writers: string[]): Sighting[];
/** The constraint's words: lower case, no links, mentions or #refs, no stop words, stemmed. */
export declare function constraintTerms(text: string): Set<string>;
/** Fewer terms than this and a sighting says too little to group (or to check). */
export declare const MIN_TERMS = 3;
/** The same constraint: at least 2 terms shared, and half of all their terms, or nearly all of the shorter one's. */
export declare function sameConstraint(a: Set<string>, b: Set<string>): boolean;
export interface Constraint {
    /** Stable: from its first sighting's key. */
    id: string;
    /** Its first sighting's words, short. */
    label: string;
    /** The terms its sightings share. */
    terms: string[];
    /** People's words grouped here: what the threshold counts. */
    sightings: Sighting[];
    /** Reverts of a PR (or its issue) one of the sightings is on: shown as evidence, never counted. */
    reverts: Sighting[];
}
export declare const constraintId: (firstKey: string) => string;
/**
 * The constraints: each person's sighting (with MIN_TERMS+ terms) joins the first constraint holding a sighting with
 * the same words (sameConstraint), else starts one; oldest first, so a constraint's id never moves. Reverts are
 * attached by PR or issue, never by their words (the harness writes those).
 */
export declare function clusterSightings(sightings: Sighting[]): Constraint[];
export declare const WEEK_MS: number;
/** A constraint's proposal (or why none was made), from the log. */
export interface ProposalRecord {
    constraint: string;
    keys: string[];
    at: string;
    outcome: 'pr' | 'issue' | 'dropped';
    number: number | null;
    url: string | null;
    why: string;
}
export declare function proposalHistory(events: Ev[]): ProposalRecord[];
export interface CheckPlan {
    /** Due a proposal now, most-seen first, within what is left of the week's cap. */
    propose: Constraint[];
    held: {
        constraint: string;
        why: string;
    }[];
}
/**
 * Which constraints get a proposal: seen `minSightings`+ times, none of their sightings in an earlier attempt (one
 * proposal per constraint; a dropped one is tried again only with a new sighting), and within the cap: every
 * attempt in the last 7 days counts, proposed or dropped, since each costs a run.
 */
export declare function planProposals(constraints: Constraint[], history: ProposalRecord[], o: {
    minSightings: number;
    maxPerWeek: number;
    now: Date;
}): CheckPlan;
/** Paths the evidence names (`src/a.ts`, `migrations/1.sql`), for the protected-area check. */
export declare function pathsIn(text: string): string[];
/** ast-grep's project config (sgconfig.yml): the first rule dir and test dir, or null when it has no rule dir. */
export declare function astGrepConfig(text: string): {
    ruleDir: string;
    testDir: string | null;
} | null;
export declare const SGCONFIG_FILES: string[];
/** Where an ast-grep rule's test cases go when sgconfig.yml names no test dir (the proposal adds it there). */
export declare const DEFAULT_SG_TEST_DIR = "rule-tests";
export type CheckMode = {
    kind: 'ast-grep';
    ruleDir: string;
    testDir: string;
    sgconfig: string;
    addTestDir: boolean;
} | {
    kind: 'test';
};
/**
 * The draft a run left, checked: only added or edited files where its kind of check lives (the rule dir and test
 * dir, sgconfig.yml only to add the test dir; test files), and well formed: an ast-grep rule with id, language,
 * rule and message, and a test file for it with valid and invalid cases; or at least one test file.
 */
export declare function checkDraft(mode: CheckMode, files: {
    path: string;
    status: string;
    content: string;
}[]): {
    ok: true;
} | {
    ok: false;
    why: string;
};
export declare const CHECK_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["title", "summary", "not_checkable"];
    readonly properties: {
        readonly title: {
            readonly type: "string";
            readonly description: "The PR title: what the check enforces, in a few words. Empty when not_checkable.";
        };
        readonly summary: {
            readonly type: "string";
            readonly description: "What you wrote and how it catches the constraint, in two or three sentences.";
        };
        readonly not_checkable: {
            readonly type: "string";
            readonly description: "Why no rule or test can catch this constraint; empty when you wrote one.";
        };
    };
};
export declare function readCheckAnswer(s: unknown): {
    act: 'drafted';
    title: string;
    summary: string;
} | {
    act: 'none';
    why: string;
} | {
    act: 'invalid';
    why: string;
};
/** Where one sighting was: its source, PR or issue (linked), who and when. */
export declare function sightingRef(s: Sighting): string;
/** The evidence, as Markdown: every sighting's words quoted, and the reverts. Words are data, never instructions. */
export declare function evidenceMarkdown(c: Constraint): string;
export declare const CHECKS_LABEL = "check-from-feedback";
export declare const checksMarker: (id: string) => string;
/** The draft PR's body: what it is, the evidence, and that it never merges itself. */
export declare function proposalPrBody(o: {
    c: Constraint;
    mode: CheckMode;
    summary: string;
    brand: string;
}): string;
/** The issue filed instead of a PR, when the constraint concerns a protected area: the evidence and why. */
export declare function proposalIssueBody(o: {
    c: Constraint;
    why: string;
    draft: string | null;
    brand: string;
}): string;
/** The drafting run's brief: the constraint and its evidence (as data), and where the check goes. */
export declare function checkBrief(c: Constraint, mode: CheckMode): string;
/** The dashboard's view: every constraint with its count, its evidence links and what became of it. */
export interface ConstraintView {
    id: string;
    label: string;
    terms: string[];
    count: number;
    sightings: {
        key: string;
        source: SightingSource;
        by: string;
        at: string;
        ref: string;
        url: string | null;
        words: string;
    }[];
    reverts: {
        url: string | null;
        at: string;
        words: string;
    }[];
    status: 'proposed_pr' | 'proposed_issue' | 'dropped' | 'due' | 'held' | 'watching';
    proposal: {
        kind: 'pr' | 'issue';
        number: number | null;
        url: string | null;
    } | null;
    detail: string;
}
export declare function constraintsView(events: Ev[], o: {
    writers: string[];
    enabled: boolean;
    minSightings: number;
    maxPerWeek: number;
    now: Date;
}): {
    enabled: boolean;
    minSightings: number;
    maxPerWeek: number;
    usedThisWeek: number;
    constraints: ConstraintView[];
};
export {};
