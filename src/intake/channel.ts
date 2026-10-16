// The chat channel's words: what is posted for a decision or a setup-console ask, and how a reply in its thread is
// read. Code, not a model, writes every post and reads every reply. What a post may carry is fixed here:
// - a decision: its question, options and recommendation, in its own thread, answered by a reply there; a held
//   plan: its acceptance criteria and the issue's link, answered by an admin ("approve plan <n>" names it);
// - a high-risk merge (an L3 landing decision, or a PR the merge policy left to an owner): with discord.owners set,
//   a thread that only those owners answer, with "approve <number>"; without, a notice and links only;
// - a secret (or a root step): a link to the dashboard's setup console only, nothing of the ask itself; with
//   discord.owners set, a thread where an owner replies "link" for a one-time link by DM (dmText: its title only).
// Every post is at most REPLY_CHARS and pings nobody (discord.ts), except an approval's ping of the other owners.
import type { Ask } from '../console/asks.js';
import type { EventPayload } from '../events/types.js';
import { redactString } from '../events/redact.js';
import { REPLY_CHARS } from './discord.js';
import { ACCEPTANCE_RECEIPT } from '../plan-mode.js';
import { NEVER_FROM_CHAT } from './people.js';
import { DEFAULT_PAUSE_MS, resetWords, type UsagePause } from '../usage-limit.js';

/** A post: a thread of its own (answered in it), or a notice in the channel that nothing answers. */
export type ChannelPost = { kind: 'thread'; name: string; text: string } | { kind: 'notice'; text: string; mentions?: string[] };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const base = (url: string) => url.replace(/\/+$/, '');

/** Fit a post in REPLY_CHARS, cutting the free text (the question) first, never the options or the instructions. */
function fit(head: string, free: string, tail: string): string {
  const room = REPLY_CHARS - head.length - tail.length;
  return `${head}${clip(free, Math.max(0, room))}${tail}`.slice(0, REPLY_CHARS);
}

/**
 * The usage-limit pause's notice, once per pause: when it resets (and whether claude said so or it's the default
 * wait), that the task was requeued, and the dashboard's Overview, where the pause counts down. No thread: nothing
 * in chat ends it; it ends on its own.
 */
export function usagePausePost(p: Pick<UsagePause, 'resetAt' | 'source' | 'issue'>, o: { dashboardUrl: string; instance: string; now: number }): ChannelPost {
  const why = p.source === 'default' ? ` claude's message named no reset time, so this is the default wait (${DEFAULT_PAUSE_MS / 3600_000} h).` : '';
  const task = p.issue !== null ? ` #${p.issue} was requeued, not failed.` : '';
  return { kind: 'notice', text: `${o.instance} is paused on the Claude usage limit: no new runs until ${resetWords(p.resetAt, o.now)}.${why}${task} It resumes on its own then; nothing to do. ${base(o.dashboardUrl)}/overview`.slice(0, REPLY_CHARS) };
}

/**
 * The main watch's alert: a notice, no thread (nothing in chat resumes auto-merge; an admin does on the dashboard).
 * The commit's link, why it is unaccounted (redacted), and the revert PR's link: no secrets, nobody's credentials.
 */
export function mainWatchPost(u: Pick<EventPayload<'main_watch.unaccounted'>, 'sha' | 'url' | 'reason' | 'revert'>, o: { dashboardUrl: string }): ChannelPost {
  const head = `Main watch: an unaccounted commit on the default branch, ${u.url}: `;
  const tail = `\nAuto-merge is stopped until an admin clears it on the dashboard: ${base(o.dashboardUrl)}/prs${u.revert ? `\nRevert PR, for a human to approve: ${u.revert}` : '\nNo revert PR was opened.'}`;
  return { kind: 'notice', text: fit(head, oneLine(redactString(u.reason)), tail) };
}

/**
 * What a decision posts. A high-risk merge: with Discord owners (`owners`), a thread they approve in by its number;
 * without, only a notice with links. Never its options as answerable by anyone else.
 */
