// The chat channel's words: what is posted for a decision or a setup-console ask, and how a reply in its thread is
// read. Code, not a model, writes every post and reads every reply. What a post may carry is fixed here:
// - a decision: its question, options and recommendation, in its own thread, answered by a reply there;
// - a high-risk merge: a notice and a link only (GitHub or the dashboard), no thread, no options: no reply answers it;
// - a secret (or a root step): a link to the dashboard's setup console only, nothing of the ask itself.
// Every post is at most REPLY_CHARS and pings nobody (discord.ts).
import type { Ask } from '../console/asks.js';
import type { EventPayload } from '../events/types.js';
import { redactString } from '../events/redact.js';
import { REPLY_CHARS } from './discord.js';
import { NEVER_FROM_CHAT } from './people.js';

/** A post: a thread of its own (answered in it), or a notice in the channel that nothing answers. */
export type ChannelPost = { kind: 'thread'; name: string; text: string } | { kind: 'notice'; text: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const base = (url: string) => url.replace(/\/+$/, '');

/** Fit a post in REPLY_CHARS, cutting the free text (the question) first, never the options or the instructions. */
function fit(head: string, free: string, tail: string): string {
  const room = REPLY_CHARS - head.length - tail.length;
  return `${head}${clip(free, Math.max(0, room))}${tail}`.slice(0, REPLY_CHARS);
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

/** What a decision posts. A high-risk merge posts only a notice with links, never its options. */
export function decisionPost(q: Pick<EventPayload<'decision.asked'>, 'id' | 'kind' | 'issue' | 'question' | 'options' | 'recommendation'>, o: { dashboardUrl: string; repo: string }): ChannelPost {
  const on = q.issue !== null ? ` on #${q.issue}` : '';
  if (NEVER_FROM_CHAT.has(q.kind)) {
    const gh = q.issue !== null ? ` https://github.com/${o.repo}/issues/${q.issue}` : '';
    return { kind: 'notice', text: `A high-risk merge${on} waits for an admin. It is approved only on GitHub or the dashboard, never here:${gh} ${base(o.dashboardUrl)}/land` };
  }
  const head = `Decision needed (${q.kind}${on}): `;
  const tail = `\nOptions: ${q.options.join(' / ')}. Recommended: ${q.recommendation}.\nReply in this thread with exactly one option.`;
  return { kind: 'thread', name: clip(oneLine(`${q.kind}${on}: ${q.question}`), 90), text: fit(head, oneLine(redactString(q.question)), tail) };
}

/** What a setup-console ask posts. A secret or a root step: only a link to the console, nothing of the ask. */
export function askPost(a: Ask, o: { dashboardUrl: string }): ChannelPost {
  const setup = `${base(o.dashboardUrl)}/setup`;
  if (a.kind === 'paste_secret' || a.kind === 'root_step') return { kind: 'notice', text: `A setup step needs you on the dashboard: ${setup}` };
  const options = a.kind === 'question' ? a.options : ['approved', 'declined'];
  const link = a.kind === 'approve_link' ? `\nOpen and approve: ${a.url}` : '';
  const tail = `${link}\nOptions: ${options.join(' / ')}.\nReply in this thread with exactly one option.`;
  return { kind: 'thread', name: clip(oneLine(`setup: ${a.title}`), 90), text: fit('Setup console: ', oneLine(redactString(a.title)), tail) };
}

/**
 * The option a reply chooses, or why it chooses none. A reply chooses an option only when its first word is that
 * option (case aside, `/cli` or punctuation around it allowed) and it names no other option anywhere: "approve" or
 * "Approve, looks good" choose approve; "approve or reject?", "yes" or "I wouldn't approve" choose nothing.
 */
export function parseChoice(text: string, options: string[]): { answer: string } | { ambiguous: true } {
  const words = text
    .toLowerCase()
    .replace(/^\s*\/\S+\s+/, '')
    .split(/\s+/)
    .map((w) => w.replace(/^[,.!?;:"'()[\]{}*_~`]+|[,.!?;:"'()[\]{}*_~`]+$/g, ''))
    .filter(Boolean);
  const hit = options.find((o) => o.toLowerCase() === words[0]);
  if (!hit) return { ambiguous: true };
  const others = options.filter((o) => o !== hit).map((o) => o.toLowerCase());
  if (words.slice(1).some((w) => others.includes(w))) return { ambiguous: true };
  return { answer: hit };
}

/** The ask-back for a reply that chose nothing: the exact options. */
export const askBack = (options: string[]) => clip(`I couldn't tell which option you meant, so nothing is answered. Reply with exactly one of: ${options.join(' / ')}.`, REPLY_CHARS);
/** The thread's word that it is decided, and by whom. */
export const decidedText = (answer: string, by: string) => clip(`Decided: ${answer}, by @${by}.`, REPLY_CHARS);
/** A later answer to something decided already: refused, naming who decided. */
export const alreadyText = (answer: string, by: string) => clip(`This was already decided by @${by} (${answer}); your reply changes nothing.`, REPLY_CHARS);
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
