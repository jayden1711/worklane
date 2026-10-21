// Vacuous-test detection, for any Node test runner.
//  static:  a test file with no assertion calls (configured pattern) fails. An import or require of an assertion
//           module is not a call (countAssertionCalls).
//  dynamic: run the file under NODE_V8_COVERAGE; it must execute code inside the app's paths. Code that runs as the
//           module loads doesn't count: the module's own top level and V8's synthetic initializers (a class's static
//           fields). The merge gate also runs each test a second time with none of its tests run (a baseline: the
//           file and what it imports only load), and counts only code that ran more often in the real run, so a helper
//           a module calls as it loads (`const T = build()`, tsc's __decorate, esbuild's __name) counts for nothing even
//           when the PR adds the whole file; and only code on the lines the PR changes that hold code (codeSpans).
import { spawn, spawnSync } from './os/child-process.js';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp } from './guardrails/glob.js';
import { childEnv, readRegularFile, shellCommand } from './os/index.js';

/**
 * The test files of a repo whose tests.yaml has no vacuity section: one list for the coordinator's tamper guard and the
 * merge gate's no-section hold (src/merge-policy-vacuity.ts).
 */
export const FALLBACK_TEST_GLOBS: readonly string[] = ['test/**', '**/*.test.*'];

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Matches of `pattern` outside comments (the coordinator's tamper guard compares these before and after a change). */
export function countAssertions(src: string, pattern: string): number {
  return [...stripComments(src).matchAll(new RegExp(pattern, 'g'))].length;
}

/**
 * The lines that bring a module in (import ... from, a bare import, `x = require(...)`, `x = await import(...)`): the
 * name of an assertion module in them is no assertion (#784 round 4: `import assert from 'node:assert'` alone counted 2).
 */
const MODULE_LINES = [
  /^[ \t]*import\b[\s\S]*?\bfrom[ \t]*['"][^'"\n]*['"][ \t]*;?/gm,
  /^[ \t]*import[ \t]*['"][^'"\n]*['"][ \t]*;?/gm,
  /^[ \t]*(?:const|let|var)\b[^=\n]*=[ \t]*(?:await[ \t]+)?(?:require|import)[ \t]*\([ \t]*['"][^'"\n]*['"][ \t]*\)[^;\n]*;?/gm,
];

/** Assertion calls in a test: matches of `pattern` outside comments and outside the lines that import modules. */
export function countAssertionCalls(src: string, pattern: string): number {
  let text = stripComments(src);
  for (const re of MODULE_LINES) text = text.replace(re, '');
  return [...text.matchAll(new RegExp(pattern, 'g'))].length;
}

interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}
interface V8Coverage {
  result: { url: string; functions: { functionName: string; ranges: V8Range[] }[] }[];
}

/**
 * What a coverage directory may hold before the reader gives up: the files in it are written by the code under test
 * (it learns the directory from NODE_V8_COVERAGE), so they are hostile input (#784 rounds 2 and 4). `scripts`: script
 * entries over every file; `urlChars`: a longer script URL is never looked up.
 */
export const COVERAGE_LIMITS = { files: 256, fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, scripts: 20_000, urlChars: 4096 } as const;

/** The most of an app file or a built script the reader reads to place a changed line (larger: it counts for nothing). */
export const SCRIPT_BYTES = 8 * 1024 * 1024;

/**
 * Why a coverage directory couldn't be read. Its message is fixed text: never a file's content, a parser's message
 * (which quotes the content) or a name the test chose, since it goes into an event and a hold reason.
 */
export class CoverageUnreadable extends Error {}

const isRange = (r: unknown): r is V8Range => !!r && typeof r === 'object' && Number.isSafeInteger((r as V8Range).startOffset) && Number.isSafeInteger((r as V8Range).endOffset) && Number.isSafeInteger((r as V8Range).count);

function isCoverage(v: unknown): v is V8Coverage {
  const o = v as { result?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.result)) return false;
  return o.result.every((s: { url?: unknown; functions?: unknown } | null) => !!s && typeof s.url === 'string' && Array.isArray(s.functions) && (s.functions as { functionName?: unknown; ranges?: unknown }[]).every((fn) => !!fn && typeof fn.functionName === 'string' && Array.isArray(fn.ranges) && (fn.ranges as unknown[]).every(isRange)));
}

