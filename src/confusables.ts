// Look-alike paths (#763): a changed path that reads as a locked or protected one. UTS #39's confusable skeleton
// (https://www.unicode.org/reports/tr39/#def-skeleton), from Unicode's own table (src/confusables-data.ts, generated
// by scripts/dev/confusables-data.mjs). Locked with the review levels (src/review.ts SELF_MODIFICATION_PARTS).
//
// INVARIANT: bounded and fail closed. A path over MAX_CHECKED_PATH characters, or whose skeleton grows past
// MAX_CHECKED_SKELETON, isn't compared at all: it counts as a look-alike (the owner reads it), so no input makes the
// glob matching slow and none slips past it unread.
import { CONFUSABLES } from './confusables-data.js';
import { globToRegExp } from './guardrails/glob.js';

/** The longest path (in UTF-16 code units) compared; a longer one counts as a look-alike. Linux's PATH_MAX is 4096 bytes. */
export const MAX_CHECKED_PATH = 1024;
/** The longest skeleton compared (a character can map to up to 18): a path whose skeleton is longer counts as a look-alike. */
export const MAX_CHECKED_SKELETON = 4096;

let table: Map<number, string> | undefined;
/** Each character's prototype, read once from the generated table: one mapping a line, the character then its prototype. */
function prototypes(): Map<number, string> {
  if (table) return table;
  const t = new Map<number, string>();
  for (const line of CONFUSABLES.split('\n')) {
    if (!line) continue;
    const from = line.codePointAt(0)!;
    t.set(from, line.slice(String.fromCodePoint(from).length));
  }
  return (table = t);
}

const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

/**
 * UTS #39 skeleton(X): NFD, drop default-ignorable code points, map each character to its prototype, NFD again. Two
 * strings are confusable when their skeletons are equal (`docs/releasing.md` with a Cyrillic e for its first e, and
 * `docs/releasing.md`; `rn` and `m`).
 */
export function skeleton(s: string): string {
  const t = prototypes();
  let out = '';
  for (const ch of s.normalize('NFD')) {
    if (IGNORABLE.test(ch)) continue;
    out += t.get(ch.codePointAt(0)!) ?? ch;
  }
  return out.normalize('NFD');
}

/**
 * A full case fold, near enough for file names: upper then lower case, so the long s and the Kelvin sign fold to `s`
 * and `k` as a case-insensitive file system (macOS, Windows) may open them. A guess at those systems' own tables (not
 * measured); it only ever adds matches.
 */
const fold = (s: string): string => s.toUpperCase().toLowerCase();

/** The caseless skeleton: a name a case-insensitive file system may open as another's, and that reads as it. */
const caseless = (s: string): string => fold(skeleton(fold(s)));

/** Whether a string has a character outside ASCII. */
const nonAscii = (s: string): boolean => /\P{ASCII}/u.test(s);

/**
 * The compatibility form (NFKC): a fullwidth or mathematical letter as the plain one, which UTS #39's table leaves to
 * NFKC. Compared as well as the path itself: it only ever adds matches.
 */
const compat = (s: string): string => s.normalize('NFKC');

/**
 * The braille pattern with no dots: it shows as a blank, yet it is neither a format nor a default-ignorable character
 * nor White_Space, so no other check of a name's characters sees it (#688's round-4 finding). Written as itself;
 * test/confusables.test.ts checks it is the first character of the Braille script.
 */
export const BRAILLE_BLANK = '⠀';

/**
 * A character that shows as blank space or as nothing: White_Space (an ASCII space, a no-break space, an ideographic
 * space, ...) or the braille blank. Default-ignorable ones are dropped by the skeleton already.
 */
const BLANK = new RegExp(`[\\p{White_Space}${BRAILLE_BLANK}]`, 'gu');

/** A path with every blank-looking character taken out: how a name with a trailing or stray blank reads. */
const withoutBlanks = (s: string): string => s.replace(BLANK, '');

/** The printable ASCII a character outside ASCII reads as (its skeleton, or its compatibility form's), or null. */
function readsAs(ch: string): string | null {
  for (const form of [ch, compat(ch)]) {
    const sk = skeleton(form);
    if (sk && /^[ -~]+$/.test(sk)) return sk;
  }
  return null;
}

/** A path with each look-alike character replaced by the ASCII it reads as (for regexes, which can't be skeletonized). */
function asciiReading(path: string): string {
  let out = '';
  for (const ch of path) {
    if (!nonAscii(ch)) {
      out += ch;
      continue;
    }
    // A default-ignorable character reads as nothing (its skeleton is empty).
    out += readsAs(ch) ?? (skeleton(ch) === '' ? '' : ch);
  }
  return out;
}

/**
 * A protected path pattern: a glob (compared by skeleton; `own`, when given, decides what is the glob's own instead
 * of the glob itself, as a money glob's RegExp does) or a regex (a money-list regex literal: see lookalikeOf).
 */
export type Protected = { glob: string; what: string; own?: RegExp } | { re: RegExp; what: string };

