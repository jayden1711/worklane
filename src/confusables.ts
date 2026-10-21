// Look-alike paths (#763): a changed path that reads as a locked or protected one. UTS #39's confusable skeleton
// (https://www.unicode.org/reports/tr39/#def-skeleton), from Unicode's own table (src/confusables-data.ts, generated
// by scripts/dev/confusables-data.mjs). Locked with the review levels (src/review.ts SELF_MODIFICATION_PARTS).
//
// INVARIANT: bounded and fail closed. A path over MAX_CHECKED_PATH characters, or with a run of more than MAX_MARK_RUN
// combining marks, or one of whose forms grows past MAX_CHECKED_SKELETON at any pass, or a path reached once a
// change's work budget (LOOKALIKE_BUDGET, charged per comparison, per character walked and per character a form's
// pass reads and makes) is spent, isn't compared (further): it counts as a look-alike (the owner reads it). Every
// protected pattern is a glob (money paths too, since round 6), compared by skeleton with a linear-time glob matcher
// (globMatch), never a backtracking RegExp.
import { CONFUSABLES } from './confusables-data.js';

/** The longest path (in UTF-16 code units) compared; a longer one counts as a look-alike. Linux's PATH_MAX is 4096 bytes. */
export const MAX_CHECKED_PATH = 1024;
/** The longest skeleton compared (a character can map to up to 18): a path whose skeleton is longer counts as a look-alike. */
export const MAX_CHECKED_SKELETON = 4096;
/**
 * The longest run of combining marks normalized (UAX #15's stream-safe limit): a path with a longer one, as written or
 * in any string the check normalizes (normalized), counts as a look-alike.
 */
export const MAX_MARK_RUN = 30;
/**
 * The halfwidth katakana voiced and semi-voiced sound marks, written as themselves: letter modifiers, not combining
 * marks, yet their NFKC form is a combining mark of a nonzero class, so normalizing joins them to the run of marks
 * before them (#763 round 9). test/confusable-mark-runs.test.ts checks every code point: these two are the only
 * characters outside \p{M} whose NFKC form starts with a non-starter, and every non-starter is \p{M}.
 */
export const HALFWIDTH_SOUND_MARKS = 'ﾞﾟ';
/** A character that is a combining mark or whose NFKC form starts with one (a non-starter). */
const MARK = new RegExp(`^[\\p{M}${HALFWIDTH_SOUND_MARKS}]$`, 'u');
/** Each code point's kind, filled as met (0 not yet, 1 not a mark, 2 a mark: MARK), made on first use. */
let markKinds: Uint8Array | undefined;
/**
 * Whether `s` has a run of more than MAX_MARK_RUN marks (MARK), counted in characters. One pass over its code units,
 * each code point classified once per process (#763 round 10: a global RegExp's runs cost about 37 ns a character,
 * measured by the round-9 adversarial review; round 9's first version, a pattern of 31 marks retried from every
 * mark, cost 160 microseconds a 1,000-character path).
 */
function overMarkRun(s: string): boolean {
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c > 65535) i++;
    let kind = 1;
    if (c >= 128) {
      markKinds ??= new Uint8Array(17 * 65536);
      kind = markKinds[c]!;
      if (kind === 0) markKinds[c] = kind = MARK.test(String.fromCodePoint(c)) ? 2 : 1;
    }
    if (kind === 1) run = 0;
    else if (++run > MAX_MARK_RUN) return true;
  }
  return false;
}
/**
 * Characters every normalization and skeleton read or made (#763 round 10): normalized and skeleton count what they
 * do as they do it, so a pass refused partway (MarkRunOver) is charged for the part it did (pathForms).
 */
let normed = 0;
/** Thrown by normalized for a string with a longer run than MAX_MARK_RUN; lookalikeOf holds the path for it. */
class MarkRunOver extends Error {}
/**
 * INVARIANT (#763 round 9): every normalization in this module is this call, so the run limit applies to the exact
 * string normalized, whichever path variant (with or without its blanks) and pass (skeleton, NFKC) it comes from.
 * Normalizing a run of marks sorts it, in time that grows with the square of its length in V8 (measured by the
 * round-8 delta check: 1,000 marks out of order cost 431 microseconds a call, 4,096 cost 6.5 ms). Before round 9 only the
 * path as written was checked: runs of 30 split by blanks joined in the blank-free variant, and the halfwidth sound
 * marks (not \p{M}) joined the marks around them under NFKC. test/confusable-mark-runs.test.ts checks that no other
 * line of this module normalizes.
 */
