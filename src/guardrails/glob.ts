/**
 * The engine's one glob compiler, for repo-relative paths: **, *, ?, and trailing "/" meaning "everything under".
 * `**` matches any characters, a newline among them (the `s` flag): git reads a path with a newline as itself, so
 * `.claude/skills/a<newline>b/SKILL.md` is under `.claude/**` like any other (#683).
 *
 * `?` has two readings (#966): one UTF-16 unit, as before #966, and one character, so `keys/?.pem` also matches a
 * one-emoji name (a character outside the BMP is two units). Which one a caller gets depends on what a match does
 * there, and every matcher says so (GlobStyle). A glob with no `?` reads the same either way.
 */

/**
 * - `deny`: a match refuses, protects, holds or marks a path (refuse_paths, a secret, a money path, a category that
 *   raises a level). It matches when either reading does, so it never matches less than before #966.
 * - `allow`: a match exempts, permits or lowers (a `!` exception, an editable list, docs-only, a size skip). It
 *   matches only when both readings do, so it never matches more than before #966.
 */
export type GlobStyle = 'deny' | 'allow';

type Reading = 'unit' | 'point';
/** One part of a glob: a character, any one but "/", any run but "/", any run, or an optional "anything/". */
type Part = { k: 'char'; c: string } | { k: 'one' } | { k: 'star' } | { k: 'any' } | { k: 'dirs' };

const HIGH = '[\\uD800-\\uDBFF]';
const LOW = '[\\uDC00-\\uDFFF]';
/** One character but "/", in a pattern without the u flag: a surrogate pair, a lone surrogate or any other unit. */
const ONE_POINT = `(?:${HIGH}${LOW}|${HIGH}(?!${LOW})|(?<!${HIGH})${LOW}|[^/\\uD800-\\uDFFF])`;

/** The glob's parts, its characters read as UTF-16 units or as code points (a lone surrogate is one). */
function parse(glob: string, reading: Reading): Part[] {
  let text = glob.replace(/^\.\//, '');
  if (text.endsWith('/')) text += '**';
  const g = reading === 'unit' ? text.split('') : [...text];
  const out: Part[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          out.push({ k: 'dirs' });
        } else out.push({ k: 'any' });
      } else out.push({ k: 'star' });
    } else if (c === '?') out.push({ k: 'one' });
    else out.push({ k: 'char', c });
  }
  return out;
}

/** A literal character as a pattern without the u flag that matches it as the reading does. */
function literal(c: string, reading: Reading): string {
  const re = c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  if (reading === 'unit' || c.length !== 1) return re;
  const u = c.charCodeAt(0);
  // A lone surrogate is a character of its own: never half of a pair in the path.
  if (u >= 0xd800 && u <= 0xdbff) return `${re}(?!${LOW})`;
  if (u >= 0xdc00 && u <= 0xdfff) return `(?<!${HIGH})${re}`;
  return re;
}

/** The glob's pattern body (no anchors), without the u flag; the point reading matches as the u flag would. */
function body(glob: string, reading: Reading): string {
  return parse(glob, reading)
    .map((p) => (p.k === 'char' ? literal(p.c, reading) : p.k === 'one' ? (reading === 'unit' ? '[^/]' : ONE_POINT) : p.k === 'star' ? '[^/]*' : p.k === 'any' ? '.*' : '(?:.*/)?'))
    .join('');
}

/**
 * The glob as a RegExp, read as `style` says. A glob both readings read alike compiles exactly as before #966; the
 * pattern is always `^...$`, so its source without the first and last character is a pattern of its own.
 */
export function globRegExp(glob: string, style: GlobStyle): RegExp {
  const unit = body(glob, 'unit');
  const point = body(glob, 'point');
  if (unit === point) return new RegExp(`^${unit}$`, 's');
  return new RegExp(style === 'deny' ? `^(?:${unit}|${point})$` : `^(?=(?:${unit})$)(?:${point})$`, 's');
}

/**
 * The glob as every version before #966 read it: `?` one UTF-16 unit. Only for code that must count what an earlier
 * version counted (review.ts's earlier money readings), and for files not yet moved to globRegExp (a test lists them):
 * a new matcher picks a style.
 */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${body(glob, 'unit')}$`, 's');
}

/** Steps of a linear matcher: a part, with "anything/" as a jump over an `any` and a "/". */
type Step = { k: 'char'; c: string } | { k: 'one' } | { k: 'star' } | { k: 'any' } | { k: 'skip'; to: number };

/**
 * One reading of a glob, matched in linear time: every state of the pattern is tracked at once (a Thompson
 * automaton), never backtracked.
 */
function automaton(glob: string, reading: Reading): (text: string) => boolean {
  const steps: Step[] = [];
  for (const p of parse(glob, reading)) {
    if (p.k === 'dirs') {
      const at = steps.length;
      steps.push({ k: 'skip', to: at + 3 }, { k: 'any' }, { k: 'char', c: '/' });
    } else steps.push(p);
  }
  const end = steps.length;
  /** `from` and every state reachable from it without reading a character. */
  const close = (from: number[], into: Uint8Array) => {
    const todo = [...from];
    while (todo.length) {
      const s = todo.pop()!;
      if (into[s]) continue;
      into[s] = 1;
      if (s === end) continue;
      const st = steps[s]!;
      if (st.k === 'star' || st.k === 'any') todo.push(s + 1);
      else if (st.k === 'skip') todo.push(s + 1, st.to);
    }
  };
  return (text) => {
    let cur = new Uint8Array(end + 1);
    close([0], cur);
    for (const c of reading === 'unit' ? text.split('') : text) {
      const next: number[] = [];
      for (let s = 0; s < end; s++) {
        if (!cur[s]) continue;
        const st = steps[s]!;
        if (st.k === 'char') {
          if (c === st.c) next.push(s + 1);
        } else if (st.k === 'one') {
          if (c !== '/') next.push(s + 1);
        } else if (st.k === 'star') {
          if (c !== '/') next.push(s);
        } else if (st.k === 'any') next.push(s);
      }
      if (!next.length) return false;
      cur = new Uint8Array(end + 1);
      close(next, cur);
    }
    return cur[end] === 1;
  };
}

/**
 * The glob as globRegExp(glob, style) reads it, matched in linear time.
 * WHY: some patterns come from a config an agent can write, and as a backtracking regex "*a*a…*a*b" against a long
 * name took 13 s at 10 pairs and over a minute at 12 (measured, #890 round 7).
 */
export function globMatcher(glob: string, style: GlobStyle): { test: (s: string) => boolean } {
  const unit = automaton(glob, 'unit');
  if (body(glob, 'unit') === body(glob, 'point')) return { test: unit };
  const point = automaton(glob, 'point');
  return { test: style === 'deny' ? (s) => unit(s) || point(s) : (s) => unit(s) && point(s) };
}
