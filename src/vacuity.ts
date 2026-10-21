// Vacuous-test detection, for any Node test runner.
//  static:  a test file with no assertion calls (configured pattern) fails. An import or require of an assertion
//           module is not a call (countAssertionCalls).
//  dynamic: run the file under NODE_V8_COVERAGE; it must execute code inside the app's paths. Code that runs as the
//           module loads doesn't count: the module's own top level, V8's synthetic initializers (a class's static
//           fields), and, for the merge gate, anything off the lines the PR changes. A helper the module calls as it
//           loads (`const T = build()`, tsc's __decorate, esbuild's __name) runs only its own lines, so importing a file
//           counts only when the PR changed those very lines.
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

/**
 * Where a script's code ran, as sorted [start, end) offsets. One sweep over the ranges of every function of the script
 * but two kinds: each span takes the count of the innermost range around it, so a block that didn't run, or a nested
 * function never called, is not run code even inside a function that ran. Left out: the module's own top level (the
 * unnamed function at offset 0, which is what loading runs) and V8's synthetic initializers (`<static_initializer>` and
 * the like). Null when the coverage doesn't fit the script of `length` (it ran other text: a loader transformed it), so
 * it counts for nothing.
 */
function executedRanges(fns: V8Coverage['result'][number]['functions'], length: number): [number, number][] | null {
  const top = fns.find((f) => f.functionName === '' && f.ranges[0]?.startOffset === 0);
  if (!top || top.ranges[0]!.endOffset !== length) return null;
  const rs = fns
    .filter((f) => f !== top && !f.functionName.startsWith('<'))
    .flatMap((f) => f.ranges)
    .filter((r) => r.startOffset < r.endOffset)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const cuts = [...new Set(rs.flatMap((r) => [r.startOffset, r.endOffset]))].sort((a, b) => a - b);
  const out: [number, number][] = [];
  const stack: V8Range[] = [];
  let j = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i]!, cuts[i + 1]!];
    while (stack.length && stack.at(-1)!.endOffset <= a) stack.pop();
    while (j < rs.length && rs[j]!.startOffset <= a) {
      while (stack.length && stack.at(-1)!.endOffset <= a) stack.pop();
      if (rs[j]!.endOffset > a) stack.push(rs[j]!);
      j++;
    }
    const inner = stack.at(-1);
    if (!inner || inner.count <= 0) continue;
    const last = out.at(-1);
    if (last && last[1] === a) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

const overlaps = (ranges: [number, number][], a: number, b: number) => ranges.some(([s, e]) => s < b && a < e);

/** The changed lines of a file, 1-based inclusive spans (null: every line counts). */
export type LineSpans = [number, number][];

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
 * App files whose code ran in a coverage run, under the rules of executedRanges (not the module's top level, not V8's
 * synthetic initializers): with `lines`, only on those changed lines of those files (the merge gate's call: it never
 * records a file the PR doesn't change); without, on any line. A built script outside the app paths (dist/) counts for
 * the source lines its source map names (mappedLines). The coverage directory, the scripts and the maps are read as
 * hostile input (readCoverageDir throws CoverageUnreadable); only script paths under `root`, of at most
 * COVERAGE_LIMITS.urlChars characters, are resolved on disk (realpathSync.native). Synchronous: the merge gate runs it in
 * a process of its own, with a time limit (readTouchedInChild).
 */
export function touchedAppFiles(coverageDir: string, root: string, appPaths: string[], only?: readonly string[], lines?: Readonly<Record<string, LineSpans>>): string[] {
  const res = appPaths.map((g) => globToRegExp(g));
  const realRoot = realpathSync.native(root);
  const wanted = lines ? new Set(Object.keys(lines)) : only ? new Set(only) : null;
  if (lines && only) for (const f of [...wanted!]) if (!only.includes(f)) wanted!.delete(f);
  const isApp = (rel: string) => !rel.startsWith('..') && res.some((re) => re.test(rel)) && (!wanted || wanted.has(rel));
  const spansOf = (rel: string): LineSpans | null => (lines ? (lines[rel] ?? []) : null);
  const budget = { maps: 0, bytes: 0, sources: 0 };
  const touched = new Set<string>();
  const mappedRan = new Map<string, Set<number>>();
  for (const cov of readCoverageDir(coverageDir)) {
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
      const text = textOf(file, SCRIPT_BYTES);
      if (text === null) continue;
      const ranges = executedRanges(script.functions, text.length);
      if (!ranges?.length) continue;
      if (isApp(rel)) {
        if (ranOn(ranges, lineStarts(text), spansOf(rel))) touched.add(rel);
        continue;
      }
      for (const [src, ran] of mappedLines(file, ranges, text, realRoot, budget)) {
        if (!mappedRan.has(src)) mappedRan.set(src, new Set());
        for (const l of ran) mappedRan.get(src)!.add(l);
      }
    }
  }
  for (const [src, ran] of mappedRan) {
    if (!isApp(src) || touched.has(src)) continue;
    const spans = spansOf(src);
    if (!spans ? ran.size > 0 : spans.some(([a, b]) => [...ran].some((l) => l >= a && l <= b))) touched.add(src);
  }
  return [...touched].sort();
}

/** What the merge gate asks the reader process: touchedAppFiles's arguments. */
export interface TouchedRequest {
  coverageDir: string;
  root: string;
  appPaths: string[];
  only: string[];
  lines: Record<string, LineSpans>;
}

/** How long the reader process may take before the read counts as failed (the PR waits). */
export const COVERAGE_READ_TIMEOUT_MS = 120_000;

/**
 * touchedAppFiles in a process of its own (src/vacuity-read.ts), so no coverage directory, however it is built, holds
 * the coordinator's thread: past `timeoutMs` it is killed and the read fails (fixed text), as does any answer that
 * isn't the reader's. The request goes in on stdin, the answer comes back on stdout (at most 1 MiB).
 */
export function readTouchedInChild(req: TouchedRequest, timeoutMs = COVERAGE_READ_TIMEOUT_MS): Promise<{ touched: string[] } | { error: string }> {
  const reader = fileURLToPath(new URL('./vacuity-read.js', import.meta.url));
  return new Promise((done) => {
    let out = '';
    let settled = false;
    const finish = (r: { touched: string[] } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const child = spawn(process.execPath, [reader], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ error: `the coverage directory took longer than ${Math.round(timeoutMs / 1000)} s to read` });
    }, timeoutMs);
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
