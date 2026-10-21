// Look-alike paths (#763): a changed path that reads as a locked or protected one. UTS #39's confusable skeleton
// (https://www.unicode.org/reports/tr39/#def-skeleton), from Unicode's own table (src/confusables-data.ts, generated
// by scripts/dev/confusables-data.mjs). Locked with the review levels (src/review.ts SELF_MODIFICATION_PARTS).
//
// INVARIANT: bounded and fail closed. A path over MAX_CHECKED_PATH characters, or whose skeleton grows past
// MAX_CHECKED_SKELETON, or a path reached once a change's work budget (LOOKALIKE_BUDGET) is spent, isn't compared at
// all: it counts as a look-alike (the owner reads it). Every protected pattern is a glob (money paths too, since
// round 6), compared by skeleton with a linear-time glob matcher (globMatch), never a backtracking RegExp.
import { CONFUSABLES } from './confusables-data.js';

/** The longest path (in UTF-16 code units) compared; a longer one counts as a look-alike. Linux's PATH_MAX is 4096 bytes. */
export const MAX_CHECKED_PATH = 1024;
/** The longest skeleton compared (a character can map to up to 18): a path whose skeleton is longer counts as a look-alike. */
export const MAX_CHECKED_SKELETON = 4096;
/**
 * The work one change's look-alike check may do, in glob-matching steps: each path costs the length of it and its
 * forms (as they are and read) times the patterns' total length (globMatch's work). Once it is spent, every further
 * path counts as a look-alike, not compared (#763 round 6). Sized from measurements in the PR: a change of every file
 * in this repo under its own review.yaml (1,423 paths, 308 patterns) costs about 925 million and 1.2 s; the budget
 * is about twice that.
 */
export const LOOKALIKE_BUDGET = 2_000_000_000;

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
 * A protected path pattern: a glob (compared by skeleton; `own`, when given, decides what is the glob's own instead
 * of the glob itself, as a money glob's RegExp does); a refused money-list line (`refused`: every path counts as not
 * compared, with that text, #763 round 6); or a bare RegExp from a caller that built its own money paths rather than
 * through loadMoneyPaths (tests do), tested as written against the path's skeleton forms and ASCII readings only.
 */
export type Protected = { glob: string; what: string; own?: RegExp } | { refused: string; what: string } | { re: RegExp; what: string };

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
 * A glob's parts, as globToRegExp (src/guardrails/glob.ts) reads it: a leading `./` dropped, a trailing `/` meaning
 * everything under; `**` followed by `/` (any directories, or none), `**` (anything), `*` (anything but a slash), `?`
 * (one character but a slash), and literal characters (UTF-16 code units, as that RegExp compares them).
 */
type GlobPart = { k: 'lit'; c: string } | { k: 'one' } | { k: 'star' } | { k: 'any' } | { k: 'dirs' };
function globParts(glob: string): GlobPart[] {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  const out: GlobPart[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        out.push({ k: 'dirs' });
      } else out.push({ k: 'any' });
    } else if (c === '*') out.push({ k: 'star' });
    else if (c === '?') out.push({ k: 'one' });
    else out.push({ k: 'lit', c });
  }
  return out;
}

/**
 * Whether `s` matches the glob `parts`, in linear time: a state-set walk over the parts (time is the string's length
 * times the parts', whatever the glob), never a backtracking RegExp, so no glob and no path makes it slow (#763 round
 * 6: a glob of four `**` took 25 s on a 1,000-character path as a RegExp). Same answers as globToRegExp.
 */
function globMatch(parts: readonly GlobPart[], s: string): boolean {
  const m = parts.length;
  const close = (at: Uint8Array) => {
    for (let k = 0; k < m; k++) if (at[k] && parts[k]!.k !== 'lit' && parts[k]!.k !== 'one') at[k + 1] = 1;
  };
  let at = new Uint8Array(m + 1);
  let inside = new Uint8Array(m);
  at[0] = 1;
  close(at);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const next = new Uint8Array(m + 1);
    const nextInside = new Uint8Array(m);
    let live = false;
    for (let k = 0; k < m; k++) {
      const p = parts[k]!;
      if (at[k]) {
        if (p.k === 'lit') {
          if (ch === p.c) next[k + 1] = 1;
        } else if (p.k === 'one') {
          if (ch !== '/') next[k + 1] = 1;
        } else if (p.k === 'star') {
          if (ch !== '/') next[k] = 1;
        } else if (p.k === 'any') next[k] = 1;
        else {
          nextInside[k] = 1;
          if (ch === '/') next[k + 1] = 1;
        }
      }
      if (inside[k]) {
        nextInside[k] = 1;
        if (ch === '/') next[k + 1] = 1;
      }
    }
    close(next);
    for (let k = 0; k <= m && !live; k++) live = next[k] === 1 || (k < m && nextInside[k] === 1);
    if (!live) return false;
    at = next;
    inside = nextInside;
  }
  return at[m] === 1;
}

