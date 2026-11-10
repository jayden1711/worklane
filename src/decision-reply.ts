// How a comment on an issue is read as a reply to a decision (src/coordinator/decisions.ts commentAnswer): its command
// lines, each with its option, the decision ids on it and its note. The owner's decision (2026-11-09): a reply answers a
// decision only by naming its id, so this is all a reply is ever read for.
import { BRAND } from './brand.js';

/** One command line of a reply: `/<cli> <option> …`, its option, the distinct decision ids on it, and its note. */
export interface CommandLine {
  option: string;
  ids: string[];
  /**
   * What was written with it (a `revise` note): the rest of the line without its ids, then the plain lines that
   * continue its paragraph, up to a blank line, another command line, a fence, an HTML block, a quote, a list item or a
   * heading. Original case and text.
   */
  note: string;
}

/** A comment's command lines, and how many lines that look like commands were not read as one (see readReply). */
export interface Reply {
  lines: CommandLine[];
  /** Command-looking lines skipped because CommonMark shows them inside code, a quote, a link or a comment. */
  skipped: number;
}

/**
 * Text as a reply is compared: NFKC (full-width letters and digits to ASCII, a no-break space to a space), every Unicode
 * dash to `-`, lower case. So a look-alike id reads as the id it spells and can only equal that decision.
 */
export const replyText = (s: string): string => s.normalize('NFKC').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-').toLowerCase();

/**
 * Stands for a decision's id in a receipt written before the id exists; ask() (src/coordinator/base.ts) puts the id in
 * its place. R1182ae: a reply answers only by naming the id, so an instruction to reply never leaves it out.
 */
export const DECISION_ID = '<decision id>';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMMAND = new RegExp(`^/${escape(BRAND.cli.toLowerCase())}[^\\S\\r\\n]+(\\S+)(.*)$`);
const RAW_REST = /^\S+[^\S\r\n]+\S+(.*)$/;
/** A decision id where it starts at a word boundary and ends at a word character (`d-12-a3f9c1`, not `xd-1` or `d-1-`). */
const ID = /(?<![\w-])d-[\w-]*\w/g;
/** A CommonMark fence line: at most 3 spaces, then 3 or more backticks or tildes, then the rest. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** An inline link's destination and title (`](url "title")`): not shown as text, so never read for an id or a note. */
const LINK_TAIL = /\]\([^)]*\)/g;
/** A line that starts another block inside a paragraph's run of lines: a quote, a list item, a heading, a break. */
/** A list item's start: its indent, marker, the spaces after it, and its content. */
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([^\S\r\n]{1,4}|$)(.*)$/;
const OTHER_BLOCK = /^ {0,3}(>|[-*+][^\S\r\n]|\d{1,9}[.)][^\S\r\n]|#{1,6}([^\S\r\n]|$)|([-*_][^\S\r\n]*){3,}$)/;

/** CommonMark's HTML blocks (4.6): how each starts, what ends it (on a line, the start line too) or a blank line. */
const BLOCK6 = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_BLOCKS: { start: RegExp; end: RegExp | 'blank'; interrupts: boolean }[] = [
  { start: /^ {0,3}<(pre|script|style|textarea)(\s|>|$)/i, end: /<\/(pre|script|style|textarea)>/i, interrupts: true },
  { start: /^ {0,3}<!--/, end: /-->/, interrupts: true },
  { start: /^ {0,3}<\?/, end: /\?>/, interrupts: true },
  { start: /^ {0,3}<![A-Za-z]/, end: />/, interrupts: true },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/, interrupts: true },
  { start: new RegExp(`^ {0,3}</?(${BLOCK6})(\\s|/?>|$)`, 'i'), end: 'blank', interrupts: true },
  { start: /^ {0,3}(<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][\w.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/, end: 'blank', interrupts: false },
];

/**
 * What a paragraph's lines so far leave open, so that a following line is still inside it as CommonMark renders it:
 * a quote (a `>` line, which lazy lines continue), a link reference definition, a code span (a backtick run not yet
 * closed by one as long), an inline HTML comment, or an inline link's destination or title. Null: nothing.
 */