/** A glob with each literal run (everything but `*` and `?`) mapped by `f`. A mapped `*` or `?` widens it: fails closed. */
const mapGlob = (glob: string, f: (s: string) => string): string => glob.split(/([*?]+)/).map((part, i) => (i % 2 ? part : f(part))).join('');

/**
 * The ways a name is compared, each applied to the path and to a glob's literal runs alike: UTS #39's skeleton, the
 * caseless one, and each of the compatibility form (compat).
 */
const FORMS: Record<'skeleton' | 'caseless' | 'compat-skeleton' | 'compat-caseless', (s: string) => string> = {
  skeleton,
  caseless,
  'compat-skeleton': (s) => skeleton(compat(s)),
  'compat-caseless': (s) => caseless(compat(s)),
};
type Form = keyof typeof FORMS;
/** For a pure-ASCII path only the skeleton: its compatibility form is itself, and case counts only outside ASCII. */
const ASCII_FORMS: readonly Form[] = ['skeleton'];
const WIDE_FORMS: readonly Form[] = ['skeleton', 'caseless', 'compat-skeleton', 'compat-caseless'];

/** Compiled globs, by form and glob. Bounded: cleared when it holds too many (the globs come from review.yaml). */
const compiled = new Map<string, RegExp>();
function compile(kind: 'raw' | Form, glob: string): RegExp {
  const key = `${kind}\0${glob}`;
  let re = compiled.get(key);
  if (!re) {
    if (compiled.size > 4096) compiled.clear();
    re = globToRegExp(kind === 'raw' ? glob : mapGlob(glob, FORMS[kind]));
    compiled.set(key, re);
  }
  return re;
}

/** A string as a regex matches it literally, outside a class (only syntax characters escaped, as the u flag allows). */
const reLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The skeletons a literal character of a regex stands for that the regex doesn't match already: its own, and under
 * the `i` flag its lower and upper case's too (a capital M stands for an m, whose skeleton is r, n).
 */
function skeletonsOf(c: string, ci: boolean): string[] {
  const forms = ci ? [c, c.toLowerCase(), c.toUpperCase()] : [c];
  const same = (s: string) => s === c || (ci && s.toLowerCase() === c.toLowerCase());
  return [...new Set(forms.map(skeleton))].filter((s) => !same(s));
}

/** Where the syntax that starts at `i` ends (one past it): an escape, a group opening, a class or a quantifier's braces. */
function syntaxEnd(src: string, i: number, sets: boolean): number {
  const to = (close: string, from: number) => {
    const j = src.indexOf(close, from);
    return j < 0 ? src.length : j + 1;
  };
  const c = src[i];
  if (c === '\\') {
    const n = src[i + 1];
    if ((n === 'k' && src[i + 2] === '<') || ((n === 'p' || n === 'P' || n === 'u') && src[i + 2] === '{')) return to(n === 'k' ? '>' : '}', i + 2);
    if (n === 'u') return i + 6;
    if (n === 'x') return i + 4;
    if (n === 'c') return i + 3;
    if (n !== undefined && /[0-9]/.test(n)) return i + 1 + /^[0-9]+/.exec(src.slice(i + 1))![0].length;
    return i + 2;
  }
  if (c === '(' && src[i + 1] === '?') {
    // A named group's name, copied as it is; a lookbehind; a modifier group's flags; then its : = or !.
    if (src[i + 2] === '<' && src[i + 3] !== '=' && src[i + 3] !== '!') return to('>', i + 3);
    let j = i + 2;
    while (j < src.length && /[A-Za-z-]/.test(src[j]!)) j++;
    if (src[j] === '<' && (src[j + 1] === '=' || src[j + 1] === '!')) return j + 2;
    return src[j] === ':' || src[j] === '=' || src[j] === '!' ? j + 1 : j;
  }
  if (c === '[') {
    // To the class's closing bracket, past escapes (and nested classes under the v flag).
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '[' && (j === i || sets)) depth++;
      else if (src[j] === ']' && --depth === 0) return j + 1;
    }
    return src.length;
  }
  if (c === '{' && /^\{[0-9]+(,[0-9]*)?\}/.test(src.slice(i))) return to('}', i);
  return i;
}

/** The members of a plain (not negated) class's source that are literal characters, its ranges spelled out (ASCII only). */
function classMembers(cls: string): string[] {
  const body = [...cls.slice(1, -1)];
  const out: string[] = [];
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '\\') {
      k++;
      continue;
    }
    if (body[k + 1] === '-' && body[k + 2] !== undefined && body[k + 2] !== '\\') {
      const [a, b] = [body[k]!.codePointAt(0)!, Math.min(body[k + 2]!.codePointAt(0)!, 127)];
      for (let cp = a; cp <= b; cp++) out.push(String.fromCodePoint(cp));
      k += 2;
    } else out.push(body[k]!);
  }
  return out;
}

/**
 * A regex (a money-list regex literal) rewritten to match a path's skeleton (#763): each literal character outside
 * other syntax as itself or the skeletons it stands for (skeletonsOf: under `i`, both cases'), and each plain class
 * as itself or its members' skeletons; a dot, a negated class and a class escape as one or two of what they stand
 * for. Other escapes, group names and back-references, lookarounds, modifier flags and quantifier braces are copied
 * as they are. A regex naming payments then holds the path spelled with r, n for its m. null when the
 * rewritten source isn't a valid regex: lookalikeOf then holds every path the regex doesn't match (fails closed).
 */
