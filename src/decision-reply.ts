// How a comment on an issue is read as a reply to a decision (src/coordinator/decisions.ts commentAnswer): its command
// lines, each with its option and every decision id on it. The owner's decision (2026-11-09): a reply answers a
// decision only by naming its id, so this is all a reply is ever read for.
import { BRAND } from './brand.js';

/** One command line of a reply: `/<cli> <option> …`, its option and the distinct decision ids on it. */
export interface CommandLine {
  option: string;
  ids: string[];
}

/**
 * Text as a reply is compared: NFKC (full-width letters and digits to ASCII, a no-break space to a space), every Unicode
 * dash to `-`, lower case. So a look-alike id reads as the id it spells and can only equal that decision.
 */
export const replyText = (s: string): string => s.normalize('NFKC').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-').toLowerCase();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMMAND = new RegExp(`^/${escape(BRAND.cli.toLowerCase())}[^\\S\\r\\n]+(\\S+)(.*)$`);
/** A decision id where it starts at a word boundary and ends at a word character (`d-12-a3f9c1`, not `xd-1` or `d-1-`). */
const ID = /(?<![\w-])d-[\w-]*\w/g;
/** A CommonMark fence line: at most 3 spaces, then 3 or more backticks or tildes, then the rest. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The command lines of a comment, as a reader sees them rendered (CommonMark): lines inside a fenced code block (opened
 * by 3+ backticks or tildes with at most 3 spaces of indent; closed only by a run of the same character at least as
 * long, with nothing after it) and inside an HTML comment (`<!--` to `-->`, also across lines) are not read. A command
 * line starts at the start of its line (so a blockquote or indented code never is one).
 */
export function commandLines(body: string): CommandLine[] {
  const out: CommandLine[] = [];
  let fence: { char: string; length: number } | null = null;
  let comment = false;
  for (const raw of body.split(/\r\n|\r|\n/)) {
    if (fence) {
      const m = FENCE.exec(raw);
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.length && m[2]!.trim() === '') fence = null;
      continue;
    }
    if (comment) {
      // The rest of a line after `-->` doesn't start a line, so it is never a command line.
      if (raw.includes('-->')) comment = false;
      continue;
    }
    const f = FENCE.exec(raw);
    // A backtick fence's info string can't hold a backtick (CommonMark 4.5); then it isn't a fence.
    if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) {
      fence = { char: f[1]![0]!, length: f[1]!.length };
      continue;
    }
    let line = raw.replace(/<!--[\s\S]*?-->/g, '');
    const open = line.indexOf('<!--');
    if (open >= 0) {
      comment = true;
      line = line.slice(0, open);
    }
    const m = COMMAND.exec(replyText(line));
    if (m) out.push({ option: m[1]!, ids: [...new Set(m[2]!.match(ID) ?? [])] });
  }
  return out;
}