/**
 * Every coverage file in `dir`, read as hostile input: the directory itself, not a symlink to one; at most
 * COVERAGE_LIMITS.files `.json` entries, each a regular file (opened without following a symlink and without waiting
 * on a FIFO: os/index.ts readRegularFile), within the byte limits, and shaped as V8 coverage, with at most
 * COVERAGE_LIMITS.scripts script entries in all. Anything else throws CoverageUnreadable.
 */
function readCoverageDir(dir: string): V8Coverage[] {
  const fail = (why: string): never => {
    throw new CoverageUnreadable(`the coverage directory ${why}`);
  };
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch {
    return fail('is missing');
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fail('is not a plain directory');
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return fail("can't be listed");
  }
  if (names.length > COVERAGE_LIMITS.files) fail(`holds more than ${COVERAGE_LIMITS.files} coverage files`);
  let total = 0;
  let scripts = 0;
  const out: V8Coverage[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let s: ReturnType<typeof lstatSync>;
    try {
      s = lstatSync(file);
    } catch {
      return fail("holds an entry it can't read");
    }
    if (!s.isFile()) fail('holds an entry that is not a regular file');
    const size = s.size;
    if (size > COVERAGE_LIMITS.fileBytes) fail(`holds a file over ${COVERAGE_LIMITS.fileBytes} bytes`);
    total += size;
    if (total > COVERAGE_LIMITS.totalBytes) fail(`holds over ${COVERAGE_LIMITS.totalBytes} bytes`);
    // The size lstat saw is the most it reads: a file swapped or grown since is too big, and a FIFO or device not a file.
    const r = readRegularFile(file, size);
    if (r.kind !== 'file') return fail(r.kind === 'too-big' ? 'holds a file that grew while it was read' : `holds an entry that is not a regular file it can read (${r.kind})`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      return fail('holds a file that is not valid JSON');
    }
    if (!isCoverage(parsed)) fail('holds a file that is not V8 coverage');
    scripts += (parsed as V8Coverage).result.length;
    if (scripts > COVERAGE_LIMITS.scripts) fail(`names more than ${COVERAGE_LIMITS.scripts} scripts`);
    out.push(parsed as V8Coverage);
  }
  return out;
}

/**
 * What the source maps of a coverage run may add up to (they are the build's: hostile too). Past maps or bytes, a map
 * maps nothing; past `sources` (every source every map names, real or not), the whole read fails closed
 * (CoverageUnreadable), so the work it does and what it returns stay small whatever the maps say (#784 round 3).
 */
export const SOURCE_MAP_LIMITS = { maps: 1024, mapBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, sources: 5000 } as const;

const under = (p: string, base: string) => {
  const rel = relative(base, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** A regular file's text, read as hostile input (no link, no FIFO, at most `max` bytes), or null. */
function textOf(file: string, max: number): string | null {
  try {
    const s = lstatSync(file);
    if (!s.isFile() || s.size > max) return null;
    const r = readRegularFile(file, s.size);
    return r.kind === 'file' ? r.text : null;
  } catch {
    return null;
  }
}

/** The offset (UTF-16 code units, as V8's) where each line starts, 0-based lines; one more for the end. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  out.push(text.length);
  return out;
}

/** A run count over [start, end) offsets of a script. */
type Segment = [number, number, number];

/**
 * How many times each part of a script's code ran, as [start, end, count] offsets with count > 0. One sweep over the
 * ranges of every function of the script but two kinds: each span takes the count of the innermost range around it, so
 * a block that didn't run, or a nested function never called, is not run code even inside a function that ran. Left
 * out: the module's own top level (the unnamed function at offset 0, which is what loading runs) and V8's synthetic
 * initializers (`<static_initializer>` and the like). The top level must span exactly the script's text, or that text
 * and the one suffix Node's own TypeScript type stripping adds (`\n\n//# sourceURL=<the script's URL>`: the stripped
 * text keeps every offset). Null otherwise (it ran other text: a loader transformed it), so it counts for nothing.
 */
function ranSegments(fns: V8Coverage['result'][number]['functions'], length: number, url: string): Segment[] | null {
  const top = fns.find((f) => f.functionName === '' && f.ranges[0]?.startOffset === 0);
  const end = top?.ranges[0]!.endOffset;
  if (end !== length && end !== length + `\n\n//# sourceURL=${url}`.length) return null;
  const rs = fns
    .filter((f) => f !== top && !f.functionName.startsWith('<'))
    .flatMap((f) => f.ranges)
    .filter((r) => r.startOffset < r.endOffset)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const cuts = [...new Set(rs.flatMap((r) => [r.startOffset, r.endOffset]))].sort((a, b) => a - b);
  const out: Segment[] = [];
  const stack: V8Range[] = [];
  let j = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i]!, Math.min(cuts[i + 1]!, length)];
    if (a >= b) break;
    while (stack.length && stack.at(-1)!.endOffset <= a) stack.pop();
    while (j < rs.length && rs[j]!.startOffset <= a) {
      while (stack.length && stack.at(-1)!.endOffset <= a) stack.pop();
      if (rs[j]!.endOffset > a) stack.push(rs[j]!);
      j++;
    }
    const inner = stack.at(-1);
    if (!inner || inner.count <= 0) continue;
    const last = out.at(-1);
    if (last && last[1] === a && last[2] === inner.count) last[1] = b;
    else out.push([a, b, inner.count]);
  }
  return out;
}

