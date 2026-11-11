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
  /**
   * The first character that isn't plain ASCII, as `U+XXXX`, and its line (from 1): the comment answers nothing.
   * `rendering`: found only in the tracker's rendering (GitHub's body_text), not as typed or in an entity; then `line` is
   * the comment's line of its first emoji shortcode (`:tada:`, which GitHub draws as an emoji) when it has one, else the
   * line in the rendering (R1182aq D1).
   */
  notAscii: { code: string; line: number; rendering?: 'shortcode' | 'rendering' } | null;
  /**
   * Markup a decision reply can't hold anywhere (the organizer, 2026-11-11, after R1182ar): a fenced code block (mermaid
   * and math fences draw text from codes), a `$` (GitHub math), an image (`![`: its alt text can be built from links), or
   * an HTML tag or comment. A reply is plain text; the construct and its line, or null.
   */
  markup: { construct: string; line: number } | null;
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
   * in each reading of the page (pageReadings). A live decision id found in any voids the comment (the owner, 2026-11-10,
   * rule (c); idsElsewhere).
   */
  rest: { typed: string; shown: string[] };
  /**
   * The tracker's own rendering of the comment as text (GitHub's body_text), lower case, with the six phone characters
   * mapped, and line 1's slot id (once allowed in it), or null when the tracker didn't give one (judged on the readings
   * alone). A live id in it more often than the slot allows voids the comment, as in any reading.
   */
  rendered: { text: string; slot: string | null } | null;
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
// R1182av AV1: after any character that isn't a letter, digit, _ or / (so `(/x`, `.:/x` and `"/x` count, `and/or` and
// `a/b/c` paths don't), not only after a space.
const SHAPED = /(?<![\w/])\/([a-z][\w-]*)[ \t]+(\S+)(.*?)(?=(?<![\w/])\/[a-z]|$)/g;
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
 * The named HTML entities whose value is plain ASCII (every one HTML5 has: 46, fjlig included), or one of the six phone
 * characters (read as TYPED maps them). Any other named entity, or an unknown one, decodes outside plain ASCII on the
 * page, so it voids the comment (rule (1) on the page, R1182ap AP3; pageNotAscii).
 */
const NAMED_ASCII: Readonly<Record<string, string>> = {
  amp: '&', apos: "'", ast: '*', bsol: '\\', colon: ':', comma: ',', commat: '@', diacriticalgrave: '`', dollar: '$',
  equals: '=', excl: '!', fjlig: 'fj', grave: '`', gt: '>', hat: '^', lbrace: '{', lbrack: '[', lcub: '{', lowbar: '_',
  lpar: '(', lsqb: '[', lt: '<', midast: '*', newline: '\n', num: '#', percnt: '%', period: '.', plus: '+', quest: '?',
  quot: '"', rbrace: '}', rbrack: ']', rcub: '}', rpar: ')', rsqb: ']', semi: ';', sol: '/', tab: '\t', underbar: '_',
  verbar: '|', vert: '|', verticalline: '|',
  ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
};
/**
 * The named entities that print nothing (every HTML5 one whose value is all format or default-ignorable characters: 17,
 * R1182ao D1), and the spaces. They void the comment too (not ASCII), and in the readings below they are what the page
 * draws: nothing, or a space.
 */
export const NAMED_EMPTY: readonly string[] = ['applyfunction', 'invisiblecomma', 'invisibletimes', 'negativemediumspace', 'negativethickspace', 'negativethinspace', 'negativeverythinspace', 'nobreak', 'zerowidthspace', 'af', 'ic', 'it', 'lrm', 'rlm', 'shy', 'zwj', 'zwnj'];
const NAMED_SPACE = ['nbsp', 'nonbreakingspace', 'ensp', 'emsp', 'emsp13', 'emsp14', 'thinsp', 'hairsp', 'numsp', 'puncsp', 'mediumspace', 'thinspace', 'veryspace', 'verythinspace'];

