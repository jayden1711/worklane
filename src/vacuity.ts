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
//           (codeRanges, rounds 8 to 11: each hunk aligned by character, its lines paired by code first when large,
//           against V8's block ranges, so code added in an untaken branch on a changed line doesn't count; a removal
//           only where the code on both its sides ran and shares one innermost V8 range in every process (round 12;
//           code moved between app files is no change), never across a block or clause
//           boundary, holding a sub-statement or nested function, or at a statement list's end; removed lines lexed in
//           their base file; comment toggles between hunks measured). Not seen: work a module starts as it loads that keeps running and that
//           the tests' own activity triggers (a timer while a test waits, an async_hooks or exit listener); code
//           after a call that threw (V8 counts a block as run once entered); and where V8 makes no block range (an
//           optional call's arguments, a default parameter or destructuring default, a logical assignment's right
//           side, code in a string) or a build's map places code only by line.
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
 * ranges of every function of the script but the top level: each span takes the count of the innermost range around it,
 * so a block that didn't run, or a nested function never called, is not run code even inside a function that ran. Left
 * out: the module's own top level (the unnamed function at offset 0, which is what loading runs). Nothing is left out by
 * its name (round 12: a method named `'<static_x>'` hid its ranges, N1): a class's static initializers run as the class
 * is defined, and an instance's field initializers when a test makes one, and the baseline takes away what loading runs
 * (round 9). The top level must span exactly the script's text, or that text
 * and the one suffix Node's own TypeScript type stripping adds (`\n\n//# sourceURL=<the script's URL>`: the stripped
 * text keeps every offset). Null otherwise (it ran other text: a loader transformed it), so it counts for nothing.
 */
function ranSegments(fns: V8Coverage['result'][number]['functions'], length: number, url: string, inner?: InnerPiece[]): Segment[] | null {
  const top = fns.find((f) => f.functionName === '' && f.ranges[0]?.startOffset === 0);
  const end = top?.ranges[0]!.endOffset;
  if (end !== length && end !== length + `\n\n//# sourceURL=${url}`.length) return null;
  const rs = fns
    .filter((f) => f !== top)
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
    const top2 = stack.at(-1);
    if (top2) inner?.push([a, b, top2.startOffset, top2.endOffset]);
    if (!top2 || top2.count <= 0) continue;
    const last = out.at(-1);
    if (last && last[1] === a && last[2] === top2.count) last[1] = b;
    else out.push([a, b, top2.count]);
  }
  return out;
}

/** A piece [start, end) of a script and the innermost V8 range around it, [rangeStart, rangeEnd) (#784 round 11). */
type InnerPiece = [number, number, number, number];