function openConstruct(paragraph: string[]): string | null {
  if (paragraph.some((l) => /^ {0,3}>/.test(l))) return 'a quote';
  if (paragraph.some((l) => LIST_ITEM.test(l))) return 'a list item';
  if (paragraph.some((l) => /^ {0,3}\[[^\]]+\]:/.test(l))) return 'a link definition';
  const text = paragraph.join('\n');
  let open: number | null = null;
  for (const m of text.matchAll(/`+/g)) {
    const n = m[0].length;
    if (open === null) open = n;
    else if (n === open) open = null;
  }
  if (open !== null) return 'code';
  const outside = text.replace(/`+[\s\S]*?`+/g, '');
  if (outside.replace(/<!--[\s\S]*?-->/g, '').includes('<!--')) return 'an HTML comment';
  const link = outside.lastIndexOf('](');
  if (link >= 0 && !outside.slice(link + 2).includes(')')) return 'a link';
  return null;
}

/** The ids on a command line's (normalized) text, never inside a link's destination or title. */
const idsOf = (rest: string) => [...new Set(rest.replace(LINK_TAIL, ']').match(ID) ?? [])];

/** A line's own note: its raw rest without link tails and without the tokens that are ids. */
const noteOf = (rawRest: string) =>
  rawRest
    .replace(LINK_TAIL, ']')
    .split(/[^\S\r\n]+/)
    .filter((t) => t && !/^[`(\[]*d-[\w-]*\w[`)\].,:;]*$/.test(replyText(t)))
    .join(' ')
    .trim();

/**
 * A comment as a reply, as a reader sees it rendered (CommonMark).
 * - Fenced code (at most 3 spaces of indent; closed only by a run of the same character at least as long, with nothing
 *   after it) and HTML blocks (4.6, types 1 to 7, to their end condition, which may be on the start line: `<!-->` and
 *   `<!--->` are complete) are not read. A multi-line HTML comment opens only at the start of a line.
 * - A command line starts at the start of its line (so a blockquote or indented code never is one), and is read only
 *   where it is its own text: the lines of its paragraph before it (since a blank line, a fence or an HTML block) leave
 *   no quote, link definition, code span, inline HTML comment or inline link open. A plain text line before it
 *   ("Looks right.") and another command line before it are fine. A skipped command line is counted (`skipped`).
 * - An inline `<!-- … -->` closed on its line is left out of the line; an unclosed inline `<!--` is text.
 */
export function readReply(body: string): Reply {
  const lines: CommandLine[] = [];
  let skipped = 0;
  let fence: { char: string; length: number; inItem: boolean } | null = null;
  /** The content indent of the list item the lines are in, or null. */
  let item: number | null = null;
  let html: RegExp | 'blank' | null = null;
  let paragraph: string[] = [];
  /** The command line read last, whose note the plain lines after it in its paragraph continue. */
  let last: CommandLine | null = null;
  const end = () => {
    paragraph = [];
    last = null;
  };
  for (const original of body.split(/\r\n|\r|\n/)) {
    let raw = original;
    let inItem = false;
    if (item !== null && raw.trim() !== '') {
      const indent = raw.length - raw.trimStart().length;
      if (indent >= item) {
        raw = raw.slice(item);
        inItem = true;
      } else {
        // The list item ends (a lazy line is caught by openConstruct), and a fence in it with it.
        if (fence?.inItem) fence = null;
        item = null;
      }
    }
    if (fence) {
      const m = FENCE.exec(raw);
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.length && /^[ \t]*$/.test(m[2]!)) fence = null;
      continue;
    }
    if (html) {
      if (html === 'blank' ? raw.trim() === '' : html.test(raw)) html = null;
      continue;
    }
    if (raw.trim() === '') {
      end();
      continue;
    }
    const f = FENCE.exec(raw);
    // A backtick fence's info string can't hold a backtick (CommonMark 4.5); then it isn't a fence.
    if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) {
      fence = { char: f[1]![0]!, length: f[1]!.length, inItem };
      end();
      continue;
    }
    const block = HTML_BLOCKS.find((b) => b.start.test(raw) && (b.interrupts || paragraph.length === 0));
    if (block) {
      end();
      if (block.end === 'blank') html = 'blank';
      else if (!block.end.test(raw)) html = block.end;
      continue;
    }
    const li = LIST_ITEM.exec(raw);
    if (li) {
      end();
      item = (inItem ? (item ?? 0) : 0) + li[1]!.length + li[2]!.length + Math.max(1, li[3]!.length);
      const content = li[4]!;
      const lf = FENCE.exec(content);
      if (lf && !(lf[1]![0] === '`' && lf[2]!.includes('`'))) fence = { char: lf[1]![0]!, length: lf[1]!.length, inItem: true };
      else {
        if (COMMAND.test(replyText(content.replace(/<!--[\s\S]*?-->/g, '')))) skipped++;
        paragraph = [original];
      }
      continue;
    }
    const line = raw.replace(/<!--[\s\S]*?-->/g, '');
    const m = COMMAND.exec(replyText(line));
    if (m) {
      if (inItem || openConstruct(paragraph) !== null) {
        skipped++;
        paragraph.push(raw);
        last = null;
        continue;
      }
      last = { option: m[1]!, ids: idsOf(`${m[1]} ${m[2]}`), note: noteOf(RAW_REST.exec(line)?.[1] ?? '') };
      lines.push(last);
      paragraph = [];
      continue;
    }
    if (OTHER_BLOCK.test(raw)) {
      // A quote or heading starts its own block: it never continues a command line's note.
      end();
      paragraph = [original];
      continue;
    }
    paragraph.push(original);
    if (last) last.note = [last.note, raw.trim()].filter(Boolean).join('\n');
  }
  return { lines, skipped };
}

/** The command lines of a comment (readReply's lines). */
export const commandLines = (body: string): CommandLine[] => readReply(body).lines;