/**
 * Where code ran more times in the test runs (`ran`: every process's segments of one script) than in the baseline runs
 * (`baseline`: the same tests loaded with none of them run), as sorted [start, end) offsets. What loading the test file
 * and the modules it imports runs, a helper the app file calls as it loads included, runs as often in both, so only
 * what the tests' own bodies ran is left (#784 round 5).
 */
function ranMore(ran: Segment[], baseline: Segment[]): [number, number][] {
  const events = [...ran.flatMap(([a, b, c]) => [[a, c], [b, -c]] as const), ...baseline.flatMap(([a, b, c]) => [[a, -c], [b, c]] as const)].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let sum = 0;
  for (let i = 0; i < events.length; i++) {
    sum += events[i]![1];
    const a = events[i]![0];
    const b = events[i + 1]?.[0];
    if (b === undefined || a === b || sum <= 0) continue;
    const last = out.at(-1);
    if (last && last[1] === a) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

const overlaps = (ranges: [number, number][], a: number, b: number) => ranges.some(([s, e]) => s < b && a < e);

/** The changed lines of a file, 1-based inclusive spans (null: every line counts). */
export type LineSpans = [number, number][];

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Which lines of a JavaScript or TypeScript text hold code (`code[i]`, line i 0-based): a character outside a comment,
 * a string's or a template's text included (a blank line inside a template is its text too). `inComment[i]`: line i
 * ends inside a block comment. A lexer, not a parser: a `/` after a value (a name, a number, `)`, `]`, a string's end)
 * divides, and anywhere else, or after a keyword such as `return`, starts a regular expression; a `#!` first line is a
 * comment. Where it guesses wrong (JSX text with `//` in it), a line reads as a comment: it counts for less, never more.
 */
export function codeLines(text: string): { code: boolean[]; inComment: boolean[] } {
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 're' | 'class';
  const code: boolean[] = [false];
  const inComment: boolean[] = [];
  let s: State = text.startsWith('#!') ? 'line' : 'code';
  // For each `${` open: how many `{` its expression has open.
  const braces: number[] = [];
  let prev = '';
  let word = '';
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') {
      inComment[line] = s === 'block';
      line++;
      // A string or a regular expression ends at a line's end unless a `\` continued it (handled below).
      if (s === 'line' || s === 're' || s === 'class' || s === 'sq' || s === 'dq') s = 'code';
      code[line] = s === 'tpl';
      continue;
    }
    // `\` then a line break: the string or template goes on to the next line.
    const escapes = () => {
      if (text[i + 1] !== '\n') i++;
      else {
        inComment[line] = false;
        line++;
        code[line] = true;
        i++;
      }
    };
    if (s === 'line') continue;
    if (s === 'block') {
      if (c === '*' && text[i + 1] === '/') {
        s = 'code';
        i++;
      }
      continue;
    }
    if (s !== 'code') {
      code[line] = true;
      if (c === '\\') escapes();
      else if (s === 'sq' && c === "'") [s, prev] = ['code', 'a'];
      else if (s === 'dq' && c === '"') [s, prev] = ['code', 'a'];
      else if (s === 'tpl' && c === '`') [s, prev] = ['code', 'a'];
      else if (s === 'tpl' && c === '$' && text[i + 1] === '{') {
        braces.push(0);
        [s, prev] = ['code', '('];
        i++;
      } else if (s === 're' && c === '[') s = 'class';
      else if (s === 'class' && c === ']') s = 're';
      else if (s === 're' && c === '/') [s, prev] = ['code', 'a'];
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') continue;
    if (c === '/' && text[i + 1] === '/') {
      s = 'line';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      s = 'block';
      i++;
      continue;
    }
    code[line] = true;
    if (/[A-Za-z0-9_$]/.test(c)) {
      word = /[A-Za-z0-9_$]/.test(prev === 'a' ? (text[i - 1] ?? '') : '') ? word + c : c;
      prev = 'a';
      continue;
    }
    const after = prev === 'a' && !KEYWORDS_BEFORE_REGEX.has(word) ? 'value' : prev === ')' || prev === ']' ? 'value' : 'operator';
    word = '';
    if (c === '/') {
      if (after === 'operator') s = 're';
      prev = '/';
    } else if (c === "'") s = 'sq';
    else if (c === '"') s = 'dq';
    else if (c === '`') s = 'tpl';
    else if (c === '{') {
      if (braces.length) braces[braces.length - 1]!++;
      prev = '{';
    } else if (c === '}') {
      if (braces.length && braces.at(-1) === 0) {
        braces.pop();
        s = 'tpl';
      } else if (braces.length) braces[braces.length - 1]!--;
      prev = '}';
    } else prev = c;
  }
  inComment[line] = s === 'block';
  return { code: code.map(Boolean), inComment };
}

/**
 * One changed file's hunks as the merge gate hands them to the reader (from change-files.ts changedLineNumbers): `at`,
 * the head line the removed lines followed; `added`, the head lines added; `removedCode`, whether the removed text held
 * code (codeLines).
 */
export interface ChangedHunkSpots {
  at: number;
  added: number[];
  removedCode: boolean;
}

/**
 * The lines of a changed file (its head text) a test must run code on (#784 round 5): each added line that holds code
 * (codeLines: a blank, whitespace-only or comment line is no change to measure); and, for a hunk that removed code and
 * added none, the nearest code line on either side of where it was, unless that spot is inside a block comment. Empty:
 * nothing to measure in this file.
 */
export function codeSpans(text: string, hunks: readonly ChangedHunkSpots[]): LineSpans {
  const { code, inComment } = codeLines(text);
  const n = code.length;
  const has = (l: number) => l >= 1 && l <= n && code[l - 1] === true;
  // The nearest code line at or above each line, and at or below it (0: none).
  const up = new Array<number>(n + 2).fill(0);
  const down = new Array<number>(n + 2).fill(0);
  for (let l = 1; l <= n; l++) up[l] = has(l) ? l : up[l - 1]!;
  for (let l = n; l >= 1; l--) down[l] = has(l) ? l : down[l + 1]!;
  const out: LineSpans = [];
  for (const h of hunks) {
    const added = h.added.filter(has);
    for (const l of added) out.push([l, l]);
    if (added.length || !h.removedCode) continue;
    if (h.at >= 1 && h.at <= n && inComment[h.at - 1]) continue;
    const a = h.at >= 1 ? up[Math.min(h.at, n)]! : 0;
    const b = h.at + 1 <= n ? down[Math.max(1, h.at + 1)]! : 0;
    if (a) out.push([a, a]);
    if (b) out.push([b, b]);
  }
  return out;
}

/** Whether any of `spans` (1-based lines of `text`) holds code that ran (`ranges`). */
function ranOn(ranges: [number, number][], starts: number[], spans: LineSpans | null): boolean {
  if (!spans) return ranges.length > 0;
  const lines = starts.length - 1;
  return spans.some(([l1, l2]) => {
    const a = starts[Math.max(1, l1) - 1];
    const b = starts[Math.min(lines, l2)];
    return a !== undefined && b !== undefined && a < b && overlaps(ranges, a, b);
  });
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A source map's `mappings`, decoded: each segment's generated line and column, and its source and original line. */
function decodeMappings(mappings: string): { line: number; col: number; src: number; orig: number }[] | null {
  const out: { line: number; col: number; src: number; orig: number }[] = [];
  let line = 0;
  let src = 0;
  let orig = 0;
  let origCol = 0;
  let name = 0;
  for (const lineText of mappings.split(';')) {
    let col = 0;
    for (const seg of lineText.split(',')) {
      if (!seg) continue;
      const v: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        if (d < 0) return null;
        value += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          v.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
        if (shift > 30) return null;
      }
      if (!v.length) return null;
      col += v[0]!;
      if (v.length >= 4) {
        src += v[1]!;
        orig += v[2]!;
        origCol += v[3]!;
        if (v.length >= 5) name += v[4]!;
        out.push({ line, col, src, orig });
      }
    }
    line++;
  }
  return out;
}

/**
 * For a built script outside the app paths (dist/): the original lines whose generated code ran, by source file
 * (repo-relative, under `realRoot`), through the `<file>.map` beside it: each executed span of the script maps to the
 * source and line of the mapping segment that covers it (#784 round 4: a bundle's map names several sources; only the
 * ones whose code ran count, and only on those lines). The map and the script are read as hostile input (textOf), within
 * the byte limits (`budget`, shared by every map of the run). A map it can't read or decode maps nothing.
 */
function mappedLines(file: string, ranges: [number, number][], scriptText: string, realRoot: string, budget: { maps: number; bytes: number; sources: number }): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const map = `${file}.map`;
  let size: number;
  try {
    const s = lstatSync(map);
    if (!s.isFile()) return out;
    size = s.size;
  } catch {
    return out;
  }
  if (size > SOURCE_MAP_LIMITS.mapBytes || budget.maps >= SOURCE_MAP_LIMITS.maps || budget.bytes + size > SOURCE_MAP_LIMITS.totalBytes) return out;
  budget.maps++;
  budget.bytes += size;
  const text = textOf(map, SOURCE_MAP_LIMITS.mapBytes);
  if (text === null) return out;
  let m: { sources?: unknown; sourceRoot?: unknown; mappings?: unknown };
  try {
    m = JSON.parse(text) as typeof m;
  } catch {
    return out;
  }
  if (!m || typeof m !== 'object' || !Array.isArray(m.sources) || typeof m.mappings !== 'string') return out;
  budget.sources += m.sources.length;
  if (budget.sources > SOURCE_MAP_LIMITS.sources) throw new CoverageUnreadable(`the coverage directory's source maps name more than ${SOURCE_MAP_LIMITS.sources} source files`);
  const base = resolve(dirname(map), typeof m.sourceRoot === 'string' ? m.sourceRoot : '');
  const names = m.sources.map((s) => {
    if (typeof s !== 'string' || s.startsWith('webpack:') || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
    const p = resolve(base, s);
    return under(p, realRoot) ? relative(realRoot, p).split('\\').join('/') : null;
  });
  const segs = decodeMappings(m.mappings);
  if (!segs) return out;
  const starts = lineStarts(scriptText);
  // Each segment covers its generated offset up to the next segment's.
  const at = segs.map((s) => (starts[s.line] ?? Infinity) + s.col).map((o, i) => [o, segs[i]!] as const).filter(([o]) => Number.isFinite(o)).sort((x, y) => x[0] - y[0]);
  for (let i = 0; i < at.length; i++) {
    const [a, s] = at[i]!;
    const b = i + 1 < at.length ? at[i + 1]![0] : scriptText.length;
    const src = names[s.src];
    if (!src || !(a < b) || !overlaps(ranges, a, b)) continue;
    if (!out.has(src)) out.set(src, new Set());
    out.get(src)!.add(s.orig + 1);
  }
  return out;
}

/**
 * Why the merge gate has nothing to measure (fixed text): every line its app files change is blank, whitespace or a
 * comment, or the change only renames them. It holds the PR (#784 round 5: fail closed, never a pass).
 */
export const NOTHING_TO_MEASURE = 'nothing to measure: its changes to app code are only blank lines, whitespace, comments or renames, so no changed line holds code a test can run';

/**
 * App files whose code ran in a coverage run, under the rules of ranSegments (not the module's top level, not V8's
 * synthetic initializers). With `baselineDir` (the same tests loaded with none of them run), only code that ran more
 * often than there counts (ranMore). With `hunks`, only on the lines of each changed file that hold code (codeSpans: the
 * merge gate's call; it never records a file the PR doesn't change, and throws NOTHING_TO_MEASURE as CoverageUnreadable
 * when no changed line holds code); without, on any line. A built script outside the app paths (dist/) counts for the
 * source lines its source map names (mappedLines). The coverage directories, the scripts, the sources and the maps are
 * read as hostile input (readCoverageDir throws CoverageUnreadable); only script paths under `root`, of at most
 * COVERAGE_LIMITS.urlChars characters, are resolved on disk (realpathSync.native). Synchronous: the merge gate runs it in
 * a process of its own, with a time limit (readTouchedInChild).
 */
export function touchedAppFiles(coverageDir: string, root: string, appPaths: string[], only?: readonly string[], hunks?: Readonly<Record<string, readonly ChangedHunkSpots[]>>, baselineDir?: string): string[] {
  const res = appPaths.map((g) => globToRegExp(g));
  const realRoot = realpathSync.native(root);
  const wanted = hunks ? new Set(Object.keys(hunks)) : only ? new Set(only) : null;
  if (hunks && only) for (const f of [...wanted!]) if (!only.includes(f)) wanted!.delete(f);
  const isApp = (rel: string) => !rel.startsWith('..') && res.some((re) => re.test(rel)) && (!wanted || wanted.has(rel));
  // Each changed file's lines with code, from its text at the head (the worktree's).
  const spans = new Map<string, LineSpans>();
  if (hunks) {
    for (const f of wanted!) {
      const text = textOf(join(realRoot, f), SCRIPT_BYTES);
      spans.set(f, text === null ? [] : codeSpans(text, hunks[f]!));
    }
    if (![...spans.values()].some((s) => s.length)) throw new CoverageUnreadable(NOTHING_TO_MEASURE);
  }
  const spansOf = (rel: string): LineSpans | null => (hunks ? (spans.get(rel) ?? []) : null);
  // Every process's segments of each script under the root, test runs and baseline runs apart.
  const scripts = new Map<string, { rel: string; text: string; ran: Segment[]; baseline: Segment[] }>();
  const collect = (dir: string, into: 'ran' | 'baseline') => {
    for (const cov of readCoverageDir(dir)) {
      for (const script of cov.result) {
        if (!script.url.startsWith('file:') || script.url.length > COVERAGE_LIMITS.urlChars) continue;
        let file: string;
        try {
          const named = resolve(fileURLToPath(script.url));
          // A path the test named outside the worktree is never looked up (a FUSE mount, a device): only one under it.
          if (!under(named, realRoot) && !under(named, resolve(root))) continue;
          file = realpathSync.native(named);
        } catch {
          continue;
        }
        if (!under(file, realRoot)) continue;
        let s = scripts.get(file);
        // The baseline only takes away from scripts the tests ran.
        if (!s && into === 'baseline') continue;
        if (!s) {
          const text = textOf(file, SCRIPT_BYTES);
          if (text === null) continue;
          s = { rel: relative(realRoot, file).split('\\').join('/'), text, ran: [], baseline: [] };
          scripts.set(file, s);
        }
        const segs = ranSegments(script.functions, s.text.length, script.url);
        if (segs) s[into].push(...segs);
      }
    }
  };
  collect(coverageDir, 'ran');
  if (baselineDir !== undefined) collect(baselineDir, 'baseline');
  const budget = { maps: 0, bytes: 0, sources: 0 };
  const touched = new Set<string>();
  const mappedRan = new Map<string, Set<number>>();
  for (const [file, { rel, text, ran, baseline }] of scripts) {
    const ranges = ranMore(ran, baseline);
    if (!ranges.length) continue;
    if (isApp(rel)) {
      if (ranOn(ranges, lineStarts(text), spansOf(rel))) touched.add(rel);
      continue;
    }
    for (const [src, lines] of mappedLines(file, ranges, text, realRoot, budget)) {
      if (!mappedRan.has(src)) mappedRan.set(src, new Set());
      for (const l of lines) mappedRan.get(src)!.add(l);
    }
  }
  for (const [src, ran] of mappedRan) {
    if (!isApp(src) || touched.has(src)) continue;
    const s = spansOf(src);
    if (!s ? ran.size > 0 : s.some(([a, b]) => [...ran].some((l) => l >= a && l <= b))) touched.add(src);
  }
  return [...touched].sort();
}

/** What the merge gate asks the reader process: touchedAppFiles's arguments. */
export interface TouchedRequest {
  coverageDir: string;
  baselineDir: string;
  root: string;
  appPaths: string[];
  only: string[];
  hunks: Record<string, ChangedHunkSpots[]>;
}

/** How long the reader process may take before the read counts as failed (the PR waits). */
export const COVERAGE_READ_TIMEOUT_MS = 120_000;

/**
 * touchedAppFiles in a process of its own (src/vacuity-read.ts), so no coverage directory, however it is built, holds
 * the coordinator's thread: past `timeoutMs` it is killed and the read fails (fixed text), as does any answer that
 * isn't the reader's. The request goes in on stdin, the answer comes back on stdout (at most 1 MiB). `signal` (the
 * coordinator's shutdown) kills it too.
 */
export function readTouchedInChild(req: TouchedRequest, timeoutMs = COVERAGE_READ_TIMEOUT_MS, signal?: AbortSignal): Promise<{ touched: string[] } | { error: string }> {
  const reader = fileURLToPath(new URL('./vacuity-read.js', import.meta.url));
  return new Promise((done) => {
    let out = '';
    let settled = false;
    const finish = (r: { touched: string[] } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      done(r);
    };
    const child = spawn(process.execPath, [reader], { stdio: ['pipe', 'pipe', 'ignore'] });
    const stop = () => {
      child.kill('SIGKILL');
      finish({ error: 'the coverage read was stopped (the coordinator is shutting down)' });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ error: `the coverage directory took longer than ${Math.round(timeoutMs / 1000)} s to read` });
    }, timeoutMs);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      out += d;
      if (out.length > 1024 * 1024) {
        child.kill('SIGKILL');
        finish({ error: 'the coverage read answered more than it may' });
      }
    });
    child.on('error', () => finish({ error: 'the coverage read could not start' }));
    child.on('close', () => {
      try {
        const a = JSON.parse(out) as { touched?: unknown; error?: unknown };
        if (typeof a.error === 'string') return finish({ error: a.error });
        if (Array.isArray(a.touched) && a.touched.every((t) => typeof t === 'string' && req.only.includes(t))) return finish({ touched: a.touched as string[] });
      } catch {
        // below
      }
      finish({ error: 'the coverage read failed' });
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(JSON.stringify(req));
  });
}