function normalized(s: string, form: 'NFD' | 'NFKC'): string {
  normed += s.length + 1;
  if (overMarkRun(s)) throw new MarkRunOver(`a run of more than ${MAX_MARK_RUN} combining marks`);
  const out = s.normalize(form);
  normed += out.length + 1;
  return out;
}
/**
 * The work one change's look-alike check may do, in steps (PAIR_COST, WALK_COST, FORM_CHAR_COST and
 * RUN_HOLD_CHAR_COST below), charged as the work is done. Once it is overdrawn, the path being compared and every
 * further path count as look-alikes, not compared (#763 rounds 6 to 8), and no further work is done on them (round
 * 10). Sized (round 10) so that the slowest shape found, 5,000 paths, takes under half of LOOKALIKE_BOUND_MS for one
 * computeLevel on the machine measured; it was 2 billion until round 9, which took 7.46 s on CI. A change of every
 * file in this repo doesn't spend it.
 */
export const LOOKALIKE_BUDGET = 1_000_000_000;
/**
 * The time bound (#763 rounds 9 and 10), in ms: one computeLevel of up to 5,000 changed paths of up to 1,020
 * characters, its look-alike check included, budget spent or not. Past that size main's own per-path category
 * matching grows on its own. The tests that hold it count budget units (deterministic: test/confusable-*.test.ts);
 * one coarse wall-clock test (test/confusable-mark-runs.test.ts) runs the slowest shape found against it in a child
 * process. Measured on one machine under load; how fast another machine is, is a guess.
 */
export const LOOKALIKE_BOUND_MS = 6_000;

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
export const COMBINING_DOT_ABOVE = normalized('ė', 'NFD').slice(1);
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
export function skeleton(s: string, cap = Infinity): string {
  const t = prototypes();
  let out = '';
  let base = '';
  const nfd = normalized(s, 'NFD');
  // What the loop reads (round 10); what it makes is counted when it is normalized, or here when it stops at `cap`.
  normed += nfd.length;
  for (const ch of nfd) {
    if (IGNORABLE.test(ch)) continue;
    if (!/^\p{M}$/u.test(ch)) base = ch;
    else if (ch === COMBINING_DOT_ABOVE && HIDES_DOT(base)) continue;
    out += t.get(ch.codePointAt(0)!) ?? ch;
    // Past `cap` the caller compares nothing (#763 round 8): stop here, over it, rather than build the rest.
    if (out.length > cap) {
      normed += out.length;
      return out;
    }
  }
  return normalized(out, 'NFD');
}

/**
 * A full case fold, near enough for file names: upper then lower case, so the long s and the Kelvin sign fold to `s`
 * and `k` as a case-insensitive file system (macOS, Windows) may open them. A guess at those systems' own tables (not
 * measured); it only ever adds matches.
 */
const fold = (s: string): string => s.toUpperCase().toLowerCase();


/** Whether a string has a character outside ASCII. */
const nonAscii = (s: string): boolean => /\P{ASCII}/u.test(s);

/**
 * The compatibility form (NFKC): a fullwidth or mathematical letter as the plain one, which UTS #39's table leaves to
 * NFKC. Compared as well as the path itself: it only ever adds matches.
 */