export function decisionPost(q: Pick<EventPayload<'decision.asked'>, 'id' | 'kind' | 'issue' | 'question' | 'options' | 'recommendation'> & { receipts?: string[] }, o: { dashboardUrl: string; repo: string; owners?: boolean }): ChannelPost {
  const on = q.issue !== null ? ` on #${q.issue}` : '';
  // A held plan (the plan gate): its acceptance criteria, the issue with the full plan, and "approve plan <n>".
  if (q.kind === 'plan' && q.issue !== null) {
    const acceptance = (q.receipts ?? []).filter((r) => r.startsWith(ACCEPTANCE_RECEIPT)).map((r) => `- ${oneLine(redactString(r.slice(ACCEPTANCE_RECEIPT.length)))}`);
    const free = `${oneLine(redactString(q.question))} No code is written before an admin approves. Acceptance criteria:\n${acceptance.length ? acceptance.join('\n') : '- none given'}`;
    const tail = `\nFull plan: https://github.com/${o.repo}/issues/${q.issue}\nOptions: ${q.options.join(' / ')}.${q.options.includes(q.recommendation) ? ` Recommended: ${q.recommendation}.` : ''}\nReply in this thread with exactly one option; "approve plan ${q.issue}" approves it too.`;
    return { kind: 'thread', name: clip(oneLine(`plan${on}: ${q.question}`), 90), text: fit(`Decision needed (plan${on}): `, free, tail) };
  }
  if (q.kind === 'automation') return { kind: 'notice', text: `An automation's run waits for its owner's approval. It is approved only on the dashboard, never here: ${base(o.dashboardUrl)}/inbox` };
  if (NEVER_FROM_CHAT.has(q.kind)) {
    const gh = q.issue !== null ? ` https://github.com/${o.repo}/issues/${q.issue}` : '';
    if (o.owners && q.issue !== null) {
      return { kind: 'thread', name: `high-risk merge #${q.issue}`, text: `A high-risk merge${on} (L3) waits for an owner. An owner listed for Discord approvals approves it here with exactly "approve ${q.issue}" (or "reject ${q.issue}"); anyone else's reply is a comment. Or on GitHub or the dashboard:${gh} ${base(o.dashboardUrl)}/land` };
    }
    return { kind: 'notice', text: `A high-risk merge${on} waits for an admin. It is approved only on GitHub or the dashboard, never here:${gh} ${base(o.dashboardUrl)}/land` };
  }
  const head = `Decision needed (${q.kind}${on}): `;
  const tail = `\nOptions: ${q.options.join(' / ')}.${q.options.includes(q.recommendation) ? ` Recommended: ${q.recommendation}.` : ''}\nReply in this thread with exactly one option.`;
  return { kind: 'thread', name: clip(oneLine(`${q.kind}${on}: ${q.question}`), 90), text: fit(head, oneLine(redactString(q.question)), tail) };
}

/**
 * A PR the merge policy left to an owner (merge.decided auto false), with Discord owners: a thread they approve the
 * merge in by its number. Its reasons are redacted and cut first.
 */
export function mergePost(p: { number: number; issue: number; head: string; url: string; reasons: string[] }, o: { dashboardUrl: string }): ChannelPost {
  const head = `PR #${p.number} (issue #${p.issue}, head ${p.head.slice(0, 8)}) waits for an owner before it merges: `;
  const tail = `\nAn owner listed for Discord approvals approves the merge here with exactly "approve ${p.number}"; it then merges through the normal merge path (its required checks green on this head, the head unchanged, auto-merge not stopped). ${p.url} ${base(o.dashboardUrl)}/prs`;
  return { kind: 'thread', name: `merge #${p.number}`, text: fit(head, oneLine(redactString(p.reasons.join('; ') || 'the merge policy holds it')), tail) };
}

/**
 * What a setup-console ask posts. A secret or a root step: only a link to the console, nothing of the ask; with
 * Discord owners (`owners`), in a thread where one of them may ask for a one-time link by DM.
 */
export function askPost(a: Ask, o: { dashboardUrl: string; owners?: boolean }): ChannelPost {
  const setup = `${base(o.dashboardUrl)}/setup`;
  if (a.kind === 'paste_secret' || a.kind === 'root_step') {
    if (o.owners) return { kind: 'thread', name: 'setup step (dashboard only)', text: `A setup step needs an owner on the dashboard: ${setup}\nNever paste a secret here. An owner listed for Discord approvals can reply "link" in this thread for a one-time link to it by DM.` };
    return { kind: 'notice', text: `A setup step needs you on the dashboard: ${setup}` };
  }
  const options = a.kind === 'question' ? a.options : ['approved', 'declined'];
  const link = a.kind === 'approve_link' ? `\nOpen and approve: ${a.url}` : '';
  const tail = `${link}\nOptions: ${options.join(' / ')}.\nReply in this thread with exactly one option.`;
  return { kind: 'thread', name: clip(oneLine(`setup: ${a.title}`), 90), text: fit('Setup console: ', oneLine(redactString(a.title)), tail) };
}

