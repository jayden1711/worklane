// Vacuous-test detection, for any Node test runner.
//  static:  a test file with no assertion calls (configured pattern) fails. An import or require of an assertion
//           module is not a call (countAssertionCalls).
//  dynamic: run the file under NODE_V8_COVERAGE; it must execute code inside the app's paths. Code that runs as the
//           module loads doesn't count: the module's own top level and V8's synthetic initializers (a class's static
//           fields). The merge gate also runs each test a second time with none of its tests run (a baseline: the
//           file and what it imports only load), and loads on its own every script the tests evaluated more often than
//           that (a dynamic import in a test's body, a copy with a query string, what such a module imports), taking
//           its coverage away as many times as the extra evaluations (round 7). Only code that ran more often than all
//           that counts, so a helper a module calls as it loads (`const T = build()`, tsc's __decorate, esbuild's
//           __name) counts for nothing even when the PR adds the whole file or a test's body imports it, once or many
//           times, directly or through another module; and only code on the characters the PR changes that are code
//           (codeRanges, round 8: by V8's block ranges, so an untaken branch on a changed line doesn't count; a build's
//           sources by line). Not seen: work a module starts as it loads that keeps running and that the tests' own
//           activity triggers (a timer while a test waits, an async_hooks or exit listener), and code after a call
//           that threw (V8 counts a block as run once entered).
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
 * `src` without comments, in one pass (#784 round 8: stripComments's lazy `/*` match is quadratic on many unclosed
 * openers, 13.5 s at 512 KiB on the coordinator's thread). A `//` after `:` or `\` starts none, as there; a `/*` with no
 * end takes the rest of the text with it (so less is counted, never more).
 */
function withoutComments(src: string): string {
  const out: string[] = [];
  let from = 0;
  let i = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c !== 47 /* / */) {
      i++;
      continue;
    }
    const next = src.charCodeAt(i + 1);
    if (next === 42 /* * */) {
      out.push(src.slice(from, i));
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return out.join('');
      i = from = end + 2;
    } else if (next === 47 && !(i > 0 && (src[i - 1] === ':' || src[i - 1] === '\\'))) {
      out.push(src.slice(from, i));
      const end = src.indexOf('\n', i);
      if (end < 0) return out.join('');
      i = from = end;
    } else i++;
  }
  out.push(src.slice(from));
  return out.join('');
}

/** How many lines an `import` may span to its `from '…'` (a longer one: only its first line is taken out). */
const IMPORT_SPAN = 200;
const IMPORT_START = /^[ \t]*import\b/;
const FROM_SPECIFIER = /\bfrom[ \t]*['"][^'"\n]*['"][ \t]*;?/;
const BARE_IMPORT = /^[ \t]*import[ \t]*['"][^'"\n]*['"][ \t]*;?/;
const REQUIRE_LINE = /^[ \t]*(?:const|let|var)\b[^=\n]*=[ \t]*(?:await[ \t]+)?(?:require|import)[ \t]*\([ \t]*['"][^'"\n]*['"][ \t]*\)[^;\n]*;?/;

/**
 * Assertion calls in a test: matches of `pattern` outside comments and outside the lines that bring a module in
 * (`import … from '…'`, over up to IMPORT_SPAN lines; a bare import; `x = require(…)`, `x = await import(…)`): the name
 * of an assertion module in them is no assertion (#784 round 4: `import assert from 'node:assert'` alone counted 2).
 * Linear in the text (round 8), line by line, the next `from '…'` line found once for every line.
 */