const compat = (s: string): string => normalized(s, 'NFKC');

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
 * again (a character that reaches ASCII only in that order, #763 round 5). Case is folded both before the skeleton
 * (a long s reads as s only once folded) and after it (#763 round 7: a capital I reads as l only before it is
 * folded, so a Cyrillic letter beside a capital I for an l, `docs/R` + a Cyrillic e + `Ieasing.md`, folded first
 * reads as `reieasing`, while its skeleton folded reads as `releasing`).
 */
type Pass = 'fold' | 'skeleton' | 'compat';
/** Each form as its passes, in order (#763 round 8: a path's forms are made pass by pass, each charged and capped). */
const PASSES = {
  skeleton: ['skeleton'],
  caseless: ['fold', 'skeleton', 'fold'],
  'skeleton-fold': ['skeleton', 'fold'],
  'compat-skeleton': ['compat', 'skeleton'],
  'compat-caseless': ['compat', 'fold', 'skeleton', 'fold'],
  'compat-skeleton-fold': ['compat', 'skeleton', 'fold'],
  'skeleton-compat': ['skeleton', 'compat', 'skeleton'],
  'skeleton-compat-caseless': ['fold', 'skeleton', 'compat', 'skeleton', 'fold'],
  'skeleton-compat-fold': ['skeleton', 'compat', 'skeleton', 'fold'],
} as const satisfies Record<string, readonly Pass[]>;
type Form = keyof typeof PASSES;
function pass(p: Pass, s: string, cap = Infinity): string {
  if (p !== 'fold') return p === 'compat' ? compat(s) : skeleton(s, cap);
  const out = fold(s);
  normed += s.length + out.length + 2;
  return out;
}
/** Each form as one function, for a glob's literal runs (a glob is the owner's config, not the change's). */
const FORMS = Object.fromEntries(Object.entries(PASSES).map(([f, ps]) => [f, (s: string) => ps.reduce((x: string, p: Pass) => pass(p, x), s)])) as Record<Form, (s: string) => string>;

/**
 * A path's forms `kinds`, made pass by pass (#763 round 8): passes the forms share are made once (each form's prefix
 * of passes is remembered); `charge` is called with each pass's input length before it runs and its output length
 * after, and a true answer (the budget is overdrawn) stops it ('spent'); a pass whose output is over
 * MAX_CHECKED_SKELETON stops it too ('over', the skeleton stopping as soon as it gets there). The plain skeleton is
 * the first form, so a path whose skeleton is over the cap builds nothing else. Before round 8 every form was built in
 * full, each later one re-reading the grown string, and charged by the path's length only: an Arabic ligature the
 * skeleton turns into 18 characters made a computeLevel take 16 to 24 s (measured by the round-7 delta check).
 */
function pathForms(v: string, kinds: readonly Form[], charge: (n: number) => boolean): [Form, string][] | 'spent' | 'over' {
  const made = new Map<string, string>();
  const out: [Form, string][] = [];
  for (const f of kinds) {
    let s = v;
    let key = '';
    for (const p of PASSES[f]) {
      key += `/${p}`;
      let next = made.get(key);
      if (next === undefined) {
        // No pass once the budget is spent; each pass is charged what it read and made (normed), even when
        // normalized refuses it partway (round 10: such a pass was charged its input only, 7.5 to 11 ns a unit).
        if (charge(0)) return 'spent';
        const before = normed;
        try {
          next = pass(p, s, MAX_CHECKED_SKELETON);
        } finally {
          charge(normed - before);
        }
        if (charge(0)) return 'spent';
        if (next.length > MAX_CHECKED_SKELETON) return 'over';
        made.set(key, next);
      }
      s = next;
    }
    out.push([f, s]);
  }
  return out;
}
/** For a pure-ASCII path only the skeleton: its compatibility form is itself, and case counts only outside ASCII. */
const ASCII_FORMS: readonly Form[] = ['skeleton'];
const WIDE_FORMS: readonly Form[] = Object.keys(FORMS) as Form[];

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
 * A glob ready to match: each part's kind (LIT, ONE, STAR, ANY, DIRS) and literal code unit, and the literal text it
 * must start and end with (a cheap first test that skips the walk for most paths; it only ever rules out what the walk
 * would rule out too).
 */
type Compiled = { kinds: Uint8Array; lits: Uint16Array; prefix: string; suffix: string };
const LIT = 0;
const ONE = 1;
const STAR = 2;
const ANY = 3;
const SLASH = 47;
const KIND = { lit: LIT, one: ONE, star: STAR, any: ANY, dirs: 4 } as const;
function compiled(parts: GlobPart[]): Compiled {
  let a = 0;
  while (a < parts.length && parts[a]!.k === 'lit') a++;
  let b = parts.length;
  while (b > a && parts[b - 1]!.k === 'lit') b--;
  const text = (ps: GlobPart[]) => ps.map((p) => (p.k === 'lit' ? p.c : '')).join('');
  return {
    kinds: Uint8Array.from(parts, (p) => KIND[p.k]),
    lits: Uint16Array.from(parts, (p) => (p.k === 'lit' ? p.c.charCodeAt(0) : 0)),
    prefix: text(parts.slice(0, a)),
    suffix: text(parts.slice(b)),
  };
}

/** The walk's state rows, reused across calls (globMatch runs synchronously and never re-enters itself). */
let rows: Uint8Array[] = [];
/**
 * The work done so far, as lookalikeOf charges it (#763 round 7): parts visited by the walk (a character walked times
 * the glob's parts, plus one), comparisons made (globMatch calls and RegExp tests), and characters of a glob's forms
 * made (or of strings a RegExp read).
 */
let walked = 0;
let matched = 0;
let formed = 0;
/**
 * Whether `s` matches the glob, in linear time: a state-set walk over the parts (time is the string's length times
 * the parts', whatever the glob), never a backtracking RegExp, so no glob and no path makes it slow (#763 round 6: a
 * glob of four `**` took 25 s on a 1,000-character path as a RegExp). Same answers as globToRegExp. A part is
 * entered (at) or, for `**` followed by `/`, inside its directories; the kinds past ONE (STAR, ANY, DIRS) may match
 * nothing, so reaching one reaches the next part too.
 */
function globMatch(glob: Compiled, s: string): boolean {
  matched++;
  if (s.length < glob.prefix.length + glob.suffix.length || !s.startsWith(glob.prefix) || !s.endsWith(glob.suffix)) return false;
  const { kinds, lits } = glob;
  const m = kinds.length;
  if (!rows.length || rows[0]!.length < m + 1) rows = Array.from({ length: 4 }, () => new Uint8Array(m + 1));
  let [at, inside, next, nextInside] = rows as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  at.fill(0, 0, m + 1);
  inside.fill(0, 0, m + 1);
  at[0] = 1;
  for (let k = 0; k < m; k++) if (at[k] && kinds[k]! > ONE) at[k + 1] = 1;
  for (let i = 0; i < s.length; i++) {
    walked += m + 1;
    const ch = s.charCodeAt(i);
    next.fill(0, 0, m + 1);
    nextInside.fill(0, 0, m + 1);
    for (let k = 0; k < m; k++) {
      const here = at[k]!;
      const within = inside[k]!;
      if (!here && !within) continue;
      if (here) {
        const kind = kinds[k]!;
        if (kind === LIT) {
          if (ch === lits[k]) next[k + 1] = 1;
        } else if (kind === ONE) {
          if (ch !== SLASH) next[k + 1] = 1;
        } else if (kind === STAR) {
          if (ch !== SLASH) next[k] = 1;
        } else if (kind === ANY) next[k] = 1;
        else {
          nextInside[k] = 1;
          if (ch === SLASH) next[k + 1] = 1;
        }
      }
      if (within) {
        nextInside[k] = 1;
        if (ch === SLASH) next[k + 1] = 1;
      }
    }
    let live = next[m] === 1;
    for (let k = 0; k < m; k++) {
      if (next[k] && kinds[k]! > ONE) next[k + 1] = 1;
      if (next[k] || nextInside[k]) live = true;
    }
    if (!live) return false;
    [at, next] = [next, at];
    [inside, nextInside] = [nextInside, inside];
  }
  return at[m] === 1;
}

/** Whether `s` matches `glob`, as globToRegExp(glob).test(s) answers, in linear time (globMatch). */
export const globMatches = (glob: string, s: string): boolean => globMatch(compiled(globParts(glob)), s);

/**
 * The protected patterns of one call, made ready once (#763 round 7): each glob compiled as written and, on first
 * use, per form (a form's mapping, and that mapping read: r, n as m, so a glob's `?` stands for the one character m
 * is), never again for the next path; the refused line, if any; and the patterns' total width for the cost. Held by
 * the patterns array itself (a WeakMap), so computeLevel, which passes one array for every path of a change,
 * compiles each glob and form at most once, whatever the number of patterns.
 */
type Ready = {
  refused: { refused: string; what: string } | undefined;
  width: number;
  globs: { what: string; own: RegExp | undefined; raw: Compiled; glob: string; forms: Map<Form, readonly [Compiled, Compiled]> }[];
  res: { re: RegExp; what: string }[];
  /** Pattern order: a glob's or a RegExp's index in its list. */
  order: readonly (readonly ['glob' | 're', number])[];
};
const ready = new WeakMap<readonly Protected[], Ready>();
function readied(patterns: readonly Protected[]): Ready {
  let r = ready.get(patterns);
  if (r) return r;
  const out: Ready = { refused: undefined, width: 0, globs: [], res: [], order: [] };
  const order: (readonly ['glob' | 're', number])[] = [];
  for (const p of patterns) {
    if ('refused' in p) out.refused ??= p;
    else if ('glob' in p) {
      order.push(['glob', out.globs.length]);
      out.globs.push({ what: p.what, own: p.own, raw: compiled(globParts(p.glob)), glob: p.glob, forms: new Map() });
      out.width += p.glob.length + 1;
    } else {
      order.push(['re', out.res.length]);
      out.res.push(p);
      out.width += 1;
    }
  }
  out.order = order;
  ready.set(patterns, (r = out));
  return r;
}
/** A glob's compiled form `f`, as is and read, made once per glob and form. */
function formOf(g: Ready['globs'][number], f: Form): readonly [Compiled, Compiled] {
  let c = g.forms.get(f);
  if (!c) {
    formed += 2 * (g.glob.length + 1);
    const form = FORMS[f];
    try {
      c = [compiled(globParts(mapGlob(g.glob, form))), compiled(globParts(mapGlob(g.glob, (s) => reading(form(s)))))] as const;
    } catch (e) {
      // The protected glob's own text has the long run (the owner's config): say so, not that the path has it (the path
      // is still not compared). Its text isn't quoted: a reason shows it raw.
      if (e instanceof MarkRunOver) throw new Error(`a protected glob (${g.what}) has ${e.message}`);
      throw e;
    }
    g.forms.set(f, c);
  }
  return c;
}

/**
 * The work budget's units, each sized from this machine's measured time so that one unit is about a nanosecond or
 * more (#763 round 7, measured in the PR with scratchpad probes; a guess for other machines):
 * - PAIR_COST: one pattern compared with one string (the path, a form, or a form read), whatever their lengths: the
 *   call, the first test, the walk's set-up. Before round 7 a pair cost almost nothing, so short paths against many
 *   short globs spent about 12 s under the engine's own review.yaml (6,000 paths) and 81 s under a config of 400 globs
 *   before the budget ran out (measured by the round-6 review);
 * - WALK_COST: one part of a glob visited for one character of the string (about 4 to 6 ns measured);
 * - FORM_CHAR_COST: one character a pass of a path's form reads or makes (skeleton, fold, NFKC; round 8: the grown
 *   string, not the path's length), one character of a reading, or of a glob's form made.
 */
export const PAIR_COST = 50;
export const WALK_COST = 5;
export const FORM_CHAR_COST = 20;
/**
 * The least a path held for a run of marks is charged, per character of the path (#763 round 10): about what
 * comparing a path of that length costs (1,400 to 1,500 units a character for 1,000-character paths outside ASCII
 * under the engine's review.yaml, measured with the round-10 probes). So holding a path for its run is never cheaper
 * on the budget than comparing it, and the budget runs out after about as many such paths as compared ones (about
 * 1,300 of 1,020 characters at LOOKALIKE_BUDGET). Before round 10 a path refused partway through a pass was charged
 * that pass's input only: 90,000 of them added 31.6 s (measured by the round-9 delta check).
 */
export const RUN_HOLD_CHAR_COST = 1_500;

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
 * `budget`, when given, is the change's remaining work (LOOKALIKE_BUDGET): this path's work comes off it as it is
 * done, and a path reached, or being compared, once it is overdrawn isn't compared further and counts as a look-alike.
 * null: no look-alike. Fails closed (see the module's INVARIANT).
 */
export function lookalikeOf(path: string, patterns: readonly Protected[], budget?: { left: number }): Lookalike | null {
  if (path.length > MAX_CHECKED_PATH) return { unchecked: `longer than ${MAX_CHECKED_PATH} characters` };
  const spent = { unchecked: `this change's look-alike work budget (${LOOKALIKE_BUDGET} glob-matching steps) is spent` };
  // Each form once, pass by pass, and its reading once, each charged FORM_CHAR_COST a character of what it reads and
  // makes, as it is made (#763 rounds 7, 8 and 10). A pass over MAX_CHECKED_SKELETON stops it: not compared.
  const charge = (n: number): boolean => {
    if (!budget) return false;
    budget.left -= FORM_CHAR_COST * n;
    // Spent at 0 too (round 10): charge(0) is the check before any work.
    return budget.left <= 0;
  };
  // A path held for a run of marks: charged at least RUN_HOLD_CHAR_COST a character in all (round 10).
  const start = budget?.left ?? 0;
  const heldForRun = (why: string): Lookalike => {
    if (budget) budget.left = Math.min(budget.left, start - RUN_HOLD_CHAR_COST * (path.length + 1));
    return { unchecked: why };
  };
  try {
    const r = readied(patterns);
    if (r.refused) return { unchecked: r.refused.refused };
    // INVARIANT (#763 round 10): no work on a path once the budget is spent, and every read of the path below is
    // charged by its length before it is made (the run checks and the blank-free variant), so a path held for its run
    // costs the budget what it cost the machine.
    if (charge(0)) return spent;
    // Normalizing a run of combining marks sorts it, in time that grows faster than its length (#763 round 8). A run
    // longer than Unicode's stream-safe limit (UAX #15: 30) isn't compared: no name needs one. Here the path as
    // written; normalized checks every string the check normalizes too (round 9: a run that only forms once blanks
    // are taken out, or under NFKC).
    charge(path.length + 1);
    if (overMarkRun(path)) return heldForRun(`it has a run of more than ${MAX_MARK_RUN} combining marks`);
    const wide = nonAscii(path);
    charge(path.length + 1);
    const bare = withoutBlanks(path);
    const variants = bare === path ? [path] : [path, bare];
    // The blank-free variant's runs before any form is made (round 9): normalized would refuse it anyway, after the
    // path's own forms.
    if (bare !== path && (charge(bare.length + 1), overMarkRun(bare))) throw new MarkRunOver('without its blanks');
    const kinds = wide ? WIDE_FORMS : ASCII_FORMS;
    const over = { unchecked: `its skeleton is longer than ${MAX_CHECKED_SKELETON} characters` };
    const forms: (readonly [Form, string])[] = [];
    for (const v of variants) {
      const made = pathForms(v, kinds, charge);
      if (made === 'spent') return spent;
      if (made === 'over') return over;
      forms.push(...made);
    }
    const read: (readonly [Form, string, string])[] = [];
    for (const [f, s] of forms) {
      if (charge(2 * (s.length + 1))) return spent;
      read.push([f, s, reading(s)]);
    }
    const asciiReadings = r.res.length && (wide || bare !== path) ? variants.map((v) => asciiReading(v)) : [];
    // INVARIANT (#763 round 7): the work is charged as it is done, after each pattern: every comparison PAIR_COST
    // whatever its length, every character walked WALK_COST times the glob's parts, every character of a glob's form
    // made FORM_CHAR_COST. Once the budget is overdrawn, this path isn't compared further and counts as a look-alike
    // (fails closed), and every path after it too. So a change does at most the budget's work plus one pattern's.
    let marks = [walked, matched, formed];
    const overdrawn = (): boolean => {
      if (!budget) return false;
      budget.left -= WALK_COST * (walked - marks[0]!) + PAIR_COST * (matched - marks[1]!) + FORM_CHAR_COST * (formed - marks[2]!);
      marks = [walked, matched, formed];
      return budget.left < 0;
    };
    for (const [kind, i] of r.order) {
      if (kind === 'glob') {
        const g = r.globs[i]!;
        matched += g.own ? 1 : 0;
        if (g.own ? g.own.test(path) : globMatch(g.raw, path)) {
          if (overdrawn()) return spent;
          continue;
        }
        for (const [f, s, t] of read) {
          const [as, asRead] = formOf(g, f);
          if (globMatch(as, s) || globMatch(asRead, t)) {
            overdrawn();
            return { like: g.what };
          }
        }
      } else {
        const p = r.res[i]!;
        const strings = [path, ...forms.map(([, s]) => s), ...asciiReadings];
        matched += strings.length;
        formed += strings.reduce((n, x) => n + x.length, 0);
        if (p.re.test(path)) {
          if (overdrawn()) return spent;
          continue;
        }
        if (strings.slice(1).some((x) => p.re.test(x))) {
          overdrawn();
          return { like: p.what };
        }
      }
      if (overdrawn()) return spent;
    }
    return null;
  } catch (e) {
    if (e instanceof MarkRunOver) return heldForRun(`it has a run of more than ${MAX_MARK_RUN} combining marks once its blanks are taken out or it is normalized`);
    return { unchecked: `the check failed: ${(e as Error).message}` };
  }
}
