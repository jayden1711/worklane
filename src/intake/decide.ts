// What happens to a triaged report. This is the policy, and it takes its trust
// from the sender (the adapter's id against the instance config) and its
// labels from here: nothing the report says, and nothing the intake agent
// returns, can file an issue as `ready`, skip the owner's approval, answer a
// decision or change config. The coordinator carries out the action.
import type { Candidate } from './dedupe.js';
import type { IncomingReport } from './report.js';
import { issueParts } from '../backlog/types.js';
import { checkDraft, type Triage } from './triage.js';

export type IntakeAction =
  /** Trusted sender, valid draft: file it with `ready`. */
  | { action: 'file'; title: string; body: string; labels: string[] }
  /** Untrusted sender, valid draft: an Inbox decision for the owner (approve / edit / reject). */
  | { action: 'decision'; title: string; body: string; options: ['approve', 'edit', 'reject']; labels: string[] }
  /** Same bug as an open issue: a comment there listing this report. */
  | { action: 'comment'; issue: number; body: string }
  /** Same as a recent report with no issue yet: group them. */
  | { action: 'group'; with: string }
  /**
   * Not actionable or needs more info: a polite reply asking for details; never an issue. `refused`: the agent's draft
   * failed checkDraft (why, for the log only), so the report is treated as needs_info whatever kind the agent chose.
   */
  | { action: 'reply'; text: string; refused?: string }
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

/** The money-path files a draft's Sources name (paths matched against the project's money paths). */
export function moneyPathFiles(body: string, moneyPaths: RegExp[]): string[] {
  if (!moneyPaths.length) return [];
  const sources = issueParts(body).Sources ?? '';
  const paths = sources
    .split(/[\s`'"(),;<>[\]]+/)
    .map((w) => w.replace(/^\.\//, '').replace(/[.:]+$/, ''))
    .filter((w) => /[/.]/.test(w) && !/^https?:/.test(w));
  return [...new Set(paths.filter((p) => moneyPaths.some((re) => re.test(p))))];
}

export function decide(o: { report: IncomingReport; redacted: string; triage: Triage; trusted: boolean; shown: Candidate[]; moneyPaths?: RegExp[] }): IntakeAction {
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
  // A draft that can't be filed as written is a report we need more about, never an issue or a silent drop.
  if (!check.ok) return { action: 'reply', text: NEEDS_INFO_REPLY, refused: check.why };
  // A draft whose Sources name a money-path file is high-risk: the money-path label takes its work to L3 (review.ts).
  const money = moneyPathFiles(triage.draft.body, o.moneyPaths ?? []);
  const risk = money.length ? `\n\n**High risk:** names money-path files (${money.slice(0, 5).map((f) => `\`${f}\``).join(', ')}), so its work waits for the owner (L3).` : '';
  const body = `${triage.draft.body.trim()}\n\n---\n${reportSection(report, redacted, triage)}${risk}`;
  const kindLabel = KIND_LABEL[triage.kind];
  const labels = [...(kindLabel ? [kindLabel] : []), ...(money.length ? ['money-path'] : [])];
  if (trusted) return { action: 'file', title: triage.draft.title, body, labels: ['ready', ...labels] };
  return { action: 'decision', title: triage.draft.title, body, options: ['approve', 'edit', 'reject'], labels };
}

export type Stage = 'filed' | 'merged' | 'deployed';

/** The status reply at each stage. Untrusted senders get a short status with no internal link; trusted ones get the link. */
export function statusReply(stage: Stage, trusted: boolean, issueUrl?: string): string {
  const text = { filed: "Thanks, we've logged this and will look into it.", merged: 'A fix for your report is done and on its way.', deployed: 'The fix for your report is live now. Thanks for telling us.' }[stage];
  return trusted && issueUrl ? `${text} ${issueUrl}` : text;
}
