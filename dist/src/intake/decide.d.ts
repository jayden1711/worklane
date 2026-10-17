import type { Candidate } from './dedupe.js';
import type { IncomingReport } from './report.js';
import { type Triage } from './triage.js';
export type IntakeAction = 
/** Trusted sender, valid draft: file it with `ready`. */
{
    action: 'file';
    title: string;
    body: string;
    labels: string[];
}
/** Untrusted sender, valid draft: an Inbox decision for the owner (approve / edit / reject). */
 | {
    action: 'decision';
    title: string;
    body: string;
    options: ['approve', 'edit', 'reject'];
    labels: string[];
}
/** Same bug as an open issue: a comment there listing this report. */
 | {
    action: 'comment';
    issue: number;
    body: string;
}
/** Same as a recent report with no issue yet: group them. */
 | {
    action: 'group';
    with: string;
}
/**
 * Not actionable or needs more info: a polite reply asking for details; never an issue. `refused`: the agent's draft
 * failed checkDraft (why, for the log only), so the report is treated as needs_info whatever kind the agent chose.
 */
 | {
    action: 'reply';
    text: string;
    refused?: string;
}
/** A question: the owner answers it; the reporter is told a person will. */
 | {
    action: 'ask_owner';
    text: string;
    reply: string;
} | {
    action: 'drop';
    reason: string;
};
export declare const NEEDS_INFO_REPLY = "Thanks for the report. Could you tell us a bit more: what you were doing, what you expected, and what happened instead?";
export declare const NOT_ACTIONABLE_REPLY = "Thanks for writing in. We couldn't turn this into something to fix yet; if it's a problem with the product, could you describe what happened?";
export declare const QUESTION_REPLY = "Thanks, we've passed your question on and someone will get back to you.";
/** A short excerpt of a report for an issue: redacted text, no sender handle or number. */
export declare function excerpt(redacted: string, max?: number): string;
/** The money-path files a draft's Sources name (paths matched against the project's money paths). */
export declare function moneyPathFiles(body: string, moneyPaths: RegExp[]): string[];
export declare function decide(o: {
    report: IncomingReport;
    redacted: string;
    triage: Triage;
    trusted: boolean;
    shown: Candidate[];
    moneyPaths?: RegExp[];
}): IntakeAction;
export type Stage = 'filed' | 'merged' | 'deployed';
/** The status reply at each stage. Untrusted senders get a short status with no internal link; trusted ones get the link. */
export declare function statusReply(stage: Stage, trusted: boolean, issueUrl?: string): string;
