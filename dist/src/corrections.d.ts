import { type PrReview } from './backlog/types.js';
export declare const CORRECTION_KINDS: readonly ["pr_rejected", "land_rejected", "plan_revised", "plan_rejected", "review_changes", "chat"];
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export interface Correction {
    /** One per source: the same correction is never recorded twice. */
    key: string;
    kind: CorrectionKind;
    issue: number | null;
    pr: number | null;
    by: string;
    /** What was corrected and the owner's own words. */
    text: string;
    at: string;
}
type Ev = {
    id?: number;
    ts: string;
    type: string;
    payload: unknown;
};
/**
 * Corrections already in the event log: a held plan revised or rejected, and a landing (direct mode) rejected.
 * Only writers' answers count (the decision flow accepts no one else).
 */
export declare function correctionsFromEvents(events: Ev[], writers: string[]): Correction[];
/** A harness PR a writer closed without merging: a rejected PR, with what the writers said on it. */
export declare function prRejection(o: {
    pr: number;
    issue: number;
    title: string;
    by: string;
    comments: {
        author: string;
        body: string;
    }[];
    writers: string[];
    at: string;
}): Correction | null;
/** Reviews that requested changes on a harness PR, by a writer. */
export declare function reviewCorrections(o: {
    pr: number;
    issue: number;
    title: string;
    reviews: PrReview[];
    writers: string[];
}): Correction[];
/** A chat question that corrects the chat: a writer's question starting `correction:` (or `correct:`). */
export declare const CHAT_CORRECTION: RegExp;
/** Chat corrections in the chat's history, each with the answer it corrects (the turn before it). */
export declare function chatCorrections(history: {
    at: string;
    by: string;
    question: string;
    answer: string;
}[], writers: string[]): Correction[];
/**
 * Only what the person said in a correction, without the line the harness writes around it (who did what on which
 * PR): the review's body, the plan note, the comments on a closed PR, the chat correction. '' when they said nothing
 * (a rejected landing, a review with no body). Reads the texts the functions above write, so it lives beside them.
 */
export declare function correctionWords(c: Pick<Correction, 'kind' | 'text'>): string;
/** The owner's own words, normalized: two corrections with the same words are the same correction. */
export declare function fingerprint(c: Pick<Correction, 'text'>): string;
export declare const FIX_KINDS: readonly ["impossible", "check", "rule", "style", "none"];
export type FixKind = (typeof FIX_KINDS)[number];
/** Strongest first. */
export declare const FIX_RANK: Record<Exclude<FixKind, 'none'>, string>;
export declare const CORRECTIONS_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["same_as", "fix_kind", "why_not_stronger", "title", "body", "why"];
    readonly properties: {
        readonly same_as: {
            readonly type: "string";
            readonly description: "The key of an earlier correction this one repeats; empty otherwise.";
        };
        readonly fix_kind: {
            readonly type: "string";
            readonly enum: readonly ["impossible", "check", "rule", "style", "none"];
            readonly description: "The strongest durable fix that works: impossible > check > rule > style; none if no durable fix fits.";
        };
        readonly why_not_stronger: {
            readonly type: "string";
            readonly description: "For check, rule or style: why each stronger kind does not work here. Empty for impossible.";
        };
        readonly title: {
            readonly type: "string";
            readonly description: "The issue title for the fix; empty for same_as or none.";
        };
        readonly body: {
            readonly type: "string";
            readonly description: "The issue body for the fix, in the five parts, each starting a line with its bold label: **Outcome:** one sentence. **Sources:** where to look, nowhere else. **Constraints:** what to leave alone. **Deliverable:** a closed ```done_when block, commands as YAML block scalars (\"- command: |\"). **Review point:** the expected review level (L0 to L3) and what would make it wait for the owner. Empty for same_as or none.";
        };
        readonly why: {
            readonly type: "string";
            readonly description: "One or two sentences: how this fix stops the corrected mistake from happening again (or, for none, why no durable fix fits).";
        };
    };
};
/** What the corrections agent proposed, checked: a fix to file, a repeat to group, nothing durable, or invalid. */
export type Proposal = {
    act: 'file';
    fixKind: Exclude<FixKind, 'none'>;
    title: string;
    body: string;
    why: string;
} | {
    act: 'group';
    sameAs: string;
} | {
    act: 'none';
    why: string;
} | {
    act: 'invalid';
    why: string;
};
export declare function readProposal(s: unknown, earlier: string[]): Proposal;
/**
 * Whether a correction's fix was filed: its own proposal, or the one it was grouped with (followed to the root). A
 * repeat of a correction with no filed fix is the owner correcting the same thing twice: it gets a proposal of its own,
 * never a silent grouping.
 */
export declare function fixFiled(key: string, o: {
    grouped: Map<string, string>;
    filed: Set<string>;
}): boolean;
/** The corrections agent's brief: the correction, the ranking, and the earlier corrections it may repeat. */
export declare function correctionBrief(c: Correction, earlier: {
    key: string;
    kind: string;
    text: string;
    outcome: string;
    fixed?: boolean;
}[]): string;
export declare const CORRECTION_LABEL = "correction";
export declare const correctionMarker: (key: string) => string;
/** The dashboard's view of corrections and the rules they produced. */
export interface CorrectionView {
    key: string;
    kind: CorrectionKind;
    at: string;
    by: string;
    issue: number | null;
    pr: number | null;
    text: string;
    status: 'pending' | 'proposed' | 'grouped' | 'no_fix' | 'failed';
    fixKind: Exclude<FixKind, 'none'> | null;
    /** The issue filed for the fix (proposed), or the proposal this one was grouped with. */
    proposal: number | null;
    sameAs: string | null;
    /** How many later corrections were grouped with this one. */
    repeats: number;
    detail: string;
}
/** The rules corrections produced: each filed fix and how far it got (filed, its PR open, merged, or closed). */
export interface RuleView {
    correction: string;
    fixKind: Exclude<FixKind, 'none'>;
    issue: number;
    title: string;
    why: string;
    pr: number | null;
    state: 'filed' | 'pr_open' | 'merged' | 'closed';
    repeats: number;
}
export declare function correctionsView(events: Ev[]): {
    corrections: CorrectionView[];
    rules: RuleView[];
};
export {};