/** An entity as CommonMark reads one (the semicolon required), with its line. */
const ENTITY = /&(?:#(x[0-9a-f]{1,6}|[0-9]{1,7})|([a-z][a-z0-9]{0,31}));/gi;
/** What a numeric entity's code decodes to (NUL and out-of-range codes are U+FFFD, as HTML5 decodes them). */
const fromCode = (n: string) => {
  const code = n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
};
/** Entities decoded (numeric with or without the semicolon, as HTML attributes allow; named from the tables) and the six mapped. */
const decode = (s: string) =>
  s
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_all, n: string) => fromCode(n))
    .replace(/&([a-z][a-z0-9]*);/gi, (all, n: string) => {
      const k = n.toLowerCase();
      return NAMED_ASCII[k] ?? (NAMED_EMPTY.includes(k) ? '' : NAMED_SPACE.includes(k) ? ' ' : all);
    })
    .replace(/[\u2018\u2019\u201C\u201D\u2013\u2014]/g, (ch) => TYPED[ch]!);
/**
 * Real HTML comments and tags only (R1182ao D2, R1182ap AP1): a comment `<!-- … -->`, HTML5's empty `<!-->` and
 * `<!--->`; a tag is `<` (or `</`) right before a letter, on one line, with no `<` inside. `1 < 2 > 0`, `x <` then `>`
 * lines later, and `&lt;…&gt;` are text, as on the page.
 */