export function countAssertionCalls(src: string, pattern: string): number {
  const lines = withoutComments(src).split('\n');
  // For each line, the first line at or after it that names a module after `from`.
  const nextFrom = new Array<number>(lines.length + 1).fill(Infinity);
  for (let k = lines.length - 1; k >= 0; k--) nextFrom[k] = FROM_SPECIFIER.test(lines[k]!) ? k : nextFrom[k + 1]!;
  const kept: string[] = [];
  // What follows a statement on its line stays (a call after `import … from '…';` counts).
  const after = (line: string, re: RegExp) => {
    const m = re.exec(line)!;
    return line.slice(m.index + m[0].length);
  };
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!;
    if (BARE_IMPORT.test(line)) kept.push(after(line, BARE_IMPORT));
    else if (IMPORT_START.test(line)) {
      // From `import` to its `from '…'`; an `import` with none near: only its own line.
      const end = nextFrom[k]!;
      if (end - k <= IMPORT_SPAN) {
        kept.push(after(lines[end]!, FROM_SPECIFIER));
        k = end;
      }
    } else if (REQUIRE_LINE.test(line)) kept.push(after(line, REQUIRE_LINE));
    else kept.push(line);
  }
  return [...kept.join('\n').matchAll(new RegExp(pattern, 'g'))].length;
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
 * Where code ran more times in the test runs (`ran`: every process's segments of one script, summed) than the most of
 * `baselines` (each one's segments summed), as sorted [start, end) offsets (#784 rounds 5 to 7). measureTouched passes
 * one: what loading accounts for, the test baseline plus each load-only run scaled by its extra evaluations.
 */
function ranMore(ran: Segment[], baselines: Segment[][]): [number, number][] {
  const cuts = [...new Set([ran, ...baselines].flatMap((segs) => segs.flatMap(([a, b]) => [a, b])))].sort((x, y) => x - y);
  const at = new Map(cuts.map((c, i) => [c, i]));
  // The run count over each interval [cuts[i], cuts[i + 1]).
  const level = (segs: Segment[]) => {
    const d = new Array<number>(cuts.length).fill(0);
    for (const [a, b, c] of segs) {
      d[at.get(a)!]! += c;
      d[at.get(b)!]! -= c;
    }
    for (let i = 1; i < d.length; i++) d[i]! += d[i - 1]!;
    return d;
  };
  const r = level(ran);
  const bs = baselines.map(level);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    if (r[i]! - Math.max(0, ...bs.map((b) => b[i]!)) <= 0) continue;
    const [a, b] = [cuts[i]!, cuts[i + 1]!];
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
 * ends inside a block comment. A lexer, not a parser, so it reads the text twice (#784 round 6): once with a `/` after
 * a value (a name, a number, `)`, `]`, a string's end) dividing, once with every `/` that starts no comment starting a
 * regular expression (`if (s) /`/.test(s)`, where the first reading opens a template at the backtick). A line holds
 * code only when both readings say so, and ends in a comment when either does. When neither reading ends cleanly (a
 * string, template, comment or regular expression still open at the end), no line holds code. So where one reading is
 * right, a misread only makes a line count for less. Where both misread, with a `/` needing each reading and a quote
 * or backtick after the wrong one, a comment line can still read as code (inferred).
 */
export function codeLines(text: string): { code: boolean[]; inComment: boolean[]; mask: Uint8Array } {
  const a = lexLines(text, false);
  const b = lexLines(text, true);
  if (!a.settled && !b.settled) return { code: a.code.map(() => false), inComment: a.inComment.map(() => true), mask: new Uint8Array(text.length) };
  // `mask[i]`: character i is code in both readings (#784 round 8: a change is measured by its characters).
  const mask = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) mask[i] = a.mask[i]! & b.mask[i]!;
  return { code: a.code.map((c, i) => c && b.code[i] === true), inComment: a.inComment.map((c, i) => c || b.inComment[i] === true), mask };
}

/** One reading of codeLines: `slashIsRegex`, every `/` that starts no comment starts a regular expression. */
function lexLines(text: string, slashIsRegex: boolean): { code: boolean[]; inComment: boolean[]; mask: Uint8Array; settled: boolean } {
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 're' | 'class';
  const code: boolean[] = [false];
  const inComment: boolean[] = [];
  const mask = new Uint8Array(text.length);
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
      if (text[i + 1] !== '\n') {
        i++;
        mask[i] = 1;
      } else {
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
      mask[i] = 1;
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
    mask[i] = 1;
    if (/[A-Za-z0-9_$]/.test(c)) {
      word = /[A-Za-z0-9_$]/.test(prev === 'a' ? (text[i - 1] ?? '') : '') ? word + c : c;
      prev = 'a';
      continue;
    }
    const after = slashIsRegex ? 'operator' : prev === 'a' && !KEYWORDS_BEFORE_REGEX.has(word) ? 'value' : prev === ')' || prev === ']' ? 'value' : 'operator';
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
  return { code: code.map(Boolean), inComment, mask, settled: (s === 'code' || s === 'line') && braces.length === 0 };
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
  /**
   * For each added line, the columns [start, end) the change took on it, when the hunk replaced as many lines as it
   * added (each paired with its old line, the common start and end left out); null: the whole line (#784 round 8).
   */
  cols?: ([number, number] | null)[];
}

/** Character ranges [start, end) of a text. */
export type CharRanges = [number, number][];

/**
 * The columns a hunk's change took on each added line (ChangedHunkSpots.cols, #784 round 8): when it replaced as many
 * lines as it added, each added line against the line it replaced, the common start and end left out (a change that
 * only took characters away: the character after where they were). Otherwise every line whole (null), and so is a
 * line with less code than the line it replaced (code commented out: a removal, measured where it was).
 */
export function changedColumns(added: readonly string[], removed: readonly string[]): ([number, number] | null)[] {
  if (added.length !== removed.length) return added.map(() => null);
  const codeChars = (t: string) => codeLines(t).mask.reduce((n, m) => n + m, 0);
  return added.map((a, k) => {
    const r = removed[k]!;
    if (codeChars(a) < codeChars(r)) return null;
    let p = 0;
    while (p < a.length && p < r.length && a[p] === r[p]) p++;
    let s = 0;
    while (s < a.length - p && s < r.length - p && a[a.length - 1 - s] === r[r.length - 1 - s]) s++;
    const end = a.length - s;
    if (p < end) return [p, end];
    return a.length ? [Math.min(p, a.length - 1), Math.min(p, a.length - 1) + 1] : null;
  });
}

/**
 * The characters of a changed file (its head text) a test must run code on (#784 round 8, by character, not by line):
 * on each added line, the part the change took (`cols`, else the whole line), only its code characters (codeLines'
 * mask: no whitespace, no comment); and, for a hunk that removed code and added none, the first code character at or
 * after where it was, unless that spot is inside a block comment: the code that now runs in the removed code's place,
 * never its neighbours above. Empty: nothing to measure in this file.
 */
export function codeRanges(text: string, hunks: readonly ChangedHunkSpots[]): CharRanges {
  const { inComment, mask } = codeLines(text);
  const starts = lineStarts(text);
  const lines = starts.length - 1;
  const out: CharRanges = [];
  // The runs of code characters in [a, b).
  const codeIn = (a: number, b: number) => {
    const runs: CharRanges = [];
    for (let i = Math.max(0, a); i < Math.min(b, text.length); i++) {
      if (!mask[i]) continue;
      const last = runs.at(-1);
      if (last && last[1] === i) last[1] = i + 1;
      else runs.push([i, i + 1]);
    }
    return runs;
  };
  for (const h of hunks) {
    let added = 0;
    h.added.forEach((l, k) => {
      if (l < 1 || l > lines) return;
      const [a, b] = [starts[l - 1]!, starts[l]!];
      const c = h.cols?.[k];
      const runs = codeIn(c ? a + c[0] : a, c ? a + c[1] : b);
      added += runs.length;
      out.push(...runs);
    });
    // A line replaced by one (paired by `cols`) is measured by what its change took on it alone: if none of that is code
    // (a comment added at its end), it is no change to measure.
    const paired = h.added.length > 0 && h.cols?.length === h.added.length && h.cols.every((c) => c !== null);
    if (added || !h.removedCode || paired) continue;
    if (h.at >= 1 && h.at <= lines && inComment[h.at - 1]) continue;
    const from =h.at >= lines ? text.length : starts[Math.max(0, h.at)]!;
    let p = from;
    while (p < text.length && !mask[p]) p++;
    if (p < text.length) out.push([p, p + 1]);
  }
  return out;
}

/** The 1-based lines `ranges` fall on (for a build's sources, which its map places by line). */
function linesOf(starts: number[], ranges: CharRanges): LineSpans {
  const out: LineSpans = [];
  for (const [a, b] of ranges) {
    let l = 1;
    while (l < starts.length - 1 && starts[l]! <= a) l++;
    let m = l;
    while (m < starts.length - 1 && starts[m]! < b) m++;
    out.push([l, m]);
  }
  return out;
}

/**
 * Whether code ran (`ranges`, V8's innermost block counts: an untaken branch, the other arm of a `?:`, an unevaluated
 * right side of `??`/`||`/`&&` are ranges of their own) on any of `changed`, the changed characters (#784 round 8);
 * null: anywhere.
 */
function ranOn(ranges: [number, number][], changed: CharRanges | null): boolean {
  if (!changed) return ranges.length > 0;
  return changed.some(([a, b]) => overlaps(ranges, a, b));
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
  return measureTouched(coverageDir, root, appPaths, only, hunks, baselineDir).touched;
}

/**
 * touchedAppFiles, and `loads`: every script under `root` the tests evaluated more often than the test baseline did
 * (a dynamic import in a test's body, a copy with a query string, a module that such a module imports), with how many
 * more times (#784 round 7). The gate loads each on its own and reads again with `loads`, each run's coverage taken
 * away as many times as its script was evaluated more, on top of the test baseline's (ranMore).
 */
export function measureTouched(coverageDir: string, root: string, appPaths: string[], only?: readonly string[], hunks?: Readonly<Record<string, readonly ChangedHunkSpots[]>>, baselineDir?: string, loads: readonly LoadRun[] = []): { touched: string[]; loads: { script: string; extra: number }[] } {
  const res = appPaths.map((g) => globToRegExp(g));
  const realRoot = realpathSync.native(root);
  const wanted = hunks ? new Set(Object.keys(hunks)) : only ? new Set(only) : null;
  if (hunks && only) for (const f of [...wanted!]) if (!only.includes(f)) wanted!.delete(f);
  const isApp = (rel: string) => !rel.startsWith('..') && res.some((re) => re.test(rel)) && (!wanted || wanted.has(rel));
  // Each changed file's changed code characters, from its text at the head (the worktree's), and the lines they are on
  // (a build's map places code by line).
  const changed = new Map<string, { chars: CharRanges; lines: LineSpans }>();
  if (hunks) {
    for (const f of wanted!) {
      const text = textOf(join(realRoot, f), SCRIPT_BYTES);
      const chars = text === null ? [] : codeRanges(text, hunks[f]!);
      changed.set(f, { chars, lines: text === null ? [] : linesOf(lineStarts(text), chars) });
    }
    if (![...changed.values()].some((s) => s.chars.length)) throw new CoverageUnreadable(NOTHING_TO_MEASURE);
  }
  const charsOf = (rel: string): CharRanges | null => (hunks ? (changed.get(rel)?.chars ?? []) : null);
  const spansOf = (rel: string): LineSpans | null => (hunks ? (changed.get(rel)?.lines ?? []) : null);
  // Every process's segments of each script under the root: the test runs' summed (`ran`), and what loading accounts
  // for (`loaded`): the test baseline's, plus each load-only run's times how many more times the tests evaluated the
  // script it loaded than the test baseline did (#784 round 7).
  const scripts = new Map<string, { rel: string; text: string; ran: Segment[]; loaded: Segment[] }>();
  // How many times each script's top level ran, by file: in the test runs and in the test baseline.
  const evals = new Map<string, { rel: string; ran: number; baseline: number }>();
  const collect = (dir: string, into: 'ran' | 'baseline' | 'load', times = 1) => {
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
        const rel = relative(realRoot, file).split('\\').join('/');
        // Its top level's run count: how many times this process evaluated it (a query string makes a new copy).
        const top = script.functions.find((f) => f.functionName === '' && f.ranges[0]?.startOffset === 0);
        if (into !== 'load' && top) {
          const e = evals.get(file) ?? { rel, ran: 0, baseline: 0 };
          e[into] += Math.max(0, top.ranges[0]!.count);
          evals.set(file, e);
        }
        let s = scripts.get(file);
        // A baseline only takes away from scripts the tests ran.
        if (!s && into !== 'ran') continue;
        if (!s) {
          const text = textOf(file, SCRIPT_BYTES);
          if (text === null) continue;
          s = { rel, text, ran: [], loaded: [] };
          scripts.set(file, s);
        }
        const segs = ranSegments(script.functions, s.text.length, script.url);
        if (!segs) continue;
        if (into === 'ran') s.ran.push(...segs);
        else s.loaded.push(...segs.map(([a, b, c]): Segment => [a, b, c * times]));
      }
    }
  };
  collect(coverageDir, 'ran');
  if (baselineDir !== undefined) collect(baselineDir, 'baseline');
  for (const l of loads) collect(l.dir, 'load', l.extra);
  const budget = { maps: 0, bytes: 0, sources: 0 };
  const touched = new Set<string>();
  // For each source a build's map names: the lines whose code ran.
  const mappedRan = new Map<string, Set<number>>();
  for (const [file, { rel, text, ran, loaded }] of scripts) {
    const ranges = ranMore(ran, [loaded]);
    if (!ranges.length) continue;
    if (isApp(rel)) {
      if (ranOn(ranges, charsOf(rel))) touched.add(rel);
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
  // Every script the tests evaluated more often than the test baseline did: what each run as it loaded is still in
  // `ran` until it is loaded on its own (the gate does, then reads again with `loads`).
  const more = [...evals.values()].filter((e) => e.ran > e.baseline).map((e) => ({ script: e.rel, extra: e.ran - e.baseline }));
  return { touched: [...touched].sort(), loads: more.sort((a, b) => (a.script < b.script ? -1 : 1)) };
}

/** A load-only run (#784 round 7): `dir`, its coverage; `extra`, how many more times the tests evaluated `script`. */
export interface LoadRun {
  dir: string;
  script: string;
  extra: number;
}

/** What the merge gate asks the reader process: touchedAppFiles's arguments. */
export interface TouchedRequest {
  coverageDir: string;
  baselineDir: string;
  root: string;
  appPaths: string[];
  only: string[];
  hunks: Record<string, ChangedHunkSpots[]>;
  /** The load-only runs (#784 rounds 6, 7), once the scripts to load are known. */
  loads?: LoadRun[];
}

/** What the reader answers: the touched files, and the scripts to load on their own (measureTouched). */
export type TouchedAnswer = { touched: string[]; loads: { script: string; extra: number }[] } | { error: string };

/** The most scripts a read may name to load on their own (more: the read fails, and the PR waits). */
export const LOAD_SCRIPTS_MAX = 64;

/**
 * The time all of one gate run's load-only runs may take together (#784 round 7). Past it the run stops, and the PR
 * waits with the reason named.
 */
export const LOAD_BUDGET_MS = 120_000;

/** How long the reader process may take before the read counts as failed (the PR waits). */
export const COVERAGE_READ_TIMEOUT_MS = 120_000;

/**
 * touchedAppFiles in a process of its own (src/vacuity-read.ts), so no coverage directory, however it is built, holds
 * the coordinator's thread: past `timeoutMs` it is killed and the read fails (fixed text), as does any answer that
 * isn't the reader's. The request goes in on stdin, the answer comes back on stdout (at most 1 MiB). `signal` (the
 * coordinator's shutdown) kills it too.
 */
export function readTouchedInChild(req: TouchedRequest, timeoutMs = COVERAGE_READ_TIMEOUT_MS, signal?: AbortSignal): Promise<TouchedAnswer> {
  const reader = fileURLToPath(new URL('./vacuity-read.js', import.meta.url));
  return new Promise((done) => {
    let out = '';
    let settled = false;
    const finish = (r: TouchedAnswer) => {
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
        const a = JSON.parse(out) as { touched?: unknown; loads?: unknown; error?: unknown };
        if (typeof a.error === 'string') return finish({ error: a.error });
        // The touched files are the PR's own; the scripts, relative paths under the worktree, each with a whole number
        // of extra evaluations, at most LOAD_SCRIPTS_MAX of them.
        const rel = (p: unknown) => typeof p === 'string' && p.length > 0 && p.length <= COVERAGE_LIMITS.urlChars && !isAbsolute(p) && !p.split('/').includes('..');
        const load = (l: unknown) => !!l && typeof l === 'object' && rel((l as { script?: unknown }).script) && Number.isSafeInteger((l as { extra?: unknown }).extra) && ((l as { extra: number }).extra) > 0;
        if (Array.isArray(a.touched) && a.touched.every((t) => typeof t === 'string' && req.only.includes(t)) && Array.isArray(a.loads) && a.loads.every(load)) {
          const loads = (a.loads as { script: string; extra: number }[]).map((l) => ({ script: l.script, extra: l.extra }));
          if (a.touched.length && loads.length > LOAD_SCRIPTS_MAX) return finish({ error: `the coverage read named more than ${LOAD_SCRIPTS_MAX} scripts to load on their own` });
          return finish({ touched: a.touched as string[], loads });
        }
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
