// How a comment on an issue is read as a reply to a decision (src/coordinator/decisions.ts commentAnswer). The owner's
// decisions: a reply answers a decision only by naming its id (2026-11-09), only on the comment's first line, in plain
// text, with no other command in the comment (2026-11-10, option (b) with (b')), and only when the whole comment is
// plain ASCII (2026-11-10, after R1182ak/al). Plain ASCII has no invisible characters and no look-alike forms, and the
// characters that open code, HTML, links, escapes, strikethrough or math are refused on the first line, so what is read
// is what the page shows: no markdown and no Unicode is interpreted.
import { BRAND } from './brand.js';

/** A command: `/<cli> <option> …`, its option, the distinct decision ids on it, and its note (a `revise` note). */
export interface CommandLine {
  option: string;
  ids: string[];
  /** The rest of the line without its ids, in its original case. */
  note: string;
  /**
   * The token right after the option is an id (R1182an AN3: the shape is `/<cli> <option> <id> [note]`; an id later on
   * the line, as in `approve not yet: <id>`, doesn't answer). A comma, colon, semicolon or full stop may follow it.
   */
  idNext: boolean;
}

/** A comment read as a reply. */
export interface Reply {
  /** The first character that isn't plain ASCII, as `U+XXXX`, and its line (from 1): the comment answers nothing. */
  notAscii: { code: string; line: number } | null;
  /** The comment's ASCII characters, lower case (what a note about a non-ASCII comment is decided on). */
  ascii: string;
  /** The command on the comment's first non-blank line, or null. */
  first: CommandLine | null;
  /** The first line holds a character a reply can't (UNSAFE): it answers nothing. */
  unsafe: boolean;
  /** Every other `/<cli> <word>` in the comment, on any line (a reply is one command: these void it; extra defence). */
  others: CommandLine[];
  /**
   * The comment without line 1's id slot (the id right after the option), lower case: as typed, and as the page shows it
   * (pageText). A live decision id found in either voids the comment (the owner, 2026-11-10, rule (c); idsElsewhere).
   */
  rest: { typed: string; shown: string };
}

/**
 * Stands for a decision's id in a receipt written before the id exists; ask() (src/coordinator/base.ts) puts the id in
 * its place. R1182ae: a reply answers only by naming the id, so an instruction to reply never leaves it out.
 */
export const DECISION_ID = '<decision id>';

/** Text as a reply is compared: lower case (a reply is plain ASCII, so nothing else needs folding). */
export const replyText = (s: string): string => s.toLowerCase();

/**
 * The only characters read as others before the ASCII check (the owner, 2026-11-10): the curly quotes and the en and em
 * dashes a phone keyboard types for ' " -. Their values are only ' " and -, so they can never make a command or a slash.
 * Every other character outside plain ASCII still voids the comment.
 */
export const TYPED: Readonly<Record<string, string>> = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-' };

/** What a reply may hold anywhere: printable ASCII, tabs and line breaks. */
export const NOT_ASCII = /[^\t\n\r\x20-\x7e]/;

/**
 * What a reply's first line can't hold: each opens code, HTML, a link, an image, a quote, an escape, an entity, a
 * strikethrough (`~`, R1182aj) or GitHub math (`$`, and `%` inside it, R1182ak/al).
 */
export const UNSAFE = /[`<>[\]()"'\\&!~$%]/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CLI = escape(BRAND.cli.toLowerCase());
/** A command at the start of a line: at most 3 spaces (4 or a tab is code), the CLI, an option, the rest. */
const COMMAND = new RegExp(`^ {0,3}/${CLI}[ \\t]+(\\S+)(.*)$`);
/** A command anywhere on a line, its rest up to the next command on that line. */
const ANYWHERE = new RegExp(`/${CLI}[ \\t]+(\\S+)(.*?)(?=/${CLI}[ \\t]|$)`, 'g');
/**
 * Any other slash command that names a decision id (`/workIane reject d-1-…`, a capital I for the l, R1182ak K1d): a
 * command-shaped word after a space or at a line start, its rest up to the next one. It can only void a comment.
 */
const SHAPED = /(?<!\S)\/([a-z][\w-]*)[ \t]+(\S+)(.*?)(?=(?<!\S)\/[a-z]|$)/g;
/** A decision id where it starts at a word boundary and ends at a word character (`d-12-a3f9c1`, not `xd-1` or `d-1-`). */
const ID = /(?<![\w-])d-[\w-]*\w/g;

/** The ids in text (lower case): on a command, its option too, so `/<cli> <id> approve` names the id (and no option). */
export const idsIn = (text: string): string[] => [...new Set(text.match(ID) ?? [])];

/** A line's note: the raw text after the option, without the tokens that are ids. */
const noteOf = (raw: string) => {
  const rest = /^\s*\S+\s+\S+(.*)$/.exec(raw)?.[1] ?? '';
  return rest
    .split(/\s+/)
    .filter((t) => t && !/^d-[\w-]*\w[.,:;]*$/.test(replyText(t)))
    .join(' ')
    .trim();
};

/**
 * The named HTML entities a page turns into a character a reply's text could use: the ASCII punctuation ones, the
 * spaces, the six phone characters (then mapped as TYPED maps them) and the ones that print nothing. Letters, digits and
 * the hyphen-minus have no named entity, so numeric entities (decoded below) cover the rest of an id.
 */
const NAMED: Readonly<Record<string, string>> = {
  excl: '!', quot: '"', num: '#', dollar: '$', percnt: '%', amp: '&', apos: "'", lpar: '(', rpar: ')', ast: '*', midast: '*',
  plus: '+', comma: ',', period: '.', sol: '/', colon: ':', semi: ';', lt: '<', equals: '=', gt: '>', quest: '?',
  commat: '@', lsqb: '[', lbrack: '[', bsol: '\\', rsqb: ']', rbrack: ']', hat: '^', lowbar: '_', underbar: '_',
  grave: '`', diacriticalgrave: '`', lcub: '{', lbrace: '{', verbar: '|', vert: '|', verticalline: '|', rcub: '}',
  rbrace: '}', tab: '\t', newline: '\n', nbsp: ' ', nonbreakingspace: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', shy: '', zwj: '', zwnj: '',
  zerowidthspace: '', nobreak: '', invisibletimes: '', invisiblecomma: '', applyfunction: '', ic: '', it: '', af: '',
};

/**
 * Text as a page shows it, for finding an id in it (rule (c)): HTML entities decoded (numeric, and the named ones above),
 * the six phone characters mapped, HTML comments and tags dropped, characters that print nothing dropped, and markdown's
 * emphasis, code and escape marks (`* _ ~ \``, `\`) dropped. Lower case.
 */
export function pageText(s: string): string {
  return s
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (all, n: string) => {
      const code = n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/&([a-z]+);?/gi, (all, n: string) => NAMED[n.toLowerCase()] ?? all)
    .replace(/[\u2018\u2019\u201C\u201D\u2013\u2014]/g, (ch) => TYPED[ch]!)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/[*_~`\\]/g, '')
    .toLowerCase();
}