/** The innermost V8 range around offset `o` of a script (`pieces` from ranSegments), as `start:end`, or null. */
function innerAt(pieces: readonly InnerPiece[], o: number): string | null {
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b, s, e] = pieces[mid]!;
    if (o < a) hi = mid - 1;
    else if (o >= b) lo = mid + 1;
    else return `${s}:${e}`;
  }
  return null;
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
    // Script code's HTML-like comments (#784 round 10): `<!--` anywhere, `-->` first on a line, each to its end.
    if ((c === '<' && text.startsWith('<!--', i)) || (c === '-' && !code[line] && text.startsWith('-->', i))) {
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
 * the head line the removed lines followed; `added`, the head lines added; `removed`, the text it removed, from line
 * `from` of `oldPath` at the base (round 10: its code/comment mask is read there, in context).
 */
export interface ChangedHunkSpots {
  at: number;
  added: number[];
  removed: string[];
  from?: number;
  oldPath?: string;
}

/** Character ranges [start, end) of a text. */
export type CharRanges = [number, number][];

/**
 * A changed file's changed code (codeRanges): `chars`, code characters the change added or changed, any one of which
 * counts if it ran; `needs`, one per removal, the head offsets that must all have run for it to count (-1: none can).
 */
export interface ChangedCode {
  chars: CharRanges;
  needs: number[][];
}

/**
 * Removed code that crosses a block or clause boundary, or holds a construct that opens a sub-statement or a nested
 * function (#784 rounds 10, 11: a braceless `if`/`for`/`while` body, a concise arrow): it may have run on a path the
 * code on its sides never shows, so it never counts as run.
 */
const BOUNDARY = /[{}?:]|\|\||&&|=>|\b(?:case|default|else|catch|finally|if|for|while|do|with|function|class|switch|try)\b/;

/** Why the gate can't measure a change it can't place by character (fixed text; the PR holds). */
export const UNPLACEABLE = "a change too large to align character by character, so where it changed code can't be told";

/**
 * The most cells one character alignment may take: a hunk's changed middle, or (when that is more) a run of changed
 * lines whose added and removed counts differ (alignHunk; more: the change can't be placed, and the PR holds). About
 * 2,000 code characters a side: some 50 to 90 lines rewritten, not paired line by line.
 */
export const ALIGN_CELLS = 4_000_000;

/**
 * An edit script from `r` to `a` (sequences of characters): '=' a character both keep, '+' one `a` adds, '-' one `r`
 * removes. The common start and end first, then the longest common subsequence of what is left between. Null when that
 * middle is too large to align (ALIGN_CELLS): the change can't be placed, and the caller holds.
 */
function alignChars(a: readonly string[], r: readonly string[]): string[] | null {
  let p = 0;
  while (p < a.length && p < r.length && a[p] === r[p]) p++;
  let s = 0;
  while (s < a.length - p && s < r.length - p && a[a.length - 1 - s] === r[r.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const rm = r.slice(p, r.length - s);
  const mid: string[] = [];
  if (!am.length || !rm.length) {
    for (const _ of rm) mid.push('-');
    for (const _ of am) mid.push('+');
  } else {
    if ((am.length + 1) * (rm.length + 1) > ALIGN_CELLS) return null;
    // lcs[i][j]: the longest common subsequence of am[i..] and rm[j..].
    const w = rm.length + 1;
    const lcs = new Int32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = rm.length - 1; j >= 0; j--) lcs[i * w + j] = am[i] === rm[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < rm.length) {
      if (am[i] === rm[j]) {
        mid.push('=');
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        mid.push('+');
        i++;
      } else {
        mid.push('-');
        j++;
      }
    }
    for (; j < rm.length; j++) mid.push('-');
    for (; i < am.length; i++) mid.push('+');
  }
  return [...new Array<string>(p).fill('='), ...mid, ...new Array<string>(s).fill('=')];
}

/** A line of a hunk side: its non-blank characters, and which of them are code. */
interface HunkLine {
  chars: string[];
  code: boolean[];
}

/**
 * alignChars over a hunk given line by line (#784 rounds 10, 11): the whole hunk first. When that is too large, its
 * lines are paired by their code characters only (a longest common subsequence of lines keyed on code, so a comment
 * edited on every line never shifts the pairing: L1), each pair then aligned by character. A run of changed lines
 * between paired ones is aligned line by line only where it has as many added lines as removed and each such pair
 * really aligns (at least half the code of the longer line kept); a run of unequal counts is aligned whole. Null when a
 * run doesn't align line by line, or any alignment is too large: the change can't be placed, and the caller holds.
 */
function alignHunk(aLines: readonly HunkLine[], rLines: readonly HunkLine[]): string[] | null {
  const whole = alignChars(aLines.flatMap((l) => l.chars), rLines.flatMap((l) => l.chars));
  if (whole) return whole;
  const codeOf = (l: HunkLine) => l.chars.filter((_, k) => l.code[k]);
  const ak = aLines.map((l) => codeOf(l).join(''));
  const rk = rLines.map((l) => codeOf(l).join(''));
  if ((ak.length + 1) * (rk.length + 1) > ALIGN_CELLS) return null;
  const w = rk.length + 1;
  const lcs = new Int32Array((ak.length + 1) * w);
  for (let i = ak.length - 1; i >= 0; i--) {
    for (let j = rk.length - 1; j >= 0; j--) lcs[i * w + j] = ak[i] === rk[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  }
  const ops: string[] = [];
  // Two lines aligned by character; `same` (their code is the same): code only ever against code, so a comment edit
  // never pairs a code character with a comment one.
  const tagged = (l: HunkLine) => l.chars.map((c, k) => (l.code[k] ? 'c' : 'k') + c);
  const pair = (a: HunkLine, r: HunkLine, same = false): boolean => {
    const o = same ? alignChars(tagged(a), tagged(r)) : alignChars(a.chars, r.chars);
    if (!o) return false;
    ops.push(...o);
    return true;
  };
  // Whether two lines' code really aligns: at least half the longer one's code characters kept.
  const aligns = (a: HunkLine, r: HunkLine): boolean => {
    const ac = codeOf(a);
    const rc = codeOf(r);
    const most = Math.max(ac.length, rc.length);
    if (!most) return true;
    const o = alignChars(ac, rc);
    return !!o && o.filter((x) => x === '=').length * 2 >= most;
  };
  let ra: HunkLine[] = [];
  let rr: HunkLine[] = [];
  // A run of changed lines between paired ones.
  const flush = (): boolean => {
    if (ra.length === rr.length) {
      for (let k = 0; k < ra.length; k++) if (!aligns(ra[k]!, rr[k]!) || !pair(ra[k]!, rr[k]!)) return false;
    } else {
      const o = alignChars(ra.flatMap((l) => l.chars), rr.flatMap((l) => l.chars));
      if (!o) return false;
      ops.push(...o);
    }
    ra = [];
    rr = [];
    return true;
  };
  let i = 0;
  let j = 0;
  while (i < ak.length || j < rk.length) {
    if (i < ak.length && j < rk.length && ak[i] === rk[j]) {
      if (!flush() || !pair(aLines[i]!, rLines[j]!, true)) return null;
      i++;
      j++;
    } else if (j >= rk.length || (i < ak.length && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) ra.push(aLines[i++]!);
    else rr.push(rLines[j++]!);
  }
  return flush() ? ops : null;
}

/**
 * The code of a changed file (its head text) a test must run (#784 rounds 8 to 10: by character, never by line). Each
 * hunk's removed text and added lines are aligned character by character, whitespace left out (alignChars).
 * - Every added character that is code at the head (codeLines' mask: no whitespace, no comment) counts if it ran.
 * - The removed side's code/comment mask is read in its base file (`baseOf`: round 10), so an edited line inside a
 *   block comment or JSDoc is comment, never code read out of context; a base file it can't read, or whose lines aren't
 *   the removed ones, makes the change unplaceable (null).
 * - Code taken away and none given in its place (a removal, code commented out) counts only when the code characters
 *   on BOTH its sides ran within the same innermost V8 range, in every process (rounds 11, 12: ranOn), within a line, at a line's end or start
 *   or as whole lines alike. It never counts when the removed code crosses a block or clause boundary or opens a
 *   sub-statement or nested function (BOUNDARY), or when it ended a statement list (the code after it is `}`, `case` or
 *   `default`: V8 keeps no range there). A removal inside a block comment (nothing added) is none.
 * Null: a hunk too large to align, or a removed side it can't place, which the caller holds on.
 */
export function codeRanges(text: string, hunks: readonly ChangedHunkSpots[], baseOf?: (path: string) => string | null, moved?: { head?: ReadonlySet<number>; base?: ReadonlyMap<string, ReadonlySet<number>> }): ChangedCode | null {
  const { inComment, mask } = codeLines(text);
  const starts = lineStarts(text);
  const lines = starts.length - 1;
  // Lines of code moved here from another file, or from here to another (movedCode, round 12) are no change: read as
  // if they held no code.
  const unmark = (m: Uint8Array, st: number[], ls: ReadonlySet<number> | undefined) => {
    for (const l of ls ?? []) if (l >= 1 && l < st.length) m.fill(0, st[l - 1], st[l]);
  };
  unmark(mask, starts, moved?.head);
  const out: CharRanges = [];
  const needs: number[][] = [];
  const baseMasks = new Map<string, { text: string; mask: Uint8Array; starts: number[] } | null>();
  const baseFile = (p: string) => {
    if (!baseMasks.has(p)) {
      const t = baseOf!(p);
      const b = t === null ? null : { text: t, mask: codeLines(t).mask, starts: lineStarts(t) };
      if (b) unmark(b.mask, b.starts, moved?.base?.get(p));
      baseMasks.set(p, b);
    }
    return baseMasks.get(p)!;
  };
  const blank = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v' || c === ' ' || c === '﻿';
  const push = (i: number) => {
    const last = out.at(-1);
    if (last && last[1] === i) last[1] = i + 1;
    else if (!last || last[0] !== i) out.push([i, i + 1]);
  };
  const codeFrom = (i: number) => {
    let q = Math.max(0, i);
    while (q < text.length && !mask[q]) q++;
    return q < text.length ? q : -1;
  };
  const codeBefore = (i: number) => {
    let q = Math.min(i, text.length) - 1;
    while (q >= 0 && !mask[q]) q--;
    return q;
  };
  // Whether head offset `q` ends a statement list (a `}`, or the `case`/`default` of the next clause): V8 drops the
  // continuation range of a list's last statement, so code removed from a list's end shows nowhere whether it was
  // reached (round 11: J1-J3, a jump just before it).
  const endsList = (q: number) => q >= 0 && (text[q] === '}' || /^(?:case|default)\b/.test(text.slice(q, q + 8)));
  const spots = baseOf ? joinToggled() : hunks;
  if (!spots) return null;
  /**
   * The hunks, each run of them joined with the unchanged lines between them where those lines read differently at the
   * base and the head (round 11: T1, a comment opened in one hunk and closed in another, or one closed): measured as
   * one hunk, code turned into a comment is a removal and a comment turned into code is added code. The lines before
   * the first hunk and after the last are compared too. Null: the unchanged lines aren't the same text at both ends
   * (whitespace and blank lines aside), or the base file can't be read.
   */
  function joinToggled(): readonly ChangedHunkSpots[] | null {
    if (!hunks.length) return hunks;
    const oldPath = hunks[0]!.oldPath;
    if (oldPath === undefined || hunks.some((h) => h.oldPath !== oldPath || h.from === undefined)) return null;
    // A new file: nothing at the base, so no unchanged line.
    if (hunks.length === 1 && hunks[0]!.from === 0 && !hunks[0]!.removed.length) return hunks;
    const base = baseFile(oldPath);
    if (!base) return null;
    const baseLines = base.starts.length - 1;
    // Each hunk's lines at the base and at the head, [first, last] (last = first - 1: none).
    const span = hunks.map((h) => {
      const bS = h.removed.length ? h.from! : h.from! + 1;
      const hS = h.added.length ? h.added[0]! : h.at + 1;
      return { h, bS, bE: bS + h.removed.length - 1, hS, hE: hS + h.added.length - 1 };
    });
    // Lines [l1, l2] of a text: their non-blank characters, and which of them are code.
    const read = (t: string, m: Uint8Array, st: number[], l1: number, l2: number) => {
      let chars = '';
      let code = '';
      for (let i = l1 >= 1 ? st[l1 - 1]! : 0; l2 >= l1 && i < (st[l2] ?? t.length); i++) {
        if (blank(t[i]!)) continue;
        chars += t[i];
        code += m[i] ? '1' : '0';
      }
      return { chars, code };
    };
    // Whether the unchanged lines (base [b1, b2], head [h1, h2]) read differently; null: they aren't the same text.
    const toggled = (b1: number, b2: number, h1: number, h2: number): boolean | null => {
      const b = read(base.text, base.mask, base.starts, b1, b2);
      const a = read(text, mask, starts, h1, h2);
      return a.chars !== b.chars ? null : a.code !== b.code;
    };
    const first = toggled(1, span[0]!.bS - 1, 1, span[0]!.hS - 1);
    const last = toggled(span.at(-1)!.bE + 1, baseLines, span.at(-1)!.hE + 1, lines);
    if (first === null || last === null) return null;
    const groups: (typeof span)[] = [[span[0]!]];
    for (let k = 1; k < span.length; k++) {
      const [p, q] = [span[k - 1]!, span[k]!];
      const t = toggled(p.bE + 1, q.bS - 1, p.hE + 1, q.hS - 1);
      if (t === null) return null;
      if (t) groups.at(-1)!.push(q);
      else groups.push([q]);
    }
    if (first) groups[0]!.unshift({ ...span[0]!, bS: 1, hS: 1 });
    if (last) groups.at(-1)!.push({ ...span.at(-1)!, bE: baseLines, hE: lines });
    return groups.map((g) => {
      if (g.length === 1) return g[0]!.h;
      const [bS, hS, bE, hE] = [g[0]!.bS, g[0]!.hS, g.at(-1)!.bE, g.at(-1)!.hE];
      const removed: string[] = [];
      for (let l = bS; l <= bE && l <= baseLines; l++) removed.push(base.text.slice(base.starts[l - 1], base.starts[l]).replace(/\n$/, ''));
      const added: number[] = [];
      for (let l = hS; l <= hE; l++) added.push(l);
      return { at: hS - 1, added, removed, from: bS, oldPath };
    });
  }
  for (const h of spots) {
    // The added side: its characters at the head, whitespace left out.
    const aOff: number[] = [];
    const aLines: HunkLine[] = [];
    for (const l of h.added) {
      if (l < 1 || l > lines) continue;
      const line: HunkLine = { chars: [], code: [] };
      for (let i = starts[l - 1]!; i < starts[l]!; i++) {
        if (blank(text[i]!)) continue;
        aOff.push(i);
        line.chars.push(text[i]!);
        line.code.push(mask[i] === 1);
      }
      aLines.push(line);
    }
    // The removed side: its characters, and which held code, as lexed in the base file they came from (round 10);
    // without a base reader (a direct call), its own text lexed.
    const rText = h.removed.join('\n');
    let rMask: Uint8Array;
    if (baseOf && h.removed.length) {
      const base = h.oldPath !== undefined && h.from !== undefined ? baseFile(h.oldPath) : null;
      if (!base) return null;
      rMask = new Uint8Array(rText.length);
      let at = 0;
      for (let k = 0; k < h.removed.length; k++) {
        const line = h.removed[k]!;
        const from = base.starts[h.from! - 1 + k];
        if (from === undefined || base.text.slice(from, from + line.length) !== line) return null;
        rMask.set(base.mask.subarray(from, from + line.length), at);
        at += line.length + 1;
      }
    } else rMask = codeLines(rText).mask;
    const rIdx: number[] = [];
    const rLines: HunkLine[] = h.removed.map(() => ({ chars: [], code: [] }));
    for (let i = 0, k = 0; i < rText.length; i++) {
      if (rText[i] === '\n') k++;
      else if (!blank(rText[i]!)) {
        rIdx.push(i);
        rLines[k]!.chars.push(rText[i]!);
        rLines[k]!.code.push(rMask[i] === 1);
      }
    }
    const ops = alignHunk(aLines, rLines);
    if (!ops) return null;
    // Where the hunk's added text ends at the head (a removal after its last character is measured from there).
    const lastAdded = h.added.filter((l) => l >= 1 && l <= lines).at(-1);
    const after = lastAdded !== undefined ? starts[lastAdded]! : h.at >= lines ? text.length : starts[Math.max(0, h.at)]!;
    const pureRemoval = !h.added.length;
    let ai = 0;
    let ri = 0;
    // One gap: a run of characters the change took or gave, or kept but turned from code to comment or back.
    let addedCode = false;
    // The removed code characters of the gap (their places in rText), and where it began at the head.
    let removed: number[] = [];
    let gapAt = -1;
    const close = () => {
      // Code taken away and none given in its place (a removal, code commented out): it counts only where the code on
      // BOTH its sides ran, within the same innermost V8 range in every process (rounds 11, 12: ranOn); never across a boundary. Code given
      // in its place is measured itself.
      if (removed.length && !addedCode && !(pureRemoval && h.at >= 1 && h.at <= lines && inComment[h.at - 1])) {
        let code = '';
        for (let i = removed[0]!; i <= removed.at(-1)!; i++) code += rMask[i] ? rText[i] : ' ';
        const p = ai < aOff.length ? aOff[ai]! : after;
        const next = codeFrom(p);
        needs.push(BOUNDARY.test(code) || endsList(next) ? [-1] : [codeBefore(gapAt >= 0 ? gapAt : p), next]);
      }
      addedCode = false;
      removed = [];
      gapAt = -1;
    };
    for (const op of ops) {
      if (op === '=') {
        const aCode = mask[aOff[ai]!] === 1;
        const rCode = rMask[rIdx[ri]!] === 1;
        if (aCode !== rCode) {
          if (gapAt < 0) gapAt = aOff[ai]!;
          if (aCode) {
            push(aOff[ai]!);
            addedCode = true;
          } else removed.push(rIdx[ri]!);
        } else close();
        ai++;
        ri++;
      } else if (op === '+') {
        if (gapAt < 0) gapAt = aOff[ai]!;
        if (mask[aOff[ai]!]) {
          push(aOff[ai]!);
          addedCode = true;
        }
        ai++;
      } else {
        if (rMask[rIdx[ri]!]) removed.push(rIdx[ri]!);
        ri++;
      }
    }
    close();
  }
  return { chars: out.sort((x, y) => x[0] - y[0]), needs };
}

/**
 * Code a PR moved from one app file to another (round 12: R1, R3, R4): git pairs a rename only by its similarity guess
 * over raw text, so a moved file re-indented or edited, or code split out into a new file, reads as all added code.
 * Each added line (`hunks`: the files measured, at the head) whose code characters (whitespace and comments left out)
 * are a line some OTHER app file's hunks removed (`hunks` and `others`, as lexed at the base) is moved, and so is that
 * removed line (each removed line pairs once). An added line whose code isn't a whole removed line but lies within the
 * code another file removed (8 characters at least: a moved line split or joined) is moved too. Moved lines are no
 * change: `head`, by file, the head lines that aren't added code; `base`, by base path, the base lines that aren't
 * removed code. `left`: the `others` files with removed code nothing matched (a deleted file's guard, say), whose
 * removal can't be measured at the head, so counts for nothing. Null: a base or head file it can't read, or whose lines
 * aren't the hunks' (the change can't be placed).
 */
export interface MovedCode {
  head: Map<string, Set<number>>;
  base: Map<string, Set<number>>;
  left: string[];
}

function movedCode(headOf: (path: string) => string | null, hunks: Readonly<Record<string, readonly ChangedHunkSpots[]>>, others: Readonly<Record<string, readonly ChangedHunkSpots[]>>, baseOf: (path: string) => string | null): MovedCode | null {
  const read = new Map<string, { text: string; mask: Uint8Array; starts: number[] } | null>();
  const lexed = (key: string, get: () => string | null) => {
    if (!read.has(key)) {
      const t = get();
      read.set(key, t === null ? null : { text: t, mask: codeLines(t).mask, starts: lineStarts(t) });
    }
    return read.get(key)!;
  };
  const keyOf = (f: { text: string; mask: Uint8Array; starts: number[] }, l: number) => {
    let k = '';
    for (let i = f.starts[l - 1]!; i < f.starts[l]!; i++) if (f.mask[i] && !/\s/.test(f.text[i]!)) k += f.text[i];
    return k;
  };
  // Every removed line's code, by its key, and every file's removed code in one string (for split or joined lines).
  const removed = new Map<string, { file: string; oldPath: string; line: number; used: boolean }[]>();
  const all: { file: string; oldPath: string; line: number; key: string; used: boolean }[] = [];
  const pooled = new Map<string, string>();
  for (const [file, hs] of [...Object.entries(hunks), ...Object.entries(others)]) {
    for (const h of hs) {
      if (!h.removed.length) continue;
      if (h.oldPath === undefined || h.from === undefined) return null;
      const base = lexed(`base:${h.oldPath}`, () => baseOf(h.oldPath!));
      if (!base) return null;
      for (let k = 0; k < h.removed.length; k++) {
        const line = h.from + k;
        const from = base.starts[line - 1];
        if (from === undefined || base.text.slice(from, from + h.removed[k]!.length) !== h.removed[k]) return null;
        const key = keyOf(base, line);
        if (!key) continue;
        const r = { file, oldPath: h.oldPath, line, key, used: false };
        all.push(r);
        const same = removed.get(key);
        if (same) same.push(r);
        else removed.set(key, [r]);
        pooled.set(file, (pooled.get(file) ?? '') + key);
      }
    }
  }
  const out: MovedCode = { head: new Map(), base: new Map(), left: [] };
  if (!all.length) return out;
  const mark = (m: Map<string, Set<number>>, k: string, l: number) => m.set(k, (m.get(k) ?? new Set()).add(l));
  const unmatched: { file: string; line: number; key: string }[] = [];
  for (const [file, hs] of Object.entries(hunks)) {
    const head = lexed(`head:${file}`, () => headOf(file));
    if (!head) {
      if (hs.some((h) => h.added.length)) return null;
      continue;
    }
    for (const h of hs) {
      for (const line of h.added) {
        if (line < 1 || line >= head.starts.length) continue;
        const key = keyOf(head, line);
        if (!key) continue;
        const r = removed.get(key)?.find((x) => !x.used && x.file !== file);
        if (r) {
          r.used = true;
          mark(out.head, file, line);
          mark(out.base, r.oldPath, r.line);
        } else unmatched.push({ file, line, key });
      }
    }
  }
  for (const u of unmatched) {
    if (u.key.length < 8) continue;
    for (const [file, text] of pooled) {
      if (file !== u.file && text.includes(u.key)) {
        mark(out.head, u.file, u.line);
        break;
      }
    }
  }
  out.left = [...new Set(all.filter((r) => !r.used && !(r.file in hunks)).map((r) => r.file))].sort();
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
 * null: anywhere. A removal (`needs`, its two sides) counts only when both sides ran and lie in the same innermost V8
 * range (`pieces`, rounds 11, 12) in EVERY process that ran the script (`pieces`, one list per process; no range in a
 * process is the script's top level there, which both sides must then share): a jump just before it, a hoisted
 * declaration or a closing `}` just after it, the end of an arm, or code only loading ran, never stands in for the
 * removed code, and a process that loaded the script without calling its function (one range for the whole function)
 * never hides another process's finer ranges (Q1, I1).
 */
function ranOn(ranges: [number, number][], changed: ChangedCode | null, pieces: readonly (readonly InnerPiece[])[]): boolean {
  if (!changed) return ranges.length > 0;
  const removal = (n: number[]) => {
    if (n.length !== 2 || n.some((o) => o < 0 || !overlaps(ranges, o, o + 1))) return false;
    return pieces.length > 0 && pieces.every((p) => innerAt(p, n[0]!) === innerAt(p, n[1]!));
  };
  return changed.chars.some(([a, b]) => overlaps(ranges, a, b)) || changed.needs.some(removal);
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
export function measureTouched(coverageDir: string, root: string, appPaths: string[], only?: readonly string[], hunks?: Readonly<Record<string, readonly ChangedHunkSpots[]>>, baselineDir?: string, loads: readonly LoadRun[] = [], baseOf?: (path: string) => string | null, elsewhere: Readonly<Record<string, readonly ChangedHunkSpots[]>> = {}): { touched: string[]; loads: { script: string; extra: number }[] } {
  const res = appPaths.map((g) => globToRegExp(g));
  const realRoot = realpathSync.native(root);
  const wanted = hunks ? new Set(Object.keys(hunks)) : only ? new Set(only) : null;
  if (hunks && only) for (const f of [...wanted!]) if (!only.includes(f)) wanted!.delete(f);
  const isApp = (rel: string) => !rel.startsWith('..') && res.some((re) => re.test(rel)) && (!wanted || wanted.has(rel));
  // Each changed file's changed code characters, from its text at the head (the worktree's), and the lines they are on
  // (a build's map places code by line).
  const changed = new Map<string, { code: ChangedCode; lines: LineSpans }>();
  if (hunks) {
    // Code moved between app files is no change (round 12): matched against what the PR removed from other app files,
    // the measured ones and `elsewhere`'s (a deleted file, say), as read at the base.
    const measured = Object.fromEntries([...wanted!].map((f) => [f, hunks[f]!]));
    const others = Object.fromEntries(Object.entries(elsewhere).filter(([f]) => !wanted!.has(f) && !f.startsWith('..') && res.some((re) => re.test(f))));
    const moved = baseOf ? movedCode((f) => textOf(join(realRoot, f), SCRIPT_BYTES), measured, others, baseOf) : { head: new Map(), base: new Map(), left: [] };
    if (moved === null) throw new CoverageUnreadable(UNPLACEABLE);
    for (const f of wanted!) {
      const text = textOf(join(realRoot, f), SCRIPT_BYTES);
      const code = text === null ? { chars: [], needs: [] } : codeRanges(text, hunks[f]!, baseOf, { head: moved.head.get(f), base: moved.base });
      // A change it can't place by character holds the PR: never measured by the whole line instead (#784 round 9).
      if (code === null) throw new CoverageUnreadable(UNPLACEABLE);
      changed.set(f, { code, lines: linesOf(text === null ? [0] : lineStarts(text), code.chars) });
    }
    // Code a deleted (or otherwise unmeasured) app file lost that no other file took: a removal no run can show.
    for (const f of moved.left) changed.set(f, { code: { chars: [], needs: [[-1]] }, lines: [] });
    if (![...changed.values()].some((s) => s.code.chars.length || s.code.needs.length)) throw new CoverageUnreadable(NOTHING_TO_MEASURE);
  }
  const codeOf = (rel: string): ChangedCode | null => (hunks ? (changed.get(rel)?.code ?? { chars: [], needs: [] }) : null);
  const spansOf = (rel: string): LineSpans | null => (hunks ? (changed.get(rel)?.lines ?? []) : null);
  // Every process's segments of each script under the root: the test runs' summed (`ran`), and what loading accounts
  // for (`loaded`): the test baseline's, plus each load-only run's times how many more times the tests evaluated the
  // script it loaded than the test baseline did (#784 round 7).
  const scripts = new Map<string, { rel: string; text: string; ran: Segment[]; loaded: Segment[]; pieces: InnerPiece[][] }>();
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
          s = { rel, text, ran: [], loaded: [], pieces: [] };
          scripts.set(file, s);
        }
        // A byte-order mark is no part of the script V8 ran: its offsets start after it (#784 round 9).
        const bom = s.text.charCodeAt(0) === 0xfeff ? 1 : 0;
        // The script's innermost ranges in this process, kept per process (round 12: they differ between processes, since
        // V8 gives a function a process never called one range and a function never compiled none, Q1/I1).
        const pieces: InnerPiece[] = [];
        const segs = ranSegments(script.functions, s.text.length - bom, script.url, pieces)?.map(([a, b, c]): Segment => [a + bom, b + bom, c]);
        if (!segs) continue;
        if (into === 'ran') s.pieces.push(pieces.map(([a, b, x, y]): InnerPiece => [a + bom, b + bom, x + bom, y + bom]));
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
  for (const [file, { rel, text, ran, loaded, pieces }] of scripts) {
    // (pieces: one list per process that ran the script.)
    const ranges = ranMore(ran, [loaded]);
    if (!ranges.length) continue;
    if (isApp(rel)) {
      if (ranOn(ranges, codeOf(rel), pieces)) touched.add(rel);
      continue;
    }
    for (const [src, lines] of mappedLines(file, ranges, text, realRoot, budget)) {
      if (!mappedRan.has(src)) mappedRan.set(src, new Set());
      for (const l of lines) mappedRan.get(src)!.add(l);
    }
  }
  for (const [src, ran] of mappedRan) {
    if (!isApp(src) || touched.has(src)) continue;
    // A build's sources are placed by line only, so a removal there never counts (round 11: no V8 range to test its sides).
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
  /** Every other file's hunks that took text away (round 12): code moved from an app file among them is no change. */
  elsewhere?: Record<string, ChangedHunkSpots[]>;
  /** The load-only runs (#784 rounds 6, 7), once the scripts to load are known. */
  loads?: LoadRun[];
  /**
   * Where the PR's change is measured from, and the clone that has it: the base files its removed lines are read in.
   * The reader refuses a request without them (round 11), never lexing removed lines out of their file.
   */
  base: string;
  repo: string;
}

/**
 * A file's text at `base` in the clone `repo` (git show, with change-files.ts's guards: no replace refs, no attributes
 * file), at most SCRIPT_BYTES; null when it can't be read. For the reader process only (it is synchronous).
 */
export function baseTextReader(repo: string, base: string): (path: string) => string | null {
  const seen = new Map<string, string | null>();
  return (path) => {
    if (!seen.has(path)) {
      const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.attributesFile=/dev/null', 'show', `${base}:${path}`], { cwd: repo, encoding: 'utf8', maxBuffer: SCRIPT_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
      seen.set(path, r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null);
    }
    return seen.get(path)!;
  };
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
