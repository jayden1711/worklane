import { type Role } from './dashboard-auth.js';
import type { DecisionContext } from './decision-context.js';
import type { EventPayload, StoredEvent } from './events/types.js';
import type { PrView } from './projection.js';
import type { ReviewConfig } from './config/schema.js';
import type { RunSummary } from './run-record.js';
/** A held PR's detail id: `pr-<number>` (a decision's own id is `d-…`, so the two never meet). */
export declare const PR_DECISION: RegExp;
/** Ids a detail is asked by: a decision's (letters, digits, `.`, `_`, `-`) or a held PR's. */
export declare const DECISION_ID: RegExp;
export type DetailKind = EventPayload<'decision.asked'>['kind'] | 'pr';
export interface OptionView {
    option: string;
    /** What picking it does, in plain words. */
    does: string;
    /** What it can't do: the limit of that answer. */
    cannot: string;
    recommended: boolean;
}
export interface ImpactFlag {
    flag: 'money-path' | 'auth' | 'secrets';
    /** The files that fall in it (empty: none do); null when the change's files aren't recorded. */
    files: string[] | null;
}
export interface DecisionDetail {
    id: string;
    kind: DetailKind;
    issue: number | null;
    owner: string;
    question: string;
    options: OptionView[];
    recommendation: string;
    askedAt: string;
    answer: {
        by: string;
        answer: string;
        at: string;
    } | null;
    canAnswer: boolean;
    /** What happens if nobody answers: there's no timeout anywhere; it waits. */
    ifNothing: string;
    /** For a viewer: why nothing else is here. Null for the owners and writers. */
    withheld: string | null;
    title?: string | null;
    /** The plain summary: what happened, and the asking agent's own words when it gave any. */
    summary?: {
        happened: string;
        agent: string | null;
    };
    /** A free-text recommendation's prose, and the reasoning the detail lines carry. */
    reasoning?: string[];
    /** The decision's other detail lines (receipts). */
    receipts?: string[];
    /** The agent's findings, each with its file and line when its evidence names one. Null: not recorded. */
    findings?: {
        list: NonNullable<DecisionContext['findings']>;
        confidence: string | null;
        unverified: string[];
    } | null;
    /** The change asked about. Null: no change is recorded for this decision. */
    change?: {
        base: string | null;
        head: string | null;
        files: {
            path: string;
            added: number | null;
            removed: number | null;
        }[];
        filesMore: number;
        level: string | null;
        levelReasons: string[];
        /** `asked`: recorded with the decision; `log`: joined from the issue's events (change.proposed, review.level_set). */
        source: 'asked' | 'log';
    } | null;
    /** The evaluator's verdict. Null: none recorded. */
    verdict?: {
        patch_correct: boolean;
        test_correct: boolean;
        confidence: string;
        confidenceReason: string | null;
        advice: string;
        unread: string[];
        unverifiedClaims: string[];
        designChange: boolean | null;
        designReason: string | null;
    } | null;
    /** The checks the harness ran (pass/fail per check; the output is owner-only). Null: none recorded. */
    tests?: {
        check: string;
        status: string;
        duration_ms: number | null;
        tail?: string;
    }[] | null;
    /** The tamper guard's flags on the change (owner-only; absent for a writer). */
    tampered?: string[];
    /** The PR, its CI per required check on its current head, and why it waits. Null: no PR. */
    pr?: {
        number: number;
        url: string;
        head: string;
        phase: string;
        draft: boolean;
        checks: {
            name: string;
            outcome: string;
        }[];
        checksOnHead: boolean;
        waitReasons: string[];
        why: {
            category: string;
            text: string;
        }[];
    } | null;
    /** Money path, auth and secrets: whether the change touches each, and where. */
    impact?: {
        flags: ImpactFlag[];
        others: string[];
        note: string | null;
    };
    /** The issue's agent runs; null when none can be listed (no issue). */
    runs?: Pick<RunSummary, 'id' | 'role' | 'model' | 'startedAt' | 'endedAt' | 'reason'>[] | null;
    /** Runs on this issue Claude refused the login on (#473), and a login held now on this instance. */
    auth?: {
        failed: {
            at: string;
            role: string;
            detail: string;
        }[];
        held: {
            login: string;
            detail: string;
            since: string;
        } | null;
    };
    /** Whether a diff can be asked for: `owner` (GET …/diff), `owners-only` (this person isn't one), or `none` (no change). */
    diff?: 'owner' | 'owners-only' | 'none';
    /** Whether the PR body's fail-without and never sections can be read (GET …/pr): a PR exists. */
    prBody?: boolean;
    /** For a writer: the parts that are the owners' alone. */
    ownerOnly?: string | null;
}
/** What each answer does, by kind and option, in plain words; and what it can't do. */
export declare function optionEffect(kind: DetailKind, option: string, o?: {
    investigation?: boolean;
}): {
    does: string;
    cannot: string;
};
/** What happens if nobody picks anything: nothing times out. */
export declare function ifNothing(kind: DetailKind, issue: number | null): string;
/** A PR body's "fail-without" and "What this can never do" sections, whole; null for each the body hasn't. */
export declare function prSections(body: string | null | undefined): {
    failWithout: string | null;
    never: string | null;
};
export interface DetailDeps {
    events: readonly StoredEvent[];
    role: Role;
    /** Every PR the harness opened (projection.ts prsView), for a held PR's detail and a decision's PR. */
    prs: readonly PrView[];
    /** The checkout, for the money paths. */
    root: string;
    review: ReviewConfig | undefined;
    /** The issue's runs (run-record.ts runsForIssue); asked only for the owners and writers. */
    runs: (issue: number) => RunSummary[];
}
/** The decision (or held PR) with this id, as this role may have it; null when there's none. */
export declare function decisionDetail(id: string, d: DetailDeps): DecisionDetail | null;
/** The change's diff, base..head, from the checkout's git (owners only: the route checks); redacted, capped. */
export declare function decisionDiff(root: string, base: string, head: string): Promise<{
    diff: string;
    truncated: boolean;
} | {
    diff: null;
    why: string;
}>;