/**
 * The live decision ids a comment names outside line 1's id slot (rule (c), the owner, 2026-11-10): found in the comment
 * as typed or as the page shows it. Any one of them voids the comment; that, not the second-command scan, is what makes
 * sure a comment can't show a second answer to a live decision. The cost: a reply can't name its id twice.
 */
export const idsElsewhere = (r: Reply, live: Iterable<string>): string[] =>
  [...live].map((x) => x.toLowerCase()).filter((x) => r.rest.typed.includes(x) || r.rest.shown.includes(x));

/** The first character in `body` that isn't plain ASCII, and its line. */
function firstNotAscii(body: string): Reply['notAscii'] {
  const i = body.search(NOT_ASCII);
  if (i < 0) return null;
  const code = body.codePointAt(i)!.toString(16).toUpperCase().padStart(4, '0');
  return { code: `U+${code}`, line: body.slice(0, i).split(/\r\n|\r|\n/).length };
}

/** A comment as a reply: whether it is plain ASCII, its first line's command, whether that line is refused, and every other command. */
export function readReply(typed: string): Reply {
  const body = typed.replace(/[\u2018\u2019\u201C\u201D\u2013\u2014]/g, (ch) => TYPED[ch]!);
  const notAscii = firstNotAscii(body);
  // A comment that isn't plain ASCII answers nothing; its ASCII characters are still read, to decide whether to say so.
  const text = notAscii ? body.replace(new RegExp(NOT_ASCII.source, 'gu'), '') : body;
  const lines = text.split(/\r\n|\r|\n/);
  const at = lines.findIndex((l) => l.trim() !== '');
  const firstRaw = at >= 0 ? lines[at]! : '';
  const m = COMMAND.exec(replyText(firstRaw));
  const first = m ? { option: m[1]!, ids: idsIn(`${m[1]} ${m[2]}`), note: noteOf(firstRaw), idNext: /^[ \t]+d-[\w-]*\w[.,:;]?(?:[ \t]|$)/.test(m[2]!) } : null;
  const others: CommandLine[] = [];
  lines.forEach((raw, i) => {
    let skip = i === at && first !== null; // the first line's own command is `first`, not another
    // As typed, and as the page shows it (entities, tags and emphasis undone), whichever finds more.
    const typedHits = [...replyText(raw).matchAll(ANYWHERE)].length;
    const shownLine = pageText(raw);
    const scan = [...shownLine.matchAll(ANYWHERE)].length > typedHits ? shownLine : replyText(raw);
    for (const o of scan.matchAll(ANYWHERE)) {
      if (skip) {
        skip = false;
        continue;
      }
      others.push({ option: o[1]!, ids: idsIn(`${o[1]} ${o[2]}`), note: '', idNext: false });
    }
    for (const o of scan.matchAll(SHAPED)) {
      const ids = idsIn(`${o[2]} ${o[3]}`);
      if (o[1] !== BRAND.cli.toLowerCase() && ids.length > 0) others.push({ option: o[2]!, ids, note: '', idNext: false });
    }
  });
  // Line 1's id slot: the token right after the option, taken out once; every other place an id appears is "elsewhere".
  const slotted = first?.idNext ? lines.map((l, i) => (i === at ? l.replace(/^(\s*\S+\s+\S+[ \t]+)\S+/, '$1') : l)) : lines;
  const restTyped = replyText(slotted.join('\n'));
  return { notAscii, ascii: replyText(text), first, unsafe: first !== null && UNSAFE.test(firstRaw), others, rest: { typed: restTyped, shown: pageText(slotted.join('\n')) } };
}
