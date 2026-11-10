// How a comment on an issue is read as a reply to a decision (src/coordinator/decisions.ts commentAnswer). The owner's
// decisions: a reply answers a decision only by naming its id (2026-11-09), and only on the comment's first line, in
// plain text (2026-11-10, option (b) with (b')). Nothing comes before a comment's first line, and the characters that
// open code, HTML, links or escapes are refused on it, so what is read is what the page shows: no markdown is parsed.
import { BRAND } from './brand.js';

/** A command: `/<cli> <option> …`, its option, the distinct decision ids on it, and its note (a `revise` note). */
export interface CommandLine {
  option: string;
  ids: string[];
  /** The rest of the line without its ids, in its original case. */
  note: string;
}

/** A comment read as a reply. */
export interface Reply {
  /** The command on the comment's first non-blank line, or null. */
  first: CommandLine | null;
  /** The first line holds a character a reply can't (UNSAFE): it answers nothing. */
  unsafe: boolean;
  /** Every other `/<cli> <word>` in the comment, on any line (a reply is one command: these void it). */
  others: CommandLine[];
}

/**
 * Stands for a decision's id in a receipt written before the id exists; ask() (src/coordinator/base.ts) puts the id in
 * its place. R1182ae: a reply answers only by naming the id, so an instruction to reply never leaves it out.
 */
export const DECISION_ID = '<decision id>';

/**
 * Text as a reply is compared: NFKC (full-width letters and digits to ASCII, a no-break space to a space), every Unicode
 * dash to `-`, lower case. So a look-alike id reads as the id it spells and can only equal that decision.
 */
export const replyText = (s: string): string => s.normalize('NFKC').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-').toLowerCase();

/**
 * What a reply's first line can't hold: each opens code, HTML, a link, an image, a quote, an escape, an entity or a
 * strikethrough (`~`, R1182aj AJ4).
 */
export const UNSAFE = /[`<>[\]()"'\\&!~]/;
/**
 * What a reply's first line can't hold as typed (R1182aj AJ2): characters that print nothing or change how the text
 * around them reads (control, format such as zero-width or bidi, private-use, unassigned: `\p{C}`), the other default
 * ignorables (the soft hyphen, the Hangul fillers) and the braille blank U+2800. Same class as src/ack-reason.ts.
 */
export const INVISIBLE = /[\p{C}\p{Default_Ignorable_Code_Point}\u2800]/u;

/**
 * Text as a page shows it (R1182aj AJ1, AJ3): the characters that print nothing dropped, and those that print as a blank
 * (the braille blank, the Hangul fillers) made spaces. Used to find blank lines and every command in a comment.
 */
export const shown = (s: string): string =>
  s.replace(/[\u2800\u3164\u115F\u1160\uFFA0]/g, ' ').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A command at the start of a line: at most 3 spaces (4 or a tab is code), the CLI, an option, the rest. */
const COMMAND = new RegExp(`^ {0,3}/${escape(BRAND.cli.toLowerCase())}[^\\S\\r\\n]+(\\S+)(.*)$`);
/**
 * A command anywhere on a line (of shown text), its rest up to the next command on that line. Each letter of the CLI's
 * name may also be any non-ASCII character that isn't a space, so a look-alike name (a Cyrillic letter) is a command
 * here too (R1182aj AJ1): it can only void a comment, never answer.
 */
const CLI = [...BRAND.cli.toLowerCase()].map((ch) => `(?:${escape(ch)}|[^\\x00-\\x7f\\s])`).join('');
const ANYWHERE = new RegExp(`/${CLI}[^\\S\\r\\n]+(\\S+)([^\\r\\n]*?)(?=/${CLI}[^\\S\\r\\n]|$)`, 'gu');
/** A decision id where it starts at a word boundary and ends at a word character (`d-12-a3f9c1`, not `xd-1` or `d-1-`). */
const ID = /(?<![\w-])d-[\w-]*\w/g;

/** The ids on a command (normalized text): its option too, so `/<cli> <id> approve` names the id (and no option). */
const idsOf = (option: string, rest: string) => [...new Set(`${option} ${rest}`.match(ID) ?? [])];

/** A line's note: the raw text after the option, without the tokens that are ids. */
const noteOf = (raw: string) => {
  const rest = /^\s*\S+\s+\S+(.*)$/.exec(raw)?.[1] ?? '';
  return rest
    .split(/\s+/)
    .filter((t) => t && !/^d-[\w-]*\w[.,:;]*$/.test(replyText(t)))
    .join(' ')
    .trim();
};

/** A comment as a reply: its first line's command, whether that line is refused, and every other command in it. */
export function readReply(body: string): Reply {
  // A byte order mark at the start is no text (CommonMark drops it; R1182aj AJ3).
  const lines = body.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const at = lines.findIndex((l) => replyText(shown(l)).trim() !== '');
  const firstRaw = at >= 0 ? lines[at]! : '';
  const m = COMMAND.exec(replyText(firstRaw));
  const first = m ? { option: m[1]!, ids: idsOf(m[1]!, m[2]!), note: noteOf(firstRaw) } : null;
  const others: CommandLine[] = [];
  lines.forEach((raw, i) => {
    let skip = i === at && first !== null; // the first line's own command is `first`, not another
    for (const o of replyText(shown(raw)).matchAll(ANYWHERE)) {
      if (skip) {
        skip = false;
        continue;
      }
      others.push({ option: o[1]!, ids: idsOf(o[1]!, o[2]!), note: '' });
    }
  });
  return { first, unsafe: first !== null && (INVISIBLE.test(firstRaw) || UNSAFE.test(firstRaw) || UNSAFE.test(replyText(firstRaw))), others };
}
