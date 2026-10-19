// Test selection from imports: which test files a change can affect, read from the code (docs/test-runs.md,
// "Test selection").
//
// The graph's nodes are a repo's files. A JS/TS file's edges are its imports (static, and dynamic or require() ones
// whose target can be worked out), and its reads: paths it builds from a known root (join(root, 'a', 'b'), a
// `new URL('…', import.meta.url)`, a name bound to one). A test file depends on everything it reaches through
// edges, and on every path any of those files reads.
//
// The plan is the whole suite whenever the code can't say: a deleted file, a forced file (a lockfile, a config), a
// script (a shell script sources what it likes), a file some code names in a string without a read this can
// resolve, or a file nothing reaches (but documentation). A test with an import it can't resolve, or one that reads
// the whole repo, runs on every change.
// Pure: no fs, no git; the caller hands in the files and their contents (scripts/ci/affected.mjs from the working
// tree, ./select.ts from a commit).
import { posix } from 'node:path';
import { shownPath } from '../path-text.js';

export const CODE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Files that run as programs of their own (what they source or call is invisible here), or have no extension. */
const SCRIPT_EXT = /\.(?:sh|bash|zsh|ps1|bat|cmd|py|rb|pl)$/;

export interface GraphOptions {
  /** Every file in the repo at the commit (repo-relative, `/`-separated). */
  files: readonly string[];
  /** A code file's contents (only code files are read). */
  read: (file: string) => string;
  /**
   * Shared helper modules, described instead of scanned: for each, its exports' names -> the repo paths a file that
   * uses the name reaches (code it imports or runs, paths it reads; '' is the root). Nothing is charged to a file
   * that only imports the module, so the description must cover all the module imports and reads.
   */
  pathModules?: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>;
  /** Where a source file runs from (a build output): src/x.ts -> dist/src/x.js. Default: where it is. */
  runtimePath?: (file: string) => string;
  /** A runtime path back to its source: dist/src/x.js -> src/x.js (resolved as an import after). Default: unchanged. */
  sourcePath?: (path: string) => string;
  /** A bare import that is a package (or a builtin): not part of the repo. */
  isPackage?: (specifier: string) => boolean;
  /**
   * What a read of the whole repo by this file stands for, when less than everything: a module that, at run time,
   * reads the directory it is installed in reads the package's files. Null (the default): the whole repo.
   */
  wholeRead?: (file: string) => readonly string[] | null;
}

export interface FileFacts {
  /** Repo files this one runs or imports. */
  edges: Set<string>;
  /** Paths it reads: a file or a directory prefix. '' is the whole repo. */
  reads: Set<string>;
  /** Imports or requires it makes that this can't resolve: why. */
  opaque: string[];
  /** Every string literal's text (for the "named but not reached" check). */
  strings: string[];
  /** It lists the repo's files (git ls-files in the root): which files exist, not what's in them. */
  lists: boolean;
}

export interface Graph {
  files: Set<string>;
  facts: Map<string, FileFacts>;
}

const norm = (p: string): string | null => {
  const n = posix.normalize(p).replace(/\/+$/, '');
  if (n === '..' || n.startsWith('../') || posix.isAbsolute(n)) return null;
  return n === '.' || n === '' ? '' : n;
};

/** The text inside the parentheses that open at `open` (the index of `(`), balanced, strings skipped; null if unclosed. */
export function balanced(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Split an argument list at its top-level commas. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(from, i).trim());
      from = i + 1;
    }
  }
  const last = args.slice(from).trim();
  if (last) out.push(last);
  return out;
}

