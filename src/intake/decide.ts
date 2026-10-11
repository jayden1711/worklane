// What happens to a triaged report. This is the policy, and it takes its trust
// from the sender (the adapter's id against the instance config) and its
// labels from here: nothing the report says, and nothing the intake agent
// returns, can file an issue as `ready`, skip the owner's approval, answer a
// decision or change config. The coordinator carries out the action.
import type { Candidate } from './dedupe.js';
import type { IncomingReport } from './report.js';
import { checkDraft, type Triage } from './triage.js';

export type IntakeAction =
  /** Trusted sender, valid draft: file it with `ready`. */
  | { action: 'file'; title: string; body: string; labels: string[] }
  /** Untrusted sender, valid draft: an Inbox decision for the owner (approve / edit / reject). */
  | { action: 'decision'; title: string; body: string; options: ['approve', 'edit', 'reject'] }
  /** Same bug as an open issue: a comment there listing this report. */
  | { action: 'comment'; issue: number; body: string }
  /** Same as a recent report with no issue yet: group them. */
  | { action: 'group'; with: string }
  /** Not actionable or needs more info: a polite reply asking for details; never an issue. */
  | { action: 'reply'; text: string }
  /** A question: the owner answers it; the reporter is told a person will. */
  | { action: 'ask_owner'; text: string; reply: string }
  | { action: 'drop'; reason: string };

/** Labels intake may put on an issue. Only `ready` for a trusted sender; the triage kind otherwise. */
const KIND_LABEL: Record<string, string> = { bug: 'bug', feature: 'enhancement' };

export const NEEDS_INFO_REPLY = 'Thanks for the report. Could you tell us a bit more: what you were doing, what you expected, and what happened instead?';
export const NOT_ACTIONABLE_REPLY = "Thanks for writing in. We couldn't turn this into something to fix yet; if it's a problem with the product, could you describe what happened?";
export const QUESTION_REPLY = "Thanks, we've passed your question on and someone will get back to you.";

/** A short excerpt of a report for an issue: redacted text, no sender handle or number. */
export function excerpt(redacted: string, max = 280): string {
  const t = redacted.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function reportSection(report: IncomingReport, redacted: string, triage: Triage): string {
  const repro = triage.reproduction ? `\n\n**Reproduction:** ${triage.reproduction.result.replace(/_/g, ' ')}${triage.reproduction.commit ? ` (${triage.reproduction.commit})` : ''}. ${triage.reproduction.detail}` : '';
  return `**Reported via ${report.source}** at ${report.receivedAt}:\n\n> ${excerpt(redacted).replace(/\n/g, '\n> ')}${repro}`;
}

export function decide(o: { report: IncomingReport; redacted: string; triage: Triage; trusted: boolean; shown: Candidate[] }): IntakeAction {
  const { report, redacted, triage, trusted, shown } = o;
  // A duplicate or group target counts only if it was one of the candidates the agent was shown.
  const dupOk = triage.duplicate_of !== undefined && shown.some((c) => c.issue === triage.duplicate_of);
  const groupOk = triage.group_with !== undefined && shown.some((c) => c.report === triage.group_with);
  if (triage.kind === 'duplicate' || dupOk) {
    if (dupOk) return { action: 'comment', issue: triage.duplicate_of!, body: `Another report of this:\n\n${reportSection(report, redacted, triage)}` };
    if (groupOk) return { action: 'group', with: triage.group_with! };
    return { action: 'drop', reason: 'duplicate of nothing it was shown' };
  }
  if (triage.kind === 'needs_info') return { action: 'reply', text: NEEDS_INFO_REPLY };
  if (triage.kind === 'not_actionable') return { action: 'reply', text: NOT_ACTIONABLE_REPLY };
  if (triage.kind === 'question') return { action: 'ask_owner', text: excerpt(redacted, 1000), reply: QUESTION_REPLY };
  if (triage.reproduction?.result === 'fixed_on_main') {
    return { action: 'reply', text: "Thanks for the report. This looks already fixed in the latest version; if you still see it after updating, let us know." };
  }
  if (!triage.draft) return { action: 'reply', text: NEEDS_INFO_REPLY };
  const check = checkDraft(triage.draft);
  if (!check.ok) return { action: 'drop', reason: `draft refused: ${check.why}` };
  const body = `${triage.draft.body.trim()}\n\n---\n${reportSection(report, redacted, triage)}`;
  const kindLabel = KIND_LABEL[triage.kind];
  if (trusted) return { action: 'file', title: triage.draft.title, body, labels: ['ready', ...(kindLabel ? [kindLabel] : [])] };
  return { action: 'decision', title: triage.draft.title, body, options: ['approve', 'edit', 'reject'] };
}

export type Stage = 'filed' | 'merged' | 'deployed';

/** The status reply at each stage. Untrusted senders get a short status with no internal link; trusted ones get the link. */
export function statusReply(stage: Stage, trusted: boolean, issueUrl?: string): string {
  const text = { filed: "Thanks, we've logged this and will look into it.", merged: 'A fix for your report is done and on its way.', deployed: 'The fix for your report is live now. Thanks for telling us.' }[stage];
  return trusted && issueUrl ? `${text} ${issueUrl}` : text;
}
