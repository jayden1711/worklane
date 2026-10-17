import type { EventPayload } from './events/types.js';
import type { ChangeFile, LevelResult } from './review.js';
export type DecisionContext = NonNullable<EventPayload<'decision.asked'>['context']>;
/**
 * The file and line a finding's evidence names, when it names one: the first `path:line` (or `path:line:col`, or
 * `path#Lline`) in it whose path has a directory or an extension. Null when it names none (a command and its output).
 */
export declare function findingLocation(evidence: string): {
    file: string;
    line: number;
} | null;
type Verdict = {
    patch_correct: boolean;
    test_correct: boolean;
    confidence: 'high' | 'medium' | 'low';
    advice: string;
    confidence_reason?: string;
    unread?: string[];
    unverified_claims?: string[];
    design_change?: boolean;
    design_reason?: string;
};
type Check = {
    check: string;
    status: string;
    duration_ms?: number;
    tail?: string;
};
/** A change asked about (a landing held for the owner): its commits, files, level and why, verdict and checks. */
export declare function changeContext(o: {
    base: string;
    head: string;
    files: readonly ChangeFile[];
    level: LevelResult;
    verdict: Verdict;
    checks: readonly Check[];
    tampered?: readonly string[];
}): DecisionContext;
/** An investigation asked about: its answer, every finding (with the file and line its evidence names), its confidence and what it couldn't confirm. */
export declare function investigationContext(s: {
    summary?: string;
    findings?: {
        claim: string;
        evidence: string;
    }[];
    confidence?: string;
    unverified?: string[];
}): DecisionContext;
/** A worker's question: its summary of where the work stands, whole (the detail's first line keeps a copy). */
export declare function summaryContext(summary: string | undefined): DecisionContext | undefined;
export {};