/**
 * The option a reply chooses, or why it chooses none. A reply chooses an option only when its first word is that
 * option (case aside, `/cli` or punctuation around it allowed) and it names no other option anywhere: "approve" or
 * "Approve, looks good" choose approve; "approve or reject?", "yes" or "I wouldn't approve" choose nothing.
 * On a held plan (`plan`: its issue's number), "approve plan <n>" is the same as "approve" when n is that number,
 * and chooses nothing (`wrongNumber`) when it names another.
 */
export function parseChoice(text: string, options: string[], o: { plan?: number } = {}): { answer: string } | { ambiguous: true; wrongNumber?: number } {
  let words = text
    .toLowerCase()
    .replace(/^\s*\/\S+\s+/, '')
    .split(/\s+/)
    .map((w) => w.replace(/^[,.!?;:"'()[\]{}*_~`]+|[,.!?;:"'()[\]{}*_~`]+$/g, ''))
    .filter(Boolean);
  if (o.plan !== undefined && words[1] === 'plan') {
    const n = /^#?(\d{1,9})$/.exec(words[2] ?? '');
    if (n && Number(n[1]) !== o.plan) return { ambiguous: true, wrongNumber: Number(n[1]) };
    if (n) words = [words[0]!, ...words.slice(3)];
  }
  const hit = options.find((x) => x.toLowerCase() === words[0]);
  if (!hit) return { ambiguous: true };
  const others = options.filter((x) => x !== hit).map((x) => x.toLowerCase());
  if (words.slice(1).some((w) => others.includes(w))) return { ambiguous: true };
  return { answer: hit };
}

/** The ask-back for a reply that chose nothing: the exact options. */
export const askBack = (options: string[]) => clip(`I couldn't tell which option you meant, so nothing is answered. Reply with exactly one of: ${options.join(' / ')}.`, REPLY_CHARS);
/** The thread's word that it is decided, and by whom. */
export const decidedText = (answer: string, by: string) => clip(`Decided: ${answer}, by @${by}.`, REPLY_CHARS);
/** A later answer to something decided already: refused, naming who decided. */
export const alreadyText = (answer: string, by: string) => clip(`This was already decided by @${by} (${answer}); your reply changes nothing.`, REPLY_CHARS);
// ---------------------------------------------------------------- high-risk approvals and setup links

/**
 * A reply in a high-risk thread: "approve <number>" or "reject <number>" ("#" and "PR" allowed before the number;
 * a bare "reject" too), or nothing. A plain "approve" names no number and approves nothing.
 */
export function parseHighRisk(text: string): { act: 'approve' | 'reject'; number: number | null } | null {
  const m = text
    .trim()
    .toLowerCase()
    .replace(/^\/\S+\s+/, '')
    .match(/^(approve|reject)(?:\s+(?:pr\s*)?#?(\d{1,9}))?[\s.!]*$/);
  return m ? { act: m[1] as 'approve' | 'reject', number: m[2] ? Number(m[2]) : null } : null;
}

/** The ask-back for a high-risk reply that names no number, or isn't an approval. */
export const highRiskAskBack = (n: number, reject: boolean) => `Nothing is approved. Reply with exactly "approve ${n}"${reject ? ` (or "reject ${n}")` : ''}; a plain "approve" isn't enough here.`;
/** A high-risk approval naming another number. */
export const wrongNumberText = (n: number, said: number) => `This thread is about #${n}, not #${said}; nothing is approved.`;
/** A high-risk thread's word that it is approved, by whom: the other owners are pinged on it. */
export const approvedText = (n: number, by: string, merge: boolean) => clip(`Approved by @${by}: #${n} ${merge ? 'merges through the normal merge path on its next check' : 'lands through the normal path'}.`, REPLY_CHARS);
/** Someone who may not approve a high-risk merge: their reply is a comment. */
export const notOwnerText = (login: string) => clip(`Noted as a comment from @${login}. Only an owner listed for Discord approvals (discord.owners, an admin on the repo) can approve this one.`, REPLY_CHARS);

/** A setup step's thread: what a reply other than "link" gets. Nothing typed there is kept. */
export const SETUP_THREAD_TEXT = 'Reply "link" for a one-time link to this step on the dashboard, by DM. Never paste a secret here: nothing typed in this thread is kept or used.';
/** A setup step's thread: someone who may not ask for its link. */
export const SETUP_NOT_OWNER_TEXT = 'Only an owner listed for Discord approvals can ask for this step\'s link. Nothing typed in this thread is kept or used.';
/** Is this reply a request for the step's link? */
export const asksForLink = (text: string) => /^\s*link[\s.!]*$/i.test(text);

/**
 * The DM with a setup step's one-time link: the step's title (redacted, one line) and the link, nothing else of the
 * ask. The token is in the link's path, never its query.
 */
export function dmText(o: { title: string; login: string; url: string; minutes: number }): string {
  const head = `A setup step waits for you on the dashboard: "`;
  const tail = `". Your one-time link (for @${o.login} only; sign in first; it works once, for ${o.minutes} minutes): ${o.url}`;
  return fit(head, oneLine(redactString(o.title)).slice(0, 120), tail);
}

/** A reply from someone who may not answer this: kept as a comment. */
export const commentText = (login: string, who: string) => clip(`Noted as a comment from @${login}. Only ${who} can answer this one.`, REPLY_CHARS);

// ---------------------------------------------------------------- ideas in conversation

/**
 * What a reply to a shown draft says: an explicit yes ("yes", "yes, file it"); a no ("no", "cancel", "drop it");
 * something vague that might mean yes ("ok", "sure", "sounds good", "lgtm", a thumbs-up), which files nothing and
 * is asked back; or anything else, which is a change to the draft.
 */
export function readConfirm(text: string): 'yes' | 'no' | 'vague' | 'change' {
  const t = text.trim().toLowerCase();
  if (/^yes(?:[\s,.!-]+(?:file it|please|go ahead|file it as ready))?[\s.!]*$/.test(t)) return 'yes';
  if (/^(?:no|nope|cancel|drop it|don't file it|do not file it)[\s.!]*$/.test(t)) return 'no';
  if (/^(?:ok|okay|k|sure|fine|sounds good|looks good|lgtm|yep|yeah|yup|ya|y|go|go ahead|ship it|do it|perfect|great|nice|👍|✅|👌|🚀)[\s.!]*$/u.test(t)) return 'vague';
  return 'change';
}

export const CONFIRM_TEXT = 'Reply **yes** to file it as ready, **no** to drop it, or tell me what to change.';
export const VAGUE_TEXT = `I need an explicit yes before I file anything. ${CONFIRM_TEXT}`;

/** The most messages a draft is shown in; past that it is cut, with the rest left to the issue. */
export const DRAFT_MESSAGES = 8;

/** A draft as thread messages, each at most REPLY_CHARS, cut on line breaks, ending with how to confirm. */
export function draftPosts(draft: { title: string; body: string }): string[] {
  const lines = `Draft issue: **${oneLine(draft.title)}**\n\n${redactString(draft.body).trim()}`.split('\n');
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    // A line longer than a message is cut into pieces.
    let line = raw;
    do {
      const piece = line.slice(0, REPLY_CHARS);
      line = line.slice(REPLY_CHARS);
      const next = cur ? `${cur}\n${piece}` : piece;
      if (next.length > REPLY_CHARS) {
        out.push(cur);
        cur = piece;
      } else cur = next;
    } while (line);
  }
  if (cur) out.push(cur);
  const shown = out.length > DRAFT_MESSAGES - 1 ? [...out.slice(0, DRAFT_MESSAGES - 2), '(The rest of the draft is cut here; the full text goes into the issue.)'] : out;
  return [...shown, CONFIRM_TEXT];
}

/**
 * The bot's questions as a person gets them: the triage run's reply, at most REPLY_CHARS, with no link or mention
 * (it was written from people's text); anything else gets the fixed question.
 */
export function questionText(reply: string | undefined, fallback: string): string {
  const t = (reply ?? '').trim();
  if (!t || t.length > REPLY_CHARS || /https?:\/\/|www\.|<@[!&]?\d+>|@everyone|@here/i.test(t)) return fallback;
  return t;
}

export type IdeaStage = 'planned' | 'pr' | 'merged' | 'live';

/** A progress post in the idea's thread. */
export function progressText(stage: IdeaStage, o: { issue: number; repo: string; held?: boolean; prUrl?: string; env?: string }): string {
  const url = `https://github.com/${o.repo}/issues/${o.issue}`;
  switch (stage) {
    case 'planned':
      return clip(`Planned: the plan for #${o.issue} is on the issue${o.held ? " and waits for an admin's approval" : ''}. ${url}`, REPLY_CHARS);
    case 'pr':
      return clip(`PR opened for #${o.issue}: ${o.prUrl ?? url}`, REPLY_CHARS);
    case 'merged':
      return clip(`Merged: #${o.issue} is on the main branch.`, REPLY_CHARS);
    case 'live':
      return clip(`Live: the change for #${o.issue} is deployed${o.env ? ` (${o.env})` : ''}.`, REPLY_CHARS);
  }
}
