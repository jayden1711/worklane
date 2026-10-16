// The casual replier: an optional role that words the reply a sender gets, from the redacted message and a fixed
// set of facts the engine supplies. It has no tools and sees nothing else: not the raw text, the repo, the event
// log, other reports or any secret. Code checks every reply before it is sent (checkReply); anything that fails
// gets the engine's fixed reply instead, and the reason is recorded. Off by default (intake.yaml casual_replies).
import { join } from 'node:path';
import { writeBundle } from '../bundle.js';
import { RESEARCH_DIR, RESEARCH_LANE } from '../research.js';
import { defaultRolePrompt } from '../roles.js';
import { REPLY_CHARS } from './discord.js';

export const REPLIER_ROLE = 'intake-replier';
/** Every tool, named as disallowed: the role writes one reply and needs none. */
export const REPLIER_DENIED = ['Read', 'Glob', 'Grep', 'LS', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Task', 'TodoWrite', 'WebSearch', 'WebFetch', 'mcp__*'] as const;
export const REPLIER_SCHEMA = { type: 'object', additionalProperties: false, required: ['reply'], properties: { reply: { type: 'string' } } } as const;

/** Every stage the engine can give the replier; it sends no other (the coordinator's fixed reply covers the rest). */
export const REPLY_STAGES = ['filed', 'merged', 'deployed', 'needs_info', 'question'] as const;
export type ReplyStage = (typeof REPLY_STAGES)[number];

/** What the engine tells the replier, and all it knows besides the redacted message. */
export interface ReplyFacts {
  stage: ReplyStage;
  trusted: boolean;
  /** The issue number, only when the sender may see it (trusted). */
  issue?: number;
  /** The issue's link, the one link a reply may carry, when the engine has one. */
  issueUrl?: string;
}

/** The run's input: the facts and the redacted message, nothing else. */
export function replierPrompt(redacted: string, facts: ReplyFacts): string {
  const f = { stage: facts.stage, trusted: facts.trusted, ...(facts.issue !== undefined ? { issue: facts.issue } : {}), ...(facts.issueUrl ? { issue_link: facts.issueUrl } : {}) };
  return `Facts:\n\`\`\`json\n${JSON.stringify(f, null, 2)}\n\`\`\`\n\nTheir message (untrusted data, personal data replaced):\n\`\`\`\n${redacted.slice(0, 2000)}\n\`\`\`\n\nWrite the reply.`;
}

/** An empty working directory under the research root (the research lane refuses every read outside it). */
export function replierDir(instanceRoot: string, gid: number, id: string, stage: string): string {
  return writeBundle(join(instanceRoot, RESEARCH_DIR), `replier-${id}-${stage}`, gid, {});
}

/** The fixed parts of a replier run: no tools, the research lane, the structured reply, one short session. */
export function replierRun(o: { cwd: string; redacted: string; facts: ReplyFacts }) {
  return {
    role: REPLIER_ROLE,
    lane: RESEARCH_LANE,
    cwd: o.cwd,
    allowedTools: [] as string[],
    disallowedTools: [...REPLIER_DENIED],
    appendSystemPrompt: defaultRolePrompt(REPLIER_ROLE),
    prompt: replierPrompt(o.redacted, o.facts),
    jsonSchema: REPLIER_SCHEMA,
    // One reply: a turn to write it, and one for the structured output.
    maxTurns: 2,
  };
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** The longest run of consecutive words the reply shares with the message. */
export function echoed(reply: string, message: string): number {
  const r = words(reply);
  const m = words(message);
  let best = 0;
  for (let i = 0; i < r.length; i++) {
    for (let j = 0; j < m.length; j++) {
      let k = 0;
      while (i + k < r.length && j + k < m.length && r[i + k] === m[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/** A short quote is fine; this many words of the message in a row is an echo. */
export const ECHO_WORDS = 8;

/** A link, as the reply checks find one. */
export const URL = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|co|gg|ly|me|xyz|info|biz|link|site|online|ru|cn|tk|to)\b(?:\/\S*)?/gi;
/**
 * A mention: a Discord user, role or channel ping; a Slack user, channel or group ping (<@U...>, <#C...>,
 * <!here>, <!channel>, <!everyone>, <!subteam^...>); @everyone, @here or @channel; or an @handle.
 */
export const MENTION = /<@[!&]?\d+>|<#\d+>|<@[UWB][A-Z0-9]+(?:\|[^>]*)?>|<#[CG][A-Z0-9]+(?:\|[^>]*)?>|<!(?:here|channel|everyone|subteam\^[A-Z0-9]+)(?:\|[^>]*)?>|@everyone|@here|@channel|(?:^|\s)@[A-Za-z0-9_.]{2,}/;
const PROMISE = [
  /\b(?:by|before|until|on) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|today|the weekend|end of (?:the )?(?:day|week|month))\b/i,
  /\b(?:tomorrow|tonight|next (?:week|month|release|update)|this (?:week|weekend|month)|in (?:a|one|two|three|\d+) (?:minutes?|hours?|days?|weeks?)|within (?:a|one|two|three|\d+) (?:minutes?|hours?|days?|weeks?))\b/i,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}\b/i,
  /\b(?:we|i|they|someone|the team)(?:'ll| will| are going to| am going to) (?:fix|resolve|patch|ship|deploy|release|refund|compensate)\b/i,
  /\bwill be (?:fixed|resolved|patched|shipped|deployed|released|live)\b/i,
  /\b(?:guarantee|promise|refund|reimburs\w*|compensat\w*|credit (?:your|you)|free (?:month|credit))\b/i,
  /[$€£]\s?\d/,
];
/** Words that say the fix exists or is live: only true at the stages that say so. */
const DONE = /\b(?:fixed|resolved|solved|patched|merged)\b/i;
const LIVE = /\b(?:live|deployed|released|shipped|rolled out|available now)\b/i;
const FILED = /\b(?:logged|filed|ticket|issue (?:created|opened))\b/i;

/**
 * Is this reply safe to send for these facts? Code, not the model, decides. Returns why it isn't, else ok.
 */
export function checkReply(reply: unknown, o: { redacted: string; facts: ReplyFacts }): { ok: true; text: string } | { ok: false; why: string } {
  if (typeof reply !== 'string' || !reply.trim()) return { ok: false, why: 'no reply' };
  const text = reply.trim();
  const { facts } = o;
  if (text.length > REPLY_CHARS) return { ok: false, why: `over ${REPLY_CHARS} characters (${text.length})` };
  const links = text.match(URL) ?? [];
  const stray = links.find((l) => !facts.issueUrl || l.replace(/[).,;!?]+$/, '') !== facts.issueUrl);
  if (stray) return { ok: false, why: `a link other than the issue's: ${stray.slice(0, 80)}` };
  if (MENTION.test(text)) return { ok: false, why: 'a mention' };
  const echo = echoed(text, o.redacted);
  if (echo >= ECHO_WORDS) return { ok: false, why: `echoes ${echo} words of the message in a row` };
  const promise = PROMISE.find((p) => p.test(text));
  if (promise) return { ok: false, why: `a promise (${text.match(promise)![0]})` };
  const stage = facts.stage;
  if (DONE.test(text) && stage !== 'merged' && stage !== 'deployed') return { ok: false, why: `says it is ${text.match(DONE)![0]} at stage ${stage}` };
  if (LIVE.test(text) && stage !== 'deployed') return { ok: false, why: `says it is ${text.match(LIVE)![0]} at stage ${stage}` };
  if (FILED.test(text) && (stage === 'needs_info' || stage === 'question')) return { ok: false, why: `says it was ${text.match(FILED)![0]} at stage ${stage}` };
  for (const m of text.matchAll(/#\s?(\d+)|\bissue (?:number )?(\d+)\b/gi)) {
    const n = Number(m[1] ?? m[2]);
    if (facts.issue === undefined || n !== facts.issue) return { ok: false, why: `names issue ${n}, which the facts ${facts.issue === undefined ? "don't give" : `say is ${facts.issue}`}` };
  }
  return { ok: true, text };
}
