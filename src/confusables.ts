// Look-alike paths (#763): a changed path that reads as a locked or protected one. UTS #39's confusable skeleton
// (https://www.unicode.org/reports/tr39/#def-skeleton), from Unicode's own table (src/confusables-data.ts, generated
// by scripts/dev/confusables-data.mjs). Locked with the review levels (src/review.ts SELF_MODIFICATION_PARTS).
//
// INVARIANT: bounded and fail closed. A path over MAX_CHECKED_PATH characters, or whose skeleton grows past
// MAX_CHECKED_SKELETON, or with more than MAX_READINGS readings to test a money regex against, isn't compared at all:
// it counts as a look-alike (the owner reads it). A money regex is never rewritten: it runs as the owner wrote it, on
// a bounded set of readings of the path, so it takes the time it takes on the path itself, times that bound.
import { CONFUSABLES } from './confusables-data.js';
import { globToRegExp } from './guardrails/glob.js';

/** The longest path (in UTF-16 code units) compared; a longer one counts as a look-alike. Linux's PATH_MAX is 4096 bytes. */
export const MAX_CHECKED_PATH = 1024;
/** The longest skeleton compared (a character can map to up to 18): a path whose skeleton is longer counts as a look-alike. */
export const MAX_CHECKED_SKELETON = 4096;
/** The most readings of one path a money regex is tested against; a path with more counts as a look-alike. */
export const MAX_READINGS = 1024;

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

/** The combining dot above, taken from an e with a dot above (written as itself) so no code point number is needed. */
export const COMBINING_DOT_ABOVE = 'ė'.normalize('NFD').slice(1);
/** The dotless i, which a combining dot above turns into a plain-looking i. */
const DOTLESS_I = 'ı';
/** A character whose own dot hides a combining dot above after it (Soft_Dotted: i, j and kin), or the dotless i. */
const HIDES_DOT = (ch: string): boolean => ch === DOTLESS_I || /^\p{Soft_Dotted}$/u.test(ch);

/**
 * UTS #39 skeleton(X): NFD, drop default-ignorable code points, map each character to its prototype, NFD again. Two
 * strings are confusable when their skeletons are equal (`docs/releasing.md` with a Cyrillic e for its first e, and
 * `docs/releasing.md`; `rn` and `m`). Also drops a combining dot above after a soft-dotted letter or a dotless i
 * (with only other marks between), which the letter's own dot hides (UTS #39 section 5.4, #763 round 5).
 */