export interface VacuityReport {
  file: string;
  assertions: number;
  touched?: string[];
  ran?: { exitCode: number | null; error?: string };
  vacuous: boolean;
  why: string[];
}

export function checkVacuity(
  root: string,
  file: string,
  opts: { assertionPattern: string; appPaths: string[]; dynamic: boolean; runOne?: string | undefined },
): VacuityReport {
  const why: string[] = [];
  const assertions = countAssertionCalls(readFileSync(join(root, file), 'utf8'), opts.assertionPattern);
  if (assertions === 0) why.push(`no assertion calls matching /${opts.assertionPattern}/`);
  const report: VacuityReport = { file, assertions, vacuous: false, why };
  if (opts.dynamic) {
    if (!opts.runOne) {
      why.push('dynamic check needs tests.yaml runner.one');
    } else {
      const cov = mkdtempSync(join(tmpdir(), 'v8cov-'));
      try {
        const [shFile, shArgs] = shellCommand(opts.runOne.replaceAll('{file}', file));
        const r = spawnSync(shFile, shArgs, {
          cwd: root,
          encoding: 'utf8',
          env: childEnv({ NODE_V8_COVERAGE: cov }),
          timeout: 600_000,
        });
        report.ran = r.error ? { exitCode: r.status, error: r.error.message } : { exitCode: r.status };
        let unreadable: string | null = null;
        try {
          report.touched = touchedAppFiles(cov, root, opts.appPaths);
        } catch (e) {
          if (!(e instanceof CoverageUnreadable)) throw e;
          report.touched = [];
          unreadable = e.message;
        }
        if (r.error) why.push(`could not run: ${r.error.message}`);
        else if (unreadable) why.push(unreadable);
        else if (!report.touched.length) why.push(`executed no function under ${opts.appPaths.join(', ')}`);
      } finally {
        rmSync(cov, { recursive: true, force: true });
      }
    }
  }
  report.vacuous = why.length > 0;
  return report;
}