/** A string literal's value; a template literal's text up to its first `${` (with `partial`); null for anything else. */
export function literal(expr: string): { value: string; partial: boolean } | null {
  const m = /^(['"])((?:\\.|(?!\1)[^\\\n])*)\1$/.exec(expr);
  if (m) return { value: m[2]!.replace(/\\(.)/g, '$1'), partial: false };
  const t = /^`([^`]*)`$/.exec(expr);
  if (!t) return null;
  const at = t[1]!.indexOf('${');
  return at < 0 ? { value: t[1]!, partial: false } : { value: t[1]!.slice(0, at), partial: true };
}

/**
 * A JS/TS source's string and template literals (their text, a template's `${…}` parts left out), and the source
 * with everything that isn't code blanked: comments, regular expressions and the insides of strings become spaces
 * (the quotes stay, and a template's `${…}` stays code), so a search of it finds only code. A `/` after an operator
 * or an opening bracket starts a regular expression; after a value it divides.
 */
export function lex(text: string): { strings: string[]; masked: string } {
  const strings: string[] = [];
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  /** Code (with its `{` depth) or a template (with its text so far), innermost last. */
  const stack: ({ kind: 'code'; depth: number } | { kind: 'tpl'; text: string })[] = [{ kind: 'code', depth: 0 }];
  let prev = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const top = stack[stack.length - 1]!;
    if (top.kind === 'tpl') {
      if (c === '\\') {
        top.text += text[i + 1] ?? '';
        blank(i, i + 2);
        i++;
      } else if (c === '`') {
        strings.push(top.text);
        stack.pop();
        prev = 'x';
      } else if (c === '$' && text[i + 1] === '{') {
        stack.push({ kind: 'code', depth: 0 });
        i++;
        prev = '{';
      } else {
        top.text += c;
        blank(i, i + 1);
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end - 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      blank(i, end < 0 ? text.length : end + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
      const from = i;
      let cls = false;
      for (i++; i < text.length; i++) {
        const r = text[i]!;
        if (r === '\\') i++;
        else if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if ((r === '/' && !cls) || r === '\n') break;
      }
      blank(from, i + 1);
      prev = 'x';
      continue;
    }
    if (c === '"' || c === "'") {
      let s = '';
      const from = i;
      for (i++; i < text.length && text[i] !== c && text[i] !== '\n'; i++) {
        if (text[i] === '\\') s += text[++i] ?? '';
        else s += text[i];
      }
      strings.push(s);
      blank(from + 1, i);
      prev = 'x';
      continue;
    }
    if (c === '`') {
      stack.push({ kind: 'tpl', text: '' });
      continue;
    }
    if (c === '{') top.depth++;
    else if (c === '}') {
      if (top.depth === 0 && stack.length > 1) {
        stack.pop();
        prev = 'x';
        continue;
      }
      top.depth--;
    }
    if (/[\w$]/.test(c)) {
      const word = /^[\w$]+/.exec(text.slice(i, i + 40))![0];
      i += word.length - 1;
      // After these a / starts a regular expression, as after an operator.
      prev = /^(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/.test(word) ? '(' : 'x';
    } else if (!/\s/.test(c)) prev = c;
  }
  return { strings, masked: out.join('') };
}

const resolveCandidates = (p: string): string[] => {
  const out = [p];
  const ext = posix.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  if (ext === '.js') out.push(`${stem}.ts`, `${stem}.tsx`);
  else if (ext === '.jsx') out.push(`${stem}.tsx`);
  else if (ext === '.mjs') out.push(`${stem}.mts`);
  else if (ext === '.cjs') out.push(`${stem}.cts`);
  else if (!ext || !CODE_EXT.test(p)) for (const e of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js']) out.push(p + e);
  return out;
};

/** A name bound to a path; `dir` when only a directory of it is known (a template, a computed part). */
interface PathBinding {
  path: string;
  dir: boolean;
}

/** The text of a `const NAME = …` right-hand side from `from`: up to a `;`, `,` or line end outside brackets. */
function rhsEnd(masked: string, from: number): number {
  let depth = 0;
  let end = from;
  for (; end < masked.length; end++) {
    const c = masked[end]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ';' || c === '\n' || c === ',')) break;
  }
  return end;
}

