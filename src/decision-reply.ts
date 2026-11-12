// How a comment on an issue is read as a reply to a decision (src/coordinator/decisions.ts commentAnswer). The owner's
// decisions: a reply answers a decision only by naming its id (2026-11-09), and only as the comment's one line; the
// allowlist (#1182, after R1182af to R1182av): the whole comment is `/<cli> <option> <id> [note]` and nothing else, in
// letters, digits, spaces and `. , : ; -`. Nothing else in a comment can make GitHub draw text the comment doesn't hold,
// so what is read is what the page shows, by construction: no markdown, HTML, entity or Unicode is interpreted.
import { BRAND } from './brand.js';

/** A reply's command: its option, the decision id right after it, and its note (a `revise` note), lower case but the note. */
export interface CommandLine {
  option: string;
  id: string;
  /** The rest of the line, in its own case. */
  note: string;
}

/** Why a comment that looks like a reply isn't one, with the line (from 1) and, for a character, which. */
export interface Refusal {
  kind: 'reply_not_plain' | 'reply_not_one_line' | 'reply_shape';
  line: number;
  /** For reply_not_plain: the first character outside the allowlist, as `U+XXXX`. */
  code?: string;
}

/** A comment read as a reply. */
export interface Reply {
  /** The command, when the whole comment is one allowed line. Whether it answers is decided with the open ids (secondLook). */
  command: CommandLine | null;
  /** Why not, when the comment isn't one: null when it is a command. */
  refused: Refusal | null;
  /** The comment names the command, or holds these ids (lower case): what decides whether a refusal is noted. */
  mentions: { command: boolean; ids: string[] };
  /** The ids in the command's note (lower case), any id-shaped word: only an open decision's counts (secondLook). */
  noteIds: string[];
  /** The tracker's rendering of the comment as text (GitHub's body_text), lower case, or null when it gave none. */
  rendered: string | null;
}

/**
 * Stands for a decision's id in a receipt written before the id exists; ask() (src/coordinator/base.ts) puts the id in
 * its place. R1182ae: a reply answers only by naming the id, so an instruction to reply never leaves it out.
 */
export const DECISION_ID = '<decision id>';

/**
 * The only characters read as others first (the owner, 2026-11-10): the curly quotes and the en and em dashes a phone
 * keyboard types for ' " -. A curly quote is then a quote, which the allowlist doesn't take; a dash is a hyphen.
 */
export const TYPED: Readonly<Record<string, string>> = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-' };

/**
 * What a reply may hold: letters, digits, spaces and `. , : ; -`, and the `/` of its command. No quote or apostrophe (the
 * owner, 2026-11-10: the line holds none), and nothing else GitHub could draw as something else.
 */
export const ALLOWED = /^[A-Za-z0-9 .,:;-]$/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The one line: the CLI, an option, the id right after it, and an optional note. */
// A comma, colon, semicolon or full stop may follow the id directly (`approve <id>, thanks`; R1182an AN3).
const COMMAND = new RegExp(`^/${escape(BRAND.cli)} +([a-z][a-z-]*) +(d-[a-z0-9-]*[a-z0-9])[.,:;]?(?: +(.*?))? *$`, 'i');
/** A decision id where it starts at a word boundary and ends at a word character. */
const ID = /(?<![\w-])d-[\w-]*\w/gi;

/** The ids in text, lower case. */
export const idsIn = (text: string): string[] => [...new Set((text.match(ID) ?? []).map((x) => x.toLowerCase()))];

const mapTyped = (s: string) => s.replace(/[\u2018\u2019\u201C\u201D\u2013\u2014]/g, (ch) => TYPED[ch]!);

/**
 * A comment as a reply, on its typed text: the allowlist applies to that alone (the owner, 2026-11-11, "1182 fv: b").
 * `rendered`, the tracker's rendering (GitHub's body_text), is kept for secondLook, which looks in it only for a live id
 * or a second command; an emoji GitHub draws from `:tada:` in the note doesn't void a reply.
 */
export function readReply(typed: string, rendered?: string | null): Reply {
  const body = mapTyped(typed).replace(/[ \t\r\n]+$/, '');
  const shown = typeof rendered === 'string' ? mapTyped(rendered).toLowerCase() : null;
  const mentions = { command: body.toLowerCase().includes(`/${BRAND.cli.toLowerCase()}`), ids: idsIn(body) };
  const refuse = (r: Refusal): Reply => ({ command: null, refused: r, mentions, noteIds: [], rendered: shown });
  const lines = body.split(/\r\n|\r|\n/);
  if (lines.length > 1) return refuse({ kind: 'reply_not_one_line', line: 2 });
  const line = lines[0]!;
  // Every character but the command's own `/` must be in the allowlist; the first one that isn't is named.
  for (let i = 0; i < line.length; ) {
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (!(ALLOWED.test(ch) || (ch === '/' && i === 0))) return refuse({ kind: 'reply_not_plain', line: 1, code: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` });
    i += ch.length;
  }
  const m = COMMAND.exec(line);
  if (!m) return refuse({ kind: 'reply_shape', line: 1 });
  const note = (m[3] ?? '').trim();
  return { command: { option: m[1]!.toLowerCase(), id: m[2]!.toLowerCase(), note }, refused: null, mentions, noteIds: idsIn(note), rendered: shown };
}

/**
 * What else voids a command, given the open decisions' ids (lower case):
 * - its note names an open decision (the owner, 2026-11-11, "1182 dword: b": only an open id counts, so `d-day` or
 *   `d-bus` in a note is fine);
 * - the tracker's rendering shows an open id more often than the command's slot accounts for, or a second command
 *   (`/<cli>` again). Nothing else is read in the rendering ("1182 fv: b").
 */
export function secondLook(r: Reply, live: ReadonlySet<string>): 'reply_several_ids' | 'reply_rendering_shows_more' | null {
  if (!r.command) return null;
  if (r.noteIds.some((x) => live.has(x))) return 'reply_several_ids';
  if (r.rendered !== null) {
    const cli = `/${BRAND.cli.toLowerCase()}`;
    if (r.rendered.split(cli).length - 1 > 1) return 'reply_rendering_shows_more';
    for (const x of live) if (r.rendered.split(x).length - 1 > (x === r.command.id ? 1 : 0)) return 'reply_rendering_shows_more';
  }
  return null;
}