export function skeleton(s: string): string {
  const t = prototypes();
  let out = '';
  let base = '';
  for (const ch of s.normalize('NFD')) {
    if (IGNORABLE.test(ch)) continue;
    if (!/^\p{M}$/u.test(ch)) base = ch;
    else if (ch === COMBINING_DOT_ABOVE && HIDES_DOT(base)) continue;
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
 * The groups of printable ASCII spellings that share a skeleton, from Unicode's table: l, 1, I and the vertical bar;
 * O and 0; m and r, n; the apostrophe and the backquote; the double quote and two apostrophes. Read once.
 */
let groups: string[][] | undefined;
function asciiGroups(): string[][] {
  if (groups) return groups;
  const by = new Map<string, Set<string>>();
  for (let cp = 32; cp < 127; cp++) {
    const c = String.fromCharCode(cp);
    const s = skeleton(c);
    if (s === c || !/^[ -~]+$/.test(s)) continue;
    const g = by.get(s) ?? new Set([s]);
    g.add(c);
    by.set(s, g);
  }
  return (groups = [...by.values()].map((g) => [...g]));
}

/** A string with each multi-character spelling of a group read as the group's one-character spelling (r, n as m). */
function reading(s: string): string {
  let out = s;
  for (const g of asciiGroups()) {
    const one = g.find((m) => m.length === 1);
    if (one) for (const m of g) if (m.length > 1) out = out.split(m).join(one);
  }
  return out;
}

/**
 * The readings of a string a money regex is tested against (#763 round 5): for each group of ASCII spellings that
 * share a skeleton (asciiGroups) and that the string uses, the string as it is, or with every use of one spelling
 * read as another (every 1 as l, every l as I, every r, n as m, ...), across the groups in every combination. null
 * when there are more than `cap` (the caller holds the path). It covers a look-alike that spells one group's member
 * one way throughout (`payrnents`, `0001` as `OOO1`); a path that needs one spelling read two ways is the residual.
 */
function substitutions(s: string, cap: number): string[] | null {
  let out = [s];
  for (const g of asciiGroups()) {
    const present = g.filter((m) => s.includes(m));
    if (!present.length) continue;
    const swaps = present.flatMap((from) => g.filter((to) => to !== from).map((to) => [from, to] as const));
    if (out.length * (swaps.length + 1) > cap) return null;
    out = out.flatMap((r) => [r, ...swaps.map(([from, to]) => r.split(from).join(to))]);
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
 * caseless one, each of the compatibility form (compat), and the skeleton's own compatibility form skeletonized
 * again (a character that reaches ASCII only in that order, #763 round 5).
 */
const FORMS: Record<'skeleton' | 'caseless' | 'compat-skeleton' | 'compat-caseless' | 'skeleton-compat' | 'skeleton-compat-caseless', (s: string) => string> = {
  skeleton,
  caseless,
  'compat-skeleton': (s) => skeleton(compat(s)),
  'compat-caseless': (s) => caseless(compat(s)),
  'skeleton-compat': (s) => skeleton(compat(skeleton(s))),
  'skeleton-compat-caseless': (s) => fold(skeleton(compat(skeleton(fold(s))))),
};
type Form = keyof typeof FORMS;
/** For a pure-ASCII path only the skeleton: its compatibility form is itself, and case counts only outside ASCII. */
const ASCII_FORMS: readonly Form[] = ['skeleton'];
const WIDE_FORMS: readonly Form[] = ['skeleton', 'caseless', 'compat-skeleton', 'compat-caseless', 'skeleton-compat', 'skeleton-compat-caseless'];

/**
 * Compiled globs, by kind and glob: as written (raw), a form's mapping, or a form's mapping then read (`read:`, where
 * r, n is m again, so a glob's `?` stands for the one character m is). Bounded: cleared when it holds too many.
 */
const compiled = new Map<string, RegExp>();
function compile(kind: 'raw' | Form | `read:${Form}`, glob: string): RegExp {
  const key = `${kind}\0${glob}`;
  let re = compiled.get(key);
  if (!re) {
    if (compiled.size > 4096) compiled.clear();
    const form = kind.startsWith('read:') ? FORMS[kind.slice(5) as Form] : kind === 'raw' ? null : FORMS[kind as Form];
    re = globToRegExp(!form ? glob : kind.startsWith('read:') ? mapGlob(glob, (s) => reading(form(s))) : mapGlob(glob, form));
    compiled.set(key, re);
  }
  return re;
}

/** Why a path counts as a look-alike: of which protected pattern, or that it wasn't compared (too long, or a failure). */
export type Lookalike = { like: string } | { unchecked: string };

/**
 * Whether `path` reads as a path one of `patterns` protects without being one: its skeleton (UTS #39) matches the
 * pattern's skeleton, or, for a name with a character outside ASCII, its caseless skeleton matches (a case-insensitive
 * file system may open it as the protected file: a long s for an s), or one of its compatibility forms' does (a
 * fullwidth letter), while the path itself doesn't match that pattern. A name with a blank-looking character (a
 * space, a no-break space, the braille blank) is compared without them too. Each form is also compared read (r, n as
 * m), so a glob's `?` stands for an m spelled r, n. A path a pattern matches as itself is that pattern's own and not
 * a look-alike of it.
 *
 * A money-list regex literal is never rewritten. It is tested, as written, against readings of the path: its
 * skeleton forms and their readings, its ASCII readings, and the substitutions of each (every 1 read as l, every r, n
 * as m, and so on, in every combination; see substitutions). More than MAX_READINGS of them hold the path. Residual
 * (no sound check exists without an automaton): a path that needs one spelling read two ways, as when a real l and a
 * look-alike l for I sit in one name.
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
    let texts: string[] | null | undefined;
    const regexTexts = (): string[] | null => {
      if (texts !== undefined) return texts;
      const bases = new Set<string>(variants);
      if (wide || bare !== path) for (const s of variants.flatMap((v) => [v, compat(v)])) for (const r of [asciiReading(s), asciiReading(fold(s))]) bases.add(r);
      for (const [, s] of forms) bases.add(reading(s));
      // Lower case too: Unicode's ASCII look-alikes are lower case (r, n for m), and a case-insensitive regex reads it.
      for (const b of [...bases]) bases.add(b.toLowerCase());
      const all = new Set<string>(forms.map(([, s]) => s));
      for (const b of bases) {
        const subs = substitutions(b, MAX_READINGS);
        if (!subs) return (texts = null);
        for (const r of subs) all.add(r);
        if (all.size > MAX_READINGS) return (texts = null);
      }
      return (texts = [...all]);
    };
    for (const p of patterns) {
      if ('glob' in p) {
        if ((p.own ?? compile('raw', p.glob)).test(path)) continue;
        if (forms.some(([f, s]) => compile(f, p.glob).test(s) || compile(`read:${f}`, p.glob).test(reading(s)))) return { like: p.what };
      } else {
        if (p.re.test(path)) continue;
        const rs = regexTexts();
        if (!rs) return { unchecked: `more than ${MAX_READINGS} readings to test a money regex against` };
        if (rs.some((r) => p.re.test(r))) return { like: p.what };
      }
    }
    return null;
  } catch (e) {
    return { unchecked: `the check failed: ${(e as Error).message}` };
  }
}