/** One file's static imports: the specifier and the names it binds (`*` for a namespace import). */
function staticImports(text: string, masked: string): { spec: string; names: Map<string, string> }[] {
  const out: { spec: string; names: Map<string, string> }[] = [];
  for (const m of masked.matchAll(/(?<![\w$.])(?:from|import)\s*(?=['"])/g)) {
    const spec = /^(['"])([^'"\n]+)\1/.exec(text.slice(m.index + m[0].length));
    if (!spec) continue;
    const names = new Map<string, string>();
    // The clause before `from`: import a, { b as c, type d } / import * as ns / export { x } from.
    const head = /(?:import|export)\s+(?:type\s+)?([^;]*?)\s*$/.exec(masked.slice(Math.max(0, m.index - 2000), m.index));
    const clause = head?.[1] ?? '';
    const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
    if (ns) names.set(ns[1]!, '*');
    const braces = /\{([^}]*)\}/.exec(clause);
    for (const part of braces?.[1]?.split(',') ?? []) {
      const p = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (p) names.set(p[2] ?? p[1]!, p[1]!);
    }
    out.push({ spec: spec[2]!, names });
  }
  return out;
}

/** Build the graph: every code file's edges, reads and unresolved imports. */
export function buildGraph(o: GraphOptions): Graph {
  const files = new Set(o.files);
  const runtime = o.runtimePath ?? ((f: string) => f);
  const source = o.sourcePath ?? ((p: string) => p);
  const isPackage = o.isPackage ?? ((s: string) => !s.startsWith('.') && !s.startsWith('/'));
  const asFile = (p: string): string | null => {
    for (const c of resolveCandidates(p)) if (files.has(c)) return c;
    return null;
  };
  const code = o.files.filter((f) => CODE_EXT.test(f));
  const lexed = new Map(code.map((f) => {
    const text = o.read(f);
    return [f, { text, ...lex(text) }] as const;
  }));
  /** Each module's exported names bound to paths (from the pass before). */
  let exported = new Map<string, Map<string, PathBinding>>();
  let facts = new Map<string, FileFacts>();
  // Two passes: the second sees the path names each module exports (engineRoot(), EXAMPLE_DIR) where they're used.
  for (let pass = 0; pass < 2; pass++) {
    const exports = new Map<string, Map<string, PathBinding>>();
    facts = new Map();
    for (const file of code) {
      const { text, masked, strings } = lexed.get(file)!;
      const f: FileFacts = { edges: new Set(), reads: new Set(), opaque: [], strings, lists: false };
      facts.set(file, f);
      const dir = posix.dirname(runtime(file));
      // A CommonJS module's own directory and file are paths too.
      const here = { path: norm(dir) ?? '', dir: false };
      const bindings = new Map<string, PathBinding>([
        ['__dirname', here],
        ['__filename', { path: runtime(file), dir: false }],
      ]);
      const readPath = (p: PathBinding) => {
        const repo = source(p.path);
        const stands = repo === '' ? o.wholeRead?.(file) : null;
        if (stands) {
          for (const x of stands) f.reads.add(x);
          return;
        }
        const asCode = p.dir ? null : asFile(repo);
        if (asCode && CODE_EXT.test(asCode)) f.edges.add(asCode);
        f.reads.add(asCode ?? repo);
      };
      const known = (lit: { value: string; partial: boolean }) => (lit.partial && !lit.value.endsWith('/') ? posix.dirname(lit.value) : lit.value);
      const pathOf = (expr: string): PathBinding | null => {
        expr = expr.trim().replace(/\s+as\s+[\w.<>[\]]+$/, '').replace(/!$/, '');
        if (expr === 'import.meta.dirname') return here;
        if (expr === 'import.meta.filename') return { path: runtime(file), dir: false };
        const id = /^([A-Za-z_$][\w$]*)(?:\(\))?$/.exec(expr);
        if (id) return bindings.get(id[1]!) ?? null;
        const call = /^([\w$.]+)\(([\s\S]*)\)((?:\.(?:href|pathname))?)$/.exec(expr);
        if (call && balanced(expr, call[1]!.length) !== call[2]) return null; // f(a)(b), f(a) + g(b): not one call
        if (call && (call[1] === 'fileURLToPath' || call[1] === 'pathToFileURL')) return pathOf(call[2]!);
        if (!call) {
          const m = /^new URL\(([\s\S]*)\)(?:\.(?:href|pathname))?$/.exec(expr);
          if (!m || balanced(expr, 'new URL'.length) !== m[1]) return null;
          const [a, b] = splitArgs(m[1]!);
          const lit = a ? literal(a) : null;
          if (!lit || b !== 'import.meta.url') return null;
          const p = norm(posix.join(dir, known(lit)));
          return p === null ? null : { path: p, dir: lit.partial };
        }
        if (!/^(?:path\.|posix\.)?(?:join|resolve)$/.test(call[1]!) || call[3]) return null;
        const [first, ...rest] = splitArgs(call[2]!);
        const base = first ? pathOf(first) : null;
        if (!base || base.dir) return base;
        let p = base.path;
        for (const r of rest) {
          const lit = literal(r);
          if (!lit) return { path: p, dir: true };
          const n = norm(posix.join(p, known(lit)));
          if (n === null) return null;
          p = n;
          if (lit.partial) return { path: p, dir: true };
        }
        return { path: p, dir: false };
      };
      const importSpec = (spec: string): string | null => {
        if (isPackage(spec)) return null;
        const p = norm(posix.join(dir, spec));
        const hit = p === null ? null : asFile(source(p));
        if (hit) f.edges.add(hit);
        else f.opaque.push(`unresolved import ${spec}`);
        return hit;
      };
      // Static imports, and the path names they bring: a described module's, or another module's exported ones.
      /** Names whose use reaches several paths (a described module's). */
      const charged = new Map<string, PathBinding[]>();
      const imports = staticImports(text, masked);
      if (o.pathModules?.[file]) continue; // described, not scanned: its users are charged what it reaches
      for (const im of imports) {
        const hit = importSpec(im.spec);
        if (!hit) continue;
        const described = o.pathModules?.[hit];
        for (const [local, name] of im.names) {
          if (described && name !== '*' && described[name] !== undefined) {
            const v = described[name]!;
            if (typeof v === 'string') bindings.set(local, { path: v, dir: false });
            else charged.set(local, v.map((path) => ({ path, dir: false })));
          } else if (name === '*') {
            for (const p of exported.get(hit)?.values() ?? []) readPath(p);
          } else {
            const p = exported.get(hit)?.get(name);
            if (p) bindings.set(local, p);
          }
        }
      }
      const imported = new Set([...bindings.keys(), ...charged.keys()]);
      // const NAME = <path expression> (or () => <path expression>): names the rest of the file uses. Its own
      // right-hand side is no read; each use of the name is.
      const defined: [number, number][] = [];
      const mine = new Map<string, PathBinding>();
      for (const m of masked.matchAll(/\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>[\]]+\s*)?=\s*/g)) {
        const from = m.index + m[0].length;
        const end = rhsEnd(masked, from);
        const rhs = text.slice(from, end).replace(/^\(\s*\)\s*=>\s*/, '');
        const p = pathOf(rhs);
        if (!p) continue;
        bindings.set(m[2]!, p);
        mine.set(m[2]!, p);
        defined.push([from, end]);
        if (m[1]) (exports.get(file) ?? exports.set(file, new Map()).get(file)!).set(m[2]!, p);
      }
      // A parameter defaulting to a named path (dir = ROOT) is that path too.
      for (const m of masked.matchAll(/([(,]\s*)([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>[\]|\s]+?)?=\s*([A-Za-z_$][\w$]*)(?=\s*[,)])/g)) {
        const p = bindings.get(m[3]!);
        if (!p) continue;
        bindings.set(m[2]!, p);
        defined.push([m.index + m[1]!.length, m.index + m[0].length]);
      }
      const inDefinition = (i: number) => defined.some(([a, b]) => i >= a && i < b);
      // import(…), require(…), createRequire(…)(…): a module, a path expression, or something this can't follow.
      for (const m of masked.matchAll(/(?<![\w$.])(import|require)\s*\(|createRequire\([^()]*\)\s*\(/g)) {
        const args = balanced(text, m.index + m[0].length - 1);
        if (args === null) continue;
        const arg = splitArgs(args)[0] ?? '';
        const lit = literal(arg);
        const p = lit ? null : pathOf(arg);
        const rel = lit?.partial && lit.value.startsWith('.') ? norm(posix.join(dir, known(lit))) : null;
        if (lit && !lit.partial) importSpec(lit.value);
        else if (rel !== null) readPath({ path: rel, dir: true });
        else if (p) readPath(p);
        else f.opaque.push(`unresolved ${m[1] ?? 'require'}(${arg.slice(0, 80)})`);
      }
      // Every other path expression: new URL('…', import.meta.url), join(<named path>, …).
      for (const m of masked.matchAll(/\bnew URL\(|(?<![\w$.])(?:path\.|posix\.)?(?:join|resolve)\(/g)) {
        if (inDefinition(m.index)) continue;
        const args = balanced(text, m.index + m[0].length - 1);
        if (args === null) continue;
        const p = pathOf(text.slice(m.index, m.index + m[0].length + args.length + 1));
        if (p) readPath(p);
      }
      // A named path used any other way (cwd: root, readFileSync(script), spawn(cli)): a read of all of it. Its own
      // definition, an import of it, join(name, …) (read above) and relative(name, …) aren't uses.
      const uses: [string, PathBinding[]][] = [...[...bindings].map(([n, p]): [string, PathBinding[]] => [n, [p]]), ...charged];
      for (const [name, ps] of uses) {
        for (const m of masked.matchAll(new RegExp(`(?<![\\w$.'"\`])${name.replace(/\$/g, '\\$')}(?![\\w$'"\`])`, 'g'))) {
          if (inDefinition(m.index)) continue;
          const before = masked.slice(Math.max(0, m.index - 200), m.index);
          const after = masked.slice(m.index + name.length, m.index + name.length + 6);
          if (/\b(?:const|let|var)\s+$/.test(before)) continue;
          if (imported.has(name) && /\b(?:import|export)\s*(?:type\s+)?\{[^}]*$/.test(before)) continue;
          if (/(?:join|resolve)\(\s*$/.test(before) && /^(?:\(\))?\s*,/.test(after)) continue;
          if (/\brelative\(\s*$/.test(before)) continue;
          if (mine.has(name) && /\bexport\s*\{[^}]*$/.test(before)) continue;
          // The root as the cwd of a git ls-files: a listing of the files, which only an added file changes.
          const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index) >>> 0);
          if (ps.length === 1 && ps[0]!.path === '' && /['"]ls-files['"]/.test(line)) {
            f.lists = true;
            continue;
          }
          for (const p of ps) readPath(p);
        }
      }
    }
    exported = exports;
  }
  return { files, facts };
}

export interface Plan {
  /** The whole suite: why (the first file that forced it). */
  all: string | null;
  /** The test files to run (every test file when all). */
  tests: string[];
  /** For each selected test, the changed files that selected it ("always" for a test that runs on every change). */
  why: Record<string, string[]>;
}

export interface SelectOptions {
  /** Which files are tests. */
  isTest: (file: string) => boolean;
  /** A changed file that forces the whole suite: why, or null. */
  forceAll?: (file: string) => string | null;
  /** The changed files that are new. Unknown (absent): a test that lists the repo's files runs on every change. */
  added?: ReadonlySet<string>;
}

/** Everything a test reaches: files through edges, and paths read by any of them. */
export function reach(g: Graph, test: string): { files: Set<string>; reads: Set<string>; opaque: string[]; lists: boolean } {
  const seen = new Set<string>([test]);
  const stack = [test];
  const reads = new Set<string>();
  const opaque: string[] = [];
  let lists = false;
  while (stack.length) {
    const f = g.facts.get(stack.pop()!);
    if (!f) continue;
    for (const r of f.reads) reads.add(r);
    opaque.push(...f.opaque);
    lists ||= f.lists;
    for (const e of f.edges) if (!seen.has(e)) (seen.add(e), stack.push(e));
  }
  return { files: seen, reads, opaque, lists };
}

/**
 * Whether a string literal names `f`: the whole literal, a path (no spaces: a message isn't one), ends in f's name
 * at a segment boundary ('x.md', 'docs/x.md', './x.js'; a code file also without its extension).
 */
export function names(s: string, f: string): boolean {
  if (!s || /\s/.test(s)) return false;
  const p = s.replace(/[?#].*$/, '').replace(/^(?:\.{0,2}\/)+/, '').replace(/\/+$/, '');
  if (!p) return false;
  const stem = f.replace(CODE_EXT, '');
  const forms = CODE_EXT.test(f) ? [f, stem, `${stem}.js`, `${stem}.mjs`, `${stem}.cjs`] : [f];
  return forms.some((c) => c === p || c.endsWith(`/${p}`));
}

const covers = (prefix: string, file: string) => prefix !== '' && (file === prefix || file.startsWith(`${prefix}/`));

/**
 * The tests a change selects. `changed` are the change's paths; a path not in the graph's files was deleted (or
 * renamed away), and forces the whole suite.
 */
export function selectTests(g: Graph, changed: readonly string[], o: SelectOptions): Plan {
  const tests = [...g.files].filter(o.isTest).sort();
  const everything = (why: string): Plan => ({ all: why, tests, why: {} });
  const reached = new Map(tests.map((t) => [t, reach(g, t)]));
  for (const f of changed) {
    // The reason is text (the run's summary and its check-run output): each path as shownPath shows it (#683).
    if (!g.files.has(f)) return everything(`${shownPath(f)} was deleted or renamed`);
    const forced = o.forceAll?.(f);
    if (forced) return everything(`${shownPath(f)}: ${forced}`);
    if (SCRIPT_EXT.test(f) || !posix.extname(f)) return everything(`${shownPath(f)} is a script or has no extension: what runs it, or what it runs, isn't traced`);
  }
  const why: Record<string, string[]> = {};
  const pick = (t: string, by: string) => (why[t] ??= []).push(by);
  for (const [t, r] of reached) {
    if (r.reads.has('')) pick(t, 'always: reads the whole repo');
    else if (r.lists && (!o.added || changed.some((f) => o.added!.has(f)))) pick(t, o.added ? 'lists the repo\'s files, and the change adds one' : 'always: lists the repo\'s files');
    else if (r.opaque.length) pick(t, `always: ${r.opaque[0]}`);
  }
  for (const f of changed) {
    let placed = false;
    for (const [t, r] of reached) {
      if (r.files.has(f) || [...r.reads].some((p) => covers(p, f))) {
        placed = true;
        if (!why[t]?.[0]?.startsWith('always')) pick(t, f);
      }
    }
    // Named in some string but reached by no import or read: something builds its path this can't see. A code
    // file reached by an import is placed; a data file is checked either way (a template could read it too).
    if (placed && CODE_EXT.test(f)) continue;
    for (const [file, facts] of g.facts) {
      if (file === f || facts.edges.has(f) || [...facts.reads].some((p) => covers(p, f))) continue;
      const s = facts.strings.find((x) => names(x, f));
      if (s !== undefined) return everything(`${shownPath(f)} is named in ${shownPath(file)} ('${s}'), and no import or read this can follow reaches it`);
    }
    // Reached by nothing: a file this can't place (an entry point, a fixture read some other way), unless it is
    // documentation that no code names.
    if (!placed && !/\.md$/i.test(f)) return everything(`no import or read this can follow reaches ${shownPath(f)}`);
  }
  const sel = Object.keys(why).sort();
  return { all: null, tests: sel, why };
}