const COMMENT = /<!--(?:>|->|[\s\S]*?-->)/g;
const TAG = /<\/?[a-z][a-z0-9-]*(?:[ \t/][^<>\n]*)?>/gi;
/** Characters that print nothing dropped, markdown's emphasis, code and escape marks dropped, lower case. */
const unmark = (s: string) => s.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '').replace(/[*_~`\\]/g, '').toLowerCase();
const untag = (s: string) => s.replace(COMMENT, '').replace(TAG, '');

/**
 * Every reading of a text a page could show, for finding an id or a command in it (rule (c), R1182ao, R1182ap). Any
 * reading that contains one counts, so more readings only void more comments:
 * - decoded with tags kept (`<` and `>` left in place);
 * - real tags and comments dropped first, then decoded (CommonMark's order);
 * - decoded, then real tags and comments dropped (the first reading already holds every attribute's text, such as an
 *   image's alt, so there is no separate attribute reading: R1182aq D2);
 * - each of these reversed, for text a bidi override would draw backwards (R1182ap AP2; such text also voids as not ASCII).
 */
export function pageReadings(s: string): string[] {
  const forwards = [unmark(decode(s)), unmark(decode(untag(s))), unmark(untag(decode(s)))];
  return [...forwards, ...forwards.map((t) => [...t].reverse().join(''))];
}

/** The reading of R1182am/an (decoded, tags dropped), kept for the unit tests' examples. */
export const pageText = (s: string): string => unmark(untag(decode(s)));

/**
 * Rule (1) on the page (R1182ap AP2, AP3): what the page draws must be plain ASCII too. The first entity that decodes
 * outside plain ASCII (after the six mapped characters; a character that prints nothing counts), an unknown named
 * entity, or bidi markup (`<bdo`, a `dir=` attribute), with its line. Null when there is none.
 */
export function pageNotAscii(body: string): { code: string; line: number } | null {
  const lineOf = (i: number) => body.slice(0, i).split(/\r\n|\r|\n/).length;
  for (const m of body.matchAll(ENTITY)) {
    const value = m[1] !== undefined ? fromCode(m[1]) : NAMED_ASCII[m[2]!.toLowerCase()];
    const mapped = value?.replace(/[\u2018\u2019\u201C\u201D\u2013\u2014]/g, (ch) => TYPED[ch]!);
    if (mapped === undefined) return { code: `&${m[2]};`, line: lineOf(m.index!) };
    const bad = mapped.search(NOT_ASCII);
    if (bad >= 0) return { code: `U+${mapped.codePointAt(bad)!.toString(16).toUpperCase().padStart(4, '0')}`, line: lineOf(m.index!) };
  }
  const bidi = /<bdo\b|<[a-z][^<>\n]*[ \t/]dir[ \t]*=/i.exec(body);
  return bidi ? { code: /^<bdo/i.test(bidi[0]) ? '<bdo>' : 'dir=', line: lineOf(bidi.index) } : null;
}

/**
 * The live decision ids a comment names outside line 1's id slot (rule (c), the owner, 2026-11-10): found in the comment
 * as typed or in any reading of the page (pageReadings). Any one of them voids the comment; that, not the second-command
 * scan, is what makes sure a comment can't show a second answer to a live decision. The cost: a reply can't name its id
 * twice.
 */
export const idsElsewhere = (r: Reply, live: Iterable<string>): string[] =>
  [...live].map((x) => x.toLowerCase()).filter((x) => r.rest.typed.includes(x) || r.rest.shown.some((t) => t.includes(x)) || renderedElsewhere(r, x));

/** The tracker's rendering shows id `x` outside line 1's slot: more times than the slot accounts for (once, if it is the slot's id). */
function renderedElsewhere(r: Reply, x: string): boolean {
  if (!r.rendered) return false;
  const times = r.rendered.text.split(x).length - 1;
  return times > (r.rendered.slot === x ? 1 : 0);
}

/** The markup a reply can't hold, first by position (Reply.markup). */
const MARKUP: [string, RegExp][] = [
  // Characters, not constructs (the organizer, 2026-11-11, after R1182as/at): each starts something GitHub renders
  // (a fence or code span, a tag or a quote, math, an entity, a ~~~ fence or strikethrough), whatever the nesting or
  // line breaks, so no parser is needed and none can be fooled.
  ['a backtick (`)', /`/],
  ['a < (HTML)', /</],
  ['a > (HTML or a quote)', />/],
  ['a $ (GitHub math)', /\$/],
  ['an & (an HTML entity)', /&/],
  ['a ~ (a fence or strikethrough)', /~/],
  // Not a single character: an image's alt text can be drawn from links in its description, and GitHub's body_text
  // drops it (R1182ar AR3), so `![` stays refused too.
  ['an image (![)', /!\[/],
  // R1182au AU1: GitHub expands a task-list item or an issue reference into text the comment doesn't hold (a task list
  // naming an issue draws that issue's title), so neither is allowed: a task-list marker after a list marker, `#123`,
  // `owner/repo#123`, `GH-123`, or a link to an issue or pull request.
  ['a task-list item ([ ] or [x])', /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\]/m],
  ['an issue or PR reference (#N)', /#\d+|\bGH-\d+/i],
  ['a link to an issue or pull request', /\bgithub\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|discussions)\/\d+/i],
];
function markupIn(body: string): Reply['markup'] {
  let best: { construct: string; index: number } | null = null;
  for (const [construct, re] of MARKUP) {
    const m = re.exec(body);
    if (m && (best === null || m.index < best.index)) best = { construct, index: m.index };
  }
  return best ? { construct: best.construct, line: body.slice(0, best.index).split(/\r\n|\r|\n/).length } : null;
}

/** The first character in `body` that isn't plain ASCII, and its line. */
function firstNotAscii(body: string): Reply['notAscii'] {
  const i = body.search(NOT_ASCII);
  if (i < 0) return null;
  const code = body.codePointAt(i)!.toString(16).toUpperCase().padStart(4, '0');
  return { code: `U+${code}`, line: body.slice(0, i).split(/\r\n|\r|\n/).length };
}

/** A line's commands: on the line as typed and in each reading of it, the one that finds the most (extra defence). */
function commandsOn(raw: string, skipFirst: boolean): CommandLine[] {
  let best: CommandLine[] = [];
  for (const text of [replyText(raw), ...pageReadings(raw)]) {
    const found: CommandLine[] = [];
    let skip = skipFirst;
    for (const o of text.matchAll(ANYWHERE)) {
      if (skip) {
        skip = false;
        continue;
      }
      found.push({ option: o[1]!, ids: idsIn(`${o[1]} ${o[2]}`), note: '', idNext: false });
    }
    for (const o of text.matchAll(SHAPED)) {
      const ids = idsIn(`${o[2]} ${o[3]}`);
      if (o[1] !== BRAND.cli.toLowerCase() && ids.length > 0) found.push({ option: o[2]!, ids, note: '', idNext: false });
    }
    if (found.length > best.length) best = found;
  }
  return best;
}

