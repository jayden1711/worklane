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