/** Whether `s` matches `glob`, as globToRegExp(glob).test(s) answers, in linear time (globMatch). */
export const globMatches = (glob: string, s: string): boolean => globMatch(globParts(glob), s);

/**
 * Glob parts, by kind and glob: as written (raw), a form's mapping, or a form's mapping then read (`read:`, where
 * r, n is m again, so a glob's `?` stands for the one character m is). Bounded: cleared when it holds too many.
 */
const parsed = new Map<string, GlobPart[]>();
function compile(kind: 'raw' | Form | `read:${Form}`, glob: string): GlobPart[] {
  const key = `${kind}\0${glob}`;
  let parts = parsed.get(key);
  if (!parts) {
    if (parsed.size > 4096) parsed.clear();
    const form = kind.startsWith('read:') ? FORMS[kind.slice(5) as Form] : kind === 'raw' ? null : FORMS[kind as Form];
    parts = globParts(!form ? glob : kind.startsWith('read:') ? mapGlob(glob, (s) => reading(form(s))) : mapGlob(glob, form));
    parsed.set(key, parts);
  }
  return parts;
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
 * Case: an ASCII path is compared as written (its skeleton), so `Billing/` is no look-alike of `billing/**` unless the
 * glob says `Billing`; a path with a character outside ASCII is also compared caseless (a case-insensitive file
 * system may open it as the protected file).
 *
 * `budget`, when given, is the change's remaining work (LOOKALIKE_BUDGET): this path's cost comes off it, and a path
 * that costs more than is left isn't compared and counts as a look-alike.
 * null: no look-alike. Fails closed (see the module's INVARIANT).
 */
export function lookalikeOf(path: string, patterns: readonly Protected[], budget?: { left: number }): Lookalike | null {
  if (path.length > MAX_CHECKED_PATH) return { unchecked: `longer than ${MAX_CHECKED_PATH} characters` };
  try {
    const refused = patterns.find((p): p is { refused: string; what: string } => 'refused' in p);
    if (refused) return { unchecked: refused.refused };
    const spent = { unchecked: `this change's look-alike work budget (${LOOKALIKE_BUDGET} glob-matching steps) is spent` };
    if (budget && budget.left <= 0) return spent;
    const wide = nonAscii(path);
    const bare = withoutBlanks(path);
    const variants = bare === path ? [path] : [path, bare];
    const forms = variants.flatMap((v) => (wide ? WIDE_FORMS : ASCII_FORMS).map((f) => [f, FORMS[f](v)] as const));
    if (forms.some(([, s]) => s.length > MAX_CHECKED_SKELETON)) return { unchecked: `its skeleton is longer than ${MAX_CHECKED_SKELETON} characters` };
    if (budget) {
      // A glob match costs the string's length times the glob's parts (globMatch), done for the path and each form, as
      // they are and read.
      const width = patterns.reduce((n, p) => n + ('glob' in p ? p.glob.length + 1 : 1), 0);
      const cost = 2 * width * (path.length + 1 + forms.reduce((n, [, s]) => n + s.length + 1, 0));
      if (cost > budget.left) {
        budget.left = 0;
        return spent;
      }
      budget.left -= cost;
    }
    for (const p of patterns) {
      if ('glob' in p) {
        if (p.own ? p.own.test(path) : globMatch(compile('raw', p.glob), path)) continue;
        if (forms.some(([f, s]) => globMatch(compile(f, p.glob), s) || globMatch(compile(`read:${f}`, p.glob), reading(s)))) return { like: p.what };
      } else if ('re' in p) {
        if (p.re.test(path)) continue;
        const readings = [...forms.map(([, s]) => s), ...(wide || bare !== path ? variants.map((v) => asciiReading(v)) : [])];
        if (readings.some((r) => p.re.test(r))) return { like: p.what };
      }
    }
    return null;
  } catch (e) {
    return { unchecked: `the check failed: ${(e as Error).message}` };
  }
}