/**
 * A comment as a reply: whether it is plain ASCII, its first line's command, whether that line is refused, and every
 * other command. `rendered`: the tracker's own rendering of the comment as text (GitHub's body_text), when it gave one;
 * every rule is checked on it as well, and any reading that fires voids. Missing or null: judged on `typed` and its
 * readings alone (the tracker's text is unknown, not empty).
 */
export function readReply(typed: string, rendered?: string | null): Reply {
  const body = typed.replace(/[\u2018\u2019\u201C\u201D\u2013\u2014]/g, (ch) => TYPED[ch]!);
  const shownText = typeof rendered === 'string' ? rendered.replace(/[\u2018\u2019\u201C\u201D\u2013\u2014]/g, (ch) => TYPED[ch]!) : null;
  // Rule (1) as typed, then on the page (entities and bidi markup, R1182ap), then in the tracker's own rendering.
  const typedNotAscii = firstNotAscii(body);
  const inRendering = typedNotAscii || shownText === null ? null : firstNotAscii(shownText);
  // R1182at AT3: an emoji shortcode is named only when the rendering's character is a pictograph and a `:word:` of the
  // comment is gone from the rendering (GitHub replaced it); `10:30:00` keeps its `:30:`, a footnote's U+21A9 is no emoji.
  const pictograph = inRendering !== null && /\p{Extended_Pictographic}/u.test(String.fromCodePoint(parseInt(inRendering.code.slice(2), 16)));
  const shortcode = pictograph ? ([...body.matchAll(/:[a-z0-9_+-]+:/gi)].find((m) => !shownText!.includes(m[0])) ?? null) : null;
  const notAscii =
    typedNotAscii ??
    pageNotAscii(body) ??
    (inRendering ? { code: inRendering.code, line: shortcode ? body.slice(0, shortcode.index).split(/\r\n|\r|\n/).length : inRendering.line, rendering: shortcode ? ('shortcode' as const) : ('rendering' as const) } : null);
  // A comment that isn't plain ASCII answers nothing; its ASCII characters are still read, to decide whether to say so.
  const text = typedNotAscii ? body.replace(new RegExp(NOT_ASCII.source, 'gu'), '') : body;
  const lines = text.split(/\r\n|\r|\n/);
  const at = lines.findIndex((l) => l.trim() !== '');
  const firstRaw = at >= 0 ? lines[at]! : '';
  const m = COMMAND.exec(replyText(firstRaw));
  const first = m ? { option: m[1]!, ids: idsIn(`${m[1]} ${m[2]}`), note: noteOf(firstRaw), idNext: /^[ \t]+d-[\w-]*\w[.,:;]?(?:[ \t]|$)/.test(m[2]!) } : null;
  const others = lines.flatMap((raw, i) => commandsOn(raw, i === at && first !== null));
  if (shownText !== null) {
    // The second-command scan on the tracker's rendering too: its first command (the reply's own) is skipped once.
    const shownLines = shownText.split(/\r\n|\r|\n/);
    const shownAt = shownLines.findIndex((l) => l.trim() !== '');
    others.push(...shownLines.flatMap((raw, i) => commandsOn(raw, i === shownAt && first !== null)));
  }
  // Line 1's id slot: the token right after the option, taken out once; every other place an id appears is "elsewhere".
  const slotted = (first?.idNext ? lines.map((l, i) => (i === at ? l.replace(/^(\s*\S+\s+\S+[ \t]+)\S+/, '$1') : l)) : lines).join('\n');
  return { notAscii, markup: markupIn(body), ascii: replyText(text), first, unsafe: first !== null && UNSAFE.test(firstRaw), others, rest: { typed: replyText(slotted), shown: pageReadings(slotted) }, rendered: shownText === null ? null : { text: replyText(shownText), slot: first?.idNext ? (first.ids[0] ?? null) : null } };
}