const skeletonRegExps = new WeakMap<RegExp, RegExp | null>();
function skeletonRegExp(re: RegExp): RegExp | null {
  if (skeletonRegExps.has(re)) return skeletonRegExps.get(re)!;
  const src = re.source;
  const ci = re.flags.includes('i');
  const sets = re.flags.includes('v');
  let out = '';
  for (let i = 0; i < src.length; ) {
    const end = syntaxEnd(src, i, sets);
    if (end > i) {
      const part = src.slice(i, end);
      const alts = part.startsWith('[') && !part.startsWith('[^') ? [...new Set(classMembers(part).flatMap((m) => skeletonsOf(m, ci)))] : [];
      // A negated class or a class escape stands for one character, which may be one whose skeleton is two (m).
      const oneOfAny = part.startsWith('[^') || /^\\([wWdDsS]$|[pP]\{)/.test(part);
      out += alts.length ? `(?:${part}|${alts.map(reLiteral).join('|')})` : oneOfAny ? `(?:${part}${part}?)` : part;
      i = end;
      continue;
    }
    const c = String.fromCodePoint(src.codePointAt(i)!);
    const alts = /^[\\^$.|?*+()[\]{}/]$/.test(c) ? [] : skeletonsOf(c, ci);
    // A dot stands for one character, which may be one whose skeleton is two (m: r, n).
    out += c === '.' ? '(?:..?)' : alts.length ? `(?:${reLiteral(c)}|${alts.map(reLiteral).join('|')})` : c;
    i += c.length;
  }
  let mapped: RegExp | null;
  try {
    mapped = new RegExp(out, re.flags.replace(/[gy]/g, ''));
  } catch {
    mapped = null;
  }
  skeletonRegExps.set(re, mapped);
  return mapped;
}

/** Why a path counts as a look-alike: of which protected pattern, or that it wasn't compared (too long, or a failure). */
export type Lookalike = { like: string } | { unchecked: string };

/**
 * Whether `path` reads as a path one of `patterns` protects without being one: its skeleton (UTS #39) matches the
 * pattern's skeleton, or, for a name with a character outside ASCII, its caseless skeleton matches (a case-insensitive
 * file system may open it as the protected file: a long s for an s), or either of its compatibility form's does (a
 * fullwidth letter), while the path itself doesn't match that pattern. A name with a blank-looking character (a
 * space, a no-break space, the braille blank) is compared without them too. A path a pattern matches as itself is
 * that pattern's own and not a look-alike of it. Regexes (money-list regex literals) are tested against the path's
 * skeleton forms and ASCII readings, and, mapped by skeletonRegExp, against its skeleton forms; a regex it can't map
 * holds every path the regex doesn't match. A dot, a negated class and a class escape (`\w`, `\p{L}`) stand for one
 * or two characters (a skeleton of two, as m's is). Residual: a wildcard standing for a character whose skeleton is
 * longer than two (only characters outside ASCII have one).
 * null: no look-alike. Fails closed (see the module's INVARIANT).
 */
export function lookalikeOf(path: string, patterns: readonly Protected[]): Lookalike | null {
  if (path.length > MAX_CHECKED_PATH) return { unchecked: `longer than ${MAX_CHECKED_PATH} characters` };
  try {
    const wide = nonAscii(path);
    const bare = withoutBlanks(path);
    const variants = bare === path ? [path] : [path, bare];
    const forms = variants.flatMap((v) => (wide ? WIDE_FORMS : ASCII_FORMS).map((f) => [f, FORMS[f](v)] as const));
    if (forms.some(([, s]) => s.length > MAX_CHECKED_SKELETON)) return { unchecked: `its skeleton is longer than ${MAX_CHECKED_SKELETON} characters` };
    // A regex can't be skeletonized, so it is tested against the path's skeleton forms (fails closed: any path whose
    // skeleton the regex matches is held) and, for a name outside ASCII or with a blank, its ASCII readings.
    const readings = [...forms.map(([, s]) => s), ...(wide || bare !== path ? variants.flatMap((v) => [v, compat(v)]).flatMap((s) => [asciiReading(s), asciiReading(fold(s))]) : [])];
    for (const p of patterns) {
      if ('glob' in p) {
        if ((p.own ?? compile('raw', p.glob)).test(path)) continue;
        if (forms.some(([f, s]) => compile(f, p.glob).test(s))) return { like: p.what };
      } else {
        if (p.re.test(path)) continue;
        if (readings.some((r) => p.re.test(r))) return { like: p.what };
        const mapped = skeletonRegExp(p.re);
        // A regex the rewrite can't map can't be judged for look-alikes: every path it doesn't match waits (fails closed).
        if (!mapped) return { unchecked: `a money-list regex the look-alike check can't map` };
        if (forms.some(([, s]) => mapped.test(s))) return { like: p.what };
      }
    }
    return null;
  } catch (e) {
    return { unchecked: `the check failed: ${(e as Error).message}` };
  }
}
