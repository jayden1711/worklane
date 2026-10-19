// A slot-dir path is a SlotPath (#772): an opaque value that only src/slot-file.ts turns back into the path, so tsc
// rejects one handed to any writer but writeSlotFile, whatever the call chain. This file holds that in place:
// - tsc, fed source text (no file is written): a slot path passed through a `mixed` module's parameter to another
//   module's writer (#772's case C), kept in a property under another name (P1, P3), assigned to a local later (P4),
//   returned by a local function (P6), or given to a method of a value not traced to its module (U1 to U3), and the
//   forms #766's lint doesn't resolve (U4 to U6b, B10c, R8): each fails to compile, and the same text with a plain
//   path compiles (a control).
// - checks over src/, each tested against fixture text fed to its own function:
//   - only src/os/index.ts makes a slot path (slotPathOf) or names the test seam slotsDirFor; slotsDir takes no
//     argument; no module but the helper imports or re-exports the helper or os/index.js whole; every specifier is a
//     plain relative path to an existing src/ module or a builtin or dependency name (no import-equals, query, hash,
//     %-encoding, absolute path, URL, path out of src/ or package `..`; "resolves exactly" was false through ef30db6e,
//     #806 round 5); no eval, Function, node:vm or Worker but from a src/ module; and src/ holds no symlink. These are
//     defence in depth: what keeps a guess from being tested against the slot dir is the design (no slot path is equal
//     to another: the run-time tests), not these checks;
//   - nothing patches a built-in prototype or Error.prepareStackTrace in its plain forms;
//   - nothing reads private fields or the heap from inside the process (node:inspector, a heap snapshot);
//   - only src/os/index.ts and src/os/system-paths.ts read where the slot dir is (AGENT_SLOTS_DIR, SYSTEM_SLOTS, the
//     `agent-slots` name);
//   - no cast to or from a slot path, and no string conversion of one (a template literal, String(), `+`);
//   - fs is reached only through imports tsc types: no require, createRequire, getBuiltinModule, process.binding, and
//     no import() of fs or of a name not written out;
// - the value at run time: fs, path.join, String() and a template literal refuse it, nothing prints its path, an
//   error from a slot file names no path, and a forged one (its prototype, its constructor, a Proxy) is refused.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { test } from 'node:test';
import { inspect } from 'node:util';
import ts from 'typescript';
import { repoRoot } from './helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// tsc over src/, with fixture text in place of (or beside) its files

function srcFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.set(relative(repoRoot, p).split(sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(repoRoot, 'src'));
  return out;
}

/**
 * The symlinks under `root` (paths relative to it). The checks read a module by the path written in its specifier; a
 * symlink would give the helper or os/index.ts a second name they don't know (Node loads the link's target, #806
 * round 5). src/ has none.
 */
function symlinksUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) out.push(relative(root, p).split(sep).join('/'));
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

const OPTIONS: ts.CompilerOptions = (() => {
  const cfg = ts.readConfigFile(join(repoRoot, 'tsconfig.json'), (f) => ts.sys.readFile(f));
  return { ...ts.parseJsonConfigFileContent(cfg.config, ts.sys, repoRoot).options, noEmit: true };
})();

let previous: ts.Program | undefined;

/** A program over src/ as `files` has it (path relative to the repo root → text). */
function program(files: Map<string, string>): ts.Program {
  const abs = new Map([...files].map(([f, t]) => [join(repoRoot, f), t]));
  const host = ts.createCompilerHost(OPTIONS, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => (abs.has(name) ? ts.createSourceFile(name, abs.get(name)!, lang, true) : getSourceFile(name, lang, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => abs.has(name) || fileExists(name);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => abs.get(name) ?? readFile(name);
  previous = ts.createProgram({ rootNames: [...abs.keys()], options: OPTIONS, host, ...(previous ? { oldProgram: previous } : {}) });
  return previous;
}

interface Diag {
  line: number;
  code: number;
  text: string;
}

/** tsc's errors in one file (path relative to the repo root), by line (1-based). */
function errorsIn(p: ts.Program, file: string): Diag[] {
  const sf = p.getSourceFile(join(repoRoot, file));
  assert.ok(sf, `${file} is in the program`);
  return ts.getPreEmitDiagnostics(p, sf).map((d) => ({ line: sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1, code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
}

// The fixtures. `slot` is the expression that gives the slot dir; the control puts a plain path there instead.
const STORE = 'src/fixture-store-772.ts';
const STORE_TEXT = "import { writeFileSync } from 'node:fs';\nexport class Store {\n  save(file: string) {\n    writeFileSync(file, 'x');\n  }\n}\n";

/** Appended to src/dashboard.ts (a `mixed` module): [case, line]. Each line hands the slot dir on toward a writer. */
const mixedCases = (slot: string): [string, string][] => [
  ['C: a parameter, to another module\'s writer', `export const c772 = (o: DashboardOptions) => cWrites772(${slot});`],
  ['P1: a property under another name (this.dir)', `class P1x772 { dir = ''; constructor(o: DashboardOptions) { this.dir = ${slot}; } save() { wgo772(pj772(this.dir, 'p1.json'), '{}'); } }`],
  ['P3: a property of an object under another name (cfg.d)', `export const p3772 = (o: DashboardOptions) => { cfg772.d = ${slot}; wgo772(pj772(cfg772.d, 'p3.json'), '{}'); };`],
  ['P4: a local assigned after its declaration', `export function p4772(o: DashboardOptions) { let d = ''; d = ${slot}; wgo772(pj772(d, 'p4.json'), '{}'); }`],
  ['P6: a slot dir returned by a local function', `export function p6772(o: DashboardOptions) { const pick = () => ${slot}; const d = pick(); wgo772(pj772(d, 'p6.json'), '{}'); }`],
  ['U1: a method on a parameter', `export const u1772 = (s: S772, o: DashboardOptions) => s.save(${slot});`],
  ['U2: a method on this.store', `class U2x772 { constructor(private readonly store: S772) {} run(o: DashboardOptions) { this.store.save(pj772(${slot}, 'u2.json')); } }`],
  ['U3: a method on a call\'s result', `export const u3772 = (o: DashboardOptions) => mk772().save(pj772(${slot}, 'u3.json'));`],
];
const MIXED_HEAD = [
  "import { writeGroupOnly as wgo772, slotsDir as sd772 } from './os/index.js';",
  "import { join as pj772 } from 'node:path';",
  "import { Store as S772 } from './fixture-store-772.js';",
  "export function cWrites772(dir: string) { wgo772(pj772(dir, 'x.json'), '{}'); }",
  "const cfg772 = { d: '' };",
  'const mk772 = () => new S772();',
];

/** Appended to src/slots.ts (a `writer` module): the forms #766's lint doesn't resolve, with a slot-dir path. */
const writerCases = (slot: string): [string, string][] => [
  ['U4: a method by element access', `export const u4772 = (o: { st: S772 }) => o.st['save'](j772(${slot}, 'u4.json'));`],
  ['U5: a method through .call', `export const u5772 = () => st5772.save.call(st5772, j772(${slot}, 'u5.json'));`],
  ['U6: a writer function through .call', `export const u6772 = () => wg772.call(undefined, j772(${slot}, 'u6.json'), '{}');`],
  ['U6b: an fs function through .call', `export const u6b772 = () => fsc772.writeFileSync.call(fsc772, j772(${slot}, 'u6b.json'), '');`],
  ['U6b: an fs function through .apply', `export const u6c772 = () => fsc772.appendFileSync.apply(fsc772, [j772(${slot}, 'u6c.json'), '']);`],
  ['B10c: an fs function through Reflect.apply', `export const b10c772 = () => Reflect.apply(fsc772.writeFileSync, undefined, [j772(${slot}, 'b10c.json'), 'x']);`],
  ['R8: fs typed any (createRequire), a slot-dir path', `export const r8772 = (rw8: any) => rw8(j772(${slot}, 'r8.json'), '');`],
  ['a slot path itself, to writeFileSync', `export const d1772 = () => fsc772.writeFileSync(${slot}, '');`],
  ['a slot path itself, to a writer through .call', `export const d2772 = () => wg772.call(undefined, ${slot}, '{}');`],
];
const WRITER_HEAD = [
  "import * as fsc772 from 'node:fs';",
  "import { join as j772 } from 'node:path';",
  "import { slotsDir as sd772, writeGroupOnly as wg772 } from './os/index.js';",
  "import { Store as S772 } from './fixture-store-772.js';",
  'const st5772 = new S772();',
];

/** src/ with the fixtures appended; each case's file and line. */
function withFixtures(mixedSlot: string, writerSlot: string): { files: Map<string, string>; at: { name: string; file: string; line: number }[] } {
  const files = srcFiles();
  const at: { name: string; file: string; line: number }[] = [];
  const append = (file: string, head: string[], cases: [string, string][]) => {
    const before = files.get(file)!;
    // `before` ends in a newline, and one more is added before the head: its last line is at split length + 1.
    const start = before.split('\n').length + 1 + head.length;
    cases.forEach(([name], i) => at.push({ name, file, line: start + i }));
    files.set(file, `${before}\n${head.join('\n')}\n${cases.map(([, text]) => text).join('\n')}\n`);
  };
  append('src/dashboard.ts', MIXED_HEAD, mixedCases(mixedSlot));
  append('src/slots.ts', WRITER_HEAD, writerCases(writerSlot));
  files.set(STORE, STORE_TEXT);
  return { files, at };
}

test('tsc: a slot path reaches no writer but writeSlotFile, through a mixed module\'s parameter, a property, a local or a method (#772: C, P1, P3, P4, P6, U1 to U6b, B10c, R8)', () => {
  const { files, at } = withFixtures('(o.slotsDir ?? sd772())', 'sd772()');
  const p = program(files);
  const errors = new Map(['src/dashboard.ts', 'src/slots.ts'].map((f) => [f, errorsIn(p, f)]));
  const missed = at.filter((c) => !errors.get(c.file)!.some((d) => d.line === c.line && (d.code === 2345 || d.code === 2322 || d.code === 2769) && /SlotPath/.test(d.text)));
  assert.deepEqual(missed.map((c) => `${c.name} (${c.file}:${c.line})`), [], 'each case fails to compile: a slot path is not a string');
  const other = [...errors].flatMap(([f, ds]) => ds.filter((d) => !at.some((c) => c.file === f && c.line === d.line)).map((d) => `${f}:${d.line}: TS${d.code} ${d.text}`));
  assert.deepEqual(other, [], 'and nothing else in either file fails');
});

test("tsc: slotsDir takes no system, through .call or an alias either (#806 round-3 review, the mark oracle)", () => {
  const files = srcFiles();
  const before = files.get('src/slots.ts')!;
  const cases = [
    "export const m1772 = (g: string) => sd772.call(undefined, { dir: g, config: '' });",
    "export const m2772 = (g: string) => f772({ dir: g, config: '' });",
    "export const m3772 = (g: string) => Reflect.apply(sd772, undefined, [{ dir: g, config: '' }]) as unknown;",
  ];
  const head = ["import { slotsDir as sd772 } from './os/index.js';", 'const f772 = sd772;'];
  files.set('src/slots.ts', `${before}\n${head.join('\n')}\n${cases.join('\n')}\n`);
  const start = before.split('\n').length + 1 + head.length;
  const errors = errorsIn(program(files), 'src/slots.ts');
  // .call and the alias fail to compile; Reflect.apply's arguments are `any`, and at run time slotsDir ignores them
  // (the run-time test below).
  assert.deepEqual([0, 1].filter((i) => !errors.some((d) => d.line === start + i)), [], errors.map((d) => `${d.line}: TS${d.code} ${d.text}`).join('\n'));
});

test('tsc: the same fixtures with a plain path where the slot dir was compile (a control: the fixture text is valid TypeScript)', () => {
  const { files } = withFixtures("'/a/state/dir'", "'/a/state/dir'");
  const p = program(files);
  for (const f of ['src/dashboard.ts', 'src/slots.ts', STORE]) assert.deepEqual(errorsIn(p, f).map((d) => `${d.line}: TS${d.code} ${d.text}`), [], f);
});

// ---------------------------------------------------------------------------------------------------------------
// The checks

interface Finding {
  file: string;
  line: number;
  what: string;
}

const HELPER = 'src/slot-file.ts';
/** The module that makes slot paths (slotPathOf), and the only one that reads where the slot dir is. */
const MAKER = 'src/os/index.ts';
/**
 * Names only the maker uses: slotPathOf and slotDirAt make a slot path from a string; slotsDirFor is slotsDir with a
 * `system` of the caller's (tests'), so any mention of it elsewhere (a call, an alias, `.call`, a callback) is
 * reported, not only a call with an argument (#806 round-3 review, the mark oracle).
 */
const MAKER_ONLY = new Set(['slotPathOf', 'slotDirAt', 'slotsDirFor']);
/** Where the slot dir's location may be read: the maker, and the system paths it reads it from. */
const SLOT_SOURCES = new Set([MAKER, 'src/os/system-paths.ts']);
const SOURCE_NAMES = new Set(['AGENT_SLOTS_DIR', 'SYSTEM_SLOTS', 'devSlotsPath', 'unguardedSlotsDir']);

const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const nameText = (n: ts.Node): string | null => (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? n.text : ts.isStringLiteralLike(n) ? n.text : null);

/** The helper and os/index.ts, as src/ paths: a namespace of either reads MAKER_ONLY by a computed name. */
const WHOLE_MODULES = new Set(['src/slot-file.js', 'src/os/index.js']);
/**
 * A specifier `target` resolves exactly: a plain relative path (`./a/b.js`, `../c.js`: letters, digits, `_`, `.`,
 * `-` and `/` only) or a package or builtin name (`yaml`, `@scope/pkg/sub`, `node:fs`). Nothing with `?`, `#`, `%`, a
 * leading `/`, a scheme other than `node:`, or a backslash.
 */
const PLAIN_SPECIFIER = /^(\.\.?(\/[A-Za-z0-9_.-]+)+|(node:)?@?[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)*)$/;
/** The src/ path an import's specifier in `file` names (`./index.js` in src/os/ is src/os/index.js), or null. */
const target = (file: string, spec: string) => (spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), spec)) : null);

/** The src/ modules on disk, as `src/…/x.ts` (read once). */
let srcOnDisk: ReadonlySet<string> | undefined;
const knownSrc = (): ReadonlySet<string> => (srcOnDisk ??= new Set(srcFiles().keys()));

/** Package names src/ may import: package.json `dependencies` (#806 round-5 review, B4). */
const DEPENDENCIES = new Set(Object.keys((JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}));

/**
 * Why a plain specifier doesn't name a module this check knows, or null when it does (#806 round-5 review):
 * - a relative one must name an existing src/ module, its `.js` standing for that module's `.ts`, in exact case. A
 *   path out of src/ (`../../dist/src/…`, `../test/…`) is resolved by Node against dist/src/, where the check can't
 *   follow it;
 * - a package one is `node:<builtin>`, a builtin, or a package.json dependency, with no `.` or `..` segment (a
 *   package's subpath can walk out of its directory: `@scope/pkg/../../../dist/src/os/index.js`).
 */
function unknownTarget(file: string, spec: string, known: ReadonlySet<string>): string | null {
  const t = target(file, spec);
  if (t !== null) {
    if (!t.startsWith('src/') || !t.endsWith('.js')) return 'names no src/ module (Node resolves it against dist/src/, out of what this check reads)';
    return known.has(`${t.slice(0, -3)}.ts`) ? null : 'names no existing src/ module (exact case, its .js for the .ts)';
  }
  const parts = spec.split('/');
  if (parts.some((p) => p === '.' || p === '..')) return 'a package path with a . or .. segment can walk out of the package';
  const name = spec.startsWith('node:') ? spec.slice(5) : spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  if (spec.startsWith('node:') ? isBuiltin(spec) : isBuiltin(name) || DEPENDENCIES.has(name)) return null;
  return 'is no builtin and no package.json dependency';
}

/**
 * Who makes a slot path, or a way to its path, in every src/ module but the helper (no scope for the OS layer: #806
 * round-2 review, principle 9). MAKER_ONLY names only in the maker (and the helper, which defines them). No call
 * passes slotsDir an argument (its `system` would make a slot path of any directory: A3). No `import *` or `import()`
 * of the helper or of os/index.js.
 */
function slotPathMakers(files: Map<string, string>, known: ReadonlySet<string> = new Set([...knownSrc(), ...[...files.keys()].filter((f) => f.endsWith('.ts'))])): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    if (file === HELPER) continue;
    const sf = parse(file, text);
    const whole = (spec: string) => WHOLE_MODULES.has(target(file, spec) ?? '');
    // Report what `target` doesn't resolve the way Node does (#806 round-4 review): a specifier in any form that isn't a
    // plain relative path or a package name (`?x`/`#x` load a second instance of a module; an absolute path, a `file:`
    // URL or %-encoding name a module by another spelling), and a plain one that names no module this check reads
    // (round-5 review: a path out of src/, or a package path walking out of its package).
    const plainOnly = (n: ts.Node, spec: string) => {
      if (!PLAIN_SPECIFIER.test(spec)) at(n, `${JSON.stringify(spec)}: a module specifier this check can't resolve exactly (a query, a hash, %-encoding, an absolute path or a URL): use a plain relative path or a package name`);
      else {
        const why = unknownTarget(file, spec, known);
        if (why) at(n, `${JSON.stringify(spec)}: ${why}`);
      }
    };
    const at = (n: ts.Node, what: string) => out.push({ file, line: lineOf(sf, n), what });
    /** The names slotsDir goes by here: its own, and any it is imported as. */
    const slotsDirNames = new Set(['slotsDir']);
    const collect = (n: ts.Node) => {
      if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'slotsDir') slotsDirNames.add(n.name.text);
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const visit = (n: ts.Node) => {
      const name = nameText(n);
      if (name && MAKER_ONLY.has(name) && file !== MAKER) at(n, `${name}: only ${MAKER} makes a slot path`);
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) plainOnly(n, n.moduleSpecifier.text);
      // `import x = require('…')`: tsc emits a createRequire, which loads the same instance (#806 round-4 review). src/
      // has none, so every one is reported, whatever it names.
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) at(n, `${n.getText(sf).slice(0, 60)}: import = require is a require; import the module with import`);
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && whole(n.moduleSpecifier.text) && n.importClause?.namedBindings && ts.isNamespaceImport(n.importClause.namedBindings)) at(n, `import * from ${n.moduleSpecifier.text}: import its functions by name`);
      // A re-export of the whole module is the same namespace, one import away (#806 round-3 review, A8).
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && whole(n.moduleSpecifier.text) && (!n.exportClause || ts.isNamespaceExport(n.exportClause))) at(n, `export *${n.exportClause ? ' as' : ''} from ${n.moduleSpecifier.text}: re-export its functions by name`);
      if (ts.isCallExpression(n)) {
        const a = n.arguments[0];
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword && a && ts.isStringLiteralLike(a) && whole(a.text)) at(n, 'import() of slot-file.js or os/index.js: import its functions by name');
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (a && ts.isStringLiteralLike(a)) plainOnly(n, a.text);
          else at(n, 'import() of a name not written out: this check can\'t tell which module it loads');
        }
        const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null;
        const isSlotsDir = ts.isIdentifier(n.expression) ? slotsDirNames.has(n.expression.text) : callee === 'slotsDir';
        if (isSlotsDir && n.arguments.length > 0) at(n, `${n.getText(sf).slice(0, 60)}: slotsDir's system argument is for tests only (with any other, it makes a slot path of any directory)`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Names that reach a prototype or V8's stack hook. */
const PROTO_NAMES = new Set(['__proto__', 'getPrototypeOf', 'setPrototypeOf', 'prepareStackTrace']);

/**
 * What patches a built-in from src/ (#806 round-2 review, 3b): any `.prototype` (a getter put on String.prototype or
 * Object.prototype as `href` is read by fs on every path it is given, a slot path's included; a method there is handed
 * its `this`), `__proto__`, get/setPrototypeOf (a prototype reached around `.prototype`), and Error.prepareStackTrace
 * (handed every error's frames). src/ has none of these but the helper's own class, which is skipped.
 */
function builtinPatches(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    if (file === HELPER) continue;
    const sf = parse(file, text);
    const hit = (k: string | null) => k !== null && (k === 'prototype' || PROTO_NAMES.has(k));
    const visit = (n: ts.Node) => {
      let found = false;
      // `x.prototype`, `x['prototype']`, `Object.getPrototypeOf`, `Error.prepareStackTrace`: the access, once.
      if (ts.isPropertyAccessExpression(n)) found = hit(n.name.text);
      else if (ts.isElementAccessExpression(n)) found = hit(nameText(n.argumentExpression));
      // A bare name (an import of setPrototypeOf, a `__proto__:` key), or a string (`defineProperty(Error,
      // 'prepareStackTrace')`, `Reflect.get(String, 'prototype')`), but not the name or key of an access above.
      else if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) found = PROTO_NAMES.has(n.text);
      else if (ts.isStringLiteralLike(n) && !(ts.isElementAccessExpression(n.parent) && n.parent.argumentExpression === n)) found = hit(n.text);
      if (found) out.push({ file, line: lineOf(sf, n), what: `${n.getText(sf).slice(0, 60)}: reaches a built-in's prototype or V8's stack hook, where a getter or method is handed the paths fs is given` });
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Code that loads code the specifier check never sees (#806 round-5 review, D1 to D4): `eval`, `Function` (called,
 * constructed or passed on), `node:vm`, and a Worker but one started from `new URL('<a plain relative path to an
 * existing src/ module>', import.meta.url)` without `eval`. src/ has none but setup-steps.ts's setup-worker Worker.
 * Not seen (Known gaps; closed by design instead: no slot path compares equal to another): a function's
 * `.constructor`, `globalThis['ev' + 'al']`.
 */
function dynamicCode(files: Map<string, string>, known: ReadonlySet<string> = new Set([...knownSrc(), ...[...files.keys()].filter((f) => f.endsWith('.ts'))])): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    const sf = parse(file, text);
    const at = (n: ts.Node, what: string) => out.push({ file, line: lineOf(sf, n), what });
    const isName = (n: ts.Identifier) => !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) && !ts.isTypeReferenceNode(n.parent);
    /** A Worker's script is `new URL('<plain relative path to a known src/ module>', import.meta.url)`. */
    const knownScript = (a: ts.Expression | undefined) => {
      if (!a || !ts.isNewExpression(a) || !ts.isIdentifier(a.expression) || a.expression.text !== 'URL') return false;
      const [p, b] = a.arguments ?? [];
      return !!p && ts.isStringLiteralLike(p) && PLAIN_SPECIFIER.test(p.text) && p.text.startsWith('.') && unknownTarget(file, p.text, known) === null && !!b && b.getText(sf) === 'import.meta.url';
    };
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && (n.text === 'eval' || n.text === 'Function') && isName(n)) at(n, `${n.text}: runs code this check can't see (it can load any module)`);
      if (ts.isPropertyAccessExpression(n) && (n.name.text === 'eval' || n.name.text === 'Function') && ts.isIdentifier(n.expression) && ['globalThis', 'global', 'window', 'self'].includes(n.expression.text)) at(n, `${n.getText(sf)}: runs code this check can't see`);
      const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) ? n.arguments[0].text : null;
      if (spec === 'vm' || spec === 'node:vm') at(n, `${spec}: runs code this check can't see`);
      if (ts.isNewExpression(n) && (ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : '') === 'Worker') {
        const [script, opts] = n.arguments ?? [];
        const evalOpt = !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => p.name?.getText(sf) === 'eval' || ts.isSpreadAssignment(p));
        if (!knownScript(script) || evalOpt || (opts && !ts.isObjectLiteralExpression(opts))) at(n, `${n.getText(sf).slice(0, 60)}: a Worker runs a src/ module only, from new URL('./<module>.js', import.meta.url), without eval`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const INSPECTORS = new Set(['inspector', 'node:inspector', 'inspector/promises', 'node:inspector/promises']);
const HEAP_SNAPSHOTS = new Set(['getHeapSnapshot', 'writeHeapSnapshot']);

/**
 * What reads a value's private fields from inside the process (#806 review, A4): the inspector (its
 * Runtime.getProperties lists them) and a heap snapshot (it holds every string). Neither is used in src/.
 */
function introspection(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    const sf = parse(file, text);
    const at = (n: ts.Node, what: string) => out.push({ file, line: lineOf(sf, n), what });
    const visit = (n: ts.Node) => {
      const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) ? n.arguments[0].text : null;
      if (spec && INSPECTORS.has(spec)) at(n, `${spec}: reads private fields (a slot path's included) from inside the process`);
      const name = ts.isIdentifier(n) ? n.text : null;
      if (name && HEAP_SNAPSHOTS.has(name) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) at(n, `${name}: a heap snapshot holds every string, a slot path's included`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Who reads where the slot dir is: only SLOT_SOURCES. Comments don't count; a name or a string anywhere else does. */
function rawSlotSources(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    if (SLOT_SOURCES.has(file)) continue;
    const sf = parse(file, text);
    const visit = (n: ts.Node) => {
      const name = ts.isIdentifier(n) ? n.text : null;
      const literal = ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : null;
      if (name && SOURCE_NAMES.has(name)) out.push({ file, line: lineOf(sf, n), what: `${name}: only ${[...SLOT_SOURCES].join(' and ')} read where the slot dir is (slotsDir() gives it as a slot path)` });
      if (literal !== null && (SOURCE_NAMES.has(literal) || /agent-slots|AGENT_SLOTS_DIR/.test(literal))) out.push({ file, line: lineOf(sf, n), what: `${JSON.stringify(literal)}: names where the slot dir is; only ${[...SLOT_SOURCES].join(' and ')} do` });
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
/** Calls that reach a module, or fs's internals, with a type tsc can't check (any). */
const UNTYPED_LOADERS = new Set(['require', 'createRequire', 'getBuiltinModule', 'binding', '_linkedBinding']);

/** fs reached around the imports tsc types: by a loader, or by import() of fs or of a name not written out. */
function untypedFs(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    const sf = parse(file, text);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const callee = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) ? nameText(e.argumentExpression) : null;
        if (callee && UNTYPED_LOADERS.has(callee)) out.push({ file, line: lineOf(sf, n), what: `${callee}(…): reaches a module untyped (any), where a slot path or a write isn't checked; import it instead` });
        // A function patched onto fs's (or path's) exports object reaches the helper's own imports only through this:
        // it would be handed the paths src/slot-file.ts opens.
        if (callee === 'syncBuiltinESMExports') out.push({ file, line: lineOf(sf, n), what: "syncBuiltinESMExports(): rebinds a builtin's named imports, src/slot-file.ts's included" });
        if (e.kind === ts.SyntaxKind.ImportKeyword) {
          const a = n.arguments[0];
          if (!a || !ts.isStringLiteralLike(a)) out.push({ file, line: lineOf(sf, n), what: 'import() of a name not written out: tsc can\'t type it' });
          else if (FS_MODULES.has(a.text)) out.push({ file, line: lineOf(sf, n), what: `import('${a.text}'): import fs statically` });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Whether a type is, or has in a union or intersection, src/slot-file.ts's SlotPath. */
function isSlotPathType(t: ts.Type): boolean {
  if (t.isUnionOrIntersection()) return t.types.some(isSlotPathType);
  const s = t.getSymbol() ?? t.aliasSymbol;
  return !!s && s.getName() === 'SlotPath' && !!s.declarations?.some((d) => d.getSourceFile().fileName.endsWith(`${sep}slot-file.ts`) || d.getSourceFile().fileName.endsWith('/slot-file.ts'));
}

/** Casts to or from a slot path, and conversions of one to a string, in `only` (default: every file but the helper). */
function slotPathConversions(p: ts.Program, only?: Set<string>): Finding[] {
  const checker = p.getTypeChecker();
  const out: Finding[] = [];
  for (const sf of p.getSourceFiles()) {
    const file = relative(repoRoot, sf.fileName).split(sep).join('/');
    if (!file.startsWith('src/') || file === HELPER || (only && !only.has(file))) continue;
    const slot = (n: ts.Node) => isSlotPathType(checker.getTypeAtLocation(n));
    const at = (n: ts.Node, what: string) => out.push({ file, line: lineOf(sf, n), what });
    const visit = (n: ts.Node) => {
      if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
        if (slot(n.type) || slot(n.expression)) at(n, `${n.getText(sf).slice(0, 80)}: a cast to or from a slot path (it is made only by ${MAKER} and read only by ${HELPER})`);
      } else if (ts.isTemplateSpan(n) && slot(n.expression)) at(n, `\`\${${n.expression.getText(sf)}}\`: a slot path to a string (it throws at run time)`);
      else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.PlusToken || n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) && (slot(n.left) || slot(n.right))) at(n, `${n.getText(sf).slice(0, 80)}: a slot path to a string (it throws at run time)`);
      else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'String' && n.arguments.some(slot)) at(n, `${n.getText(sf).slice(0, 80)}: a slot path to a string (it throws at run time)`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const show = (f: Finding[]) => f.map((x) => `${x.file}:${x.line}: ${x.what}`);

test('src/: only os/index.ts makes a slot path or opens one, no module passes slotsDir a system, and only the OS layer reads where the slot dir is', () => {
  const files = srcFiles();
  assert.deepEqual(show([...slotPathMakers(files), ...rawSlotSources(files)]), []);
});

test('src/: nothing reads private fields or the heap from inside the process (node:inspector, a heap snapshot)', () => {
  assert.deepEqual(show(introspection(srcFiles())), []);
});

test('src/: no cast to or from a slot path, and no conversion of one to a string', () => {
  assert.deepEqual(show(slotPathConversions(program(srcFiles()))), []);
});

test('src/: fs is reached only through imports tsc types (no require, createRequire, getBuiltinModule, process.binding, import() of fs)', () => {
  assert.deepEqual(show(untypedFs(srcFiles())), []);
});

test('the maker check: another module making a slot path, opening one, passing slotsDir a system, or reading the helper or os/index.js by a computed name, is reported', () => {
  const files = new Map([
    ['src/cores.ts', "import { slotPathOf as mk } from './slot-file.js';\nexport const a = mk('/var/lib/x/agent-slots');\n"],
    ['src/dashboard.ts', "import { slotDirAt } from './os/index.js';\nexport const b = slotDirAt('/x');\n"],
    ['src/health.ts', "import * as sf from './slot-file.js';\nexport const c = (sf as Record<string, (d: string) => unknown>)['slotPath' + 'Of']!('/x');\nexport const d = import('./slot-file.js');\n"],
    // demo.ts names no exception now (#806 review, principle 9): its own slot dir is a plain path.
    ['src/demo.ts', "import { slotDirAt } from './os/index.js';\nexport const e = slotDirAt('/demo');\n"],
    // A3: slotsDir with a system of the caller's, under its own name and renamed; and the A8 namespace route.
    ['src/slots.ts', "import { slotsDir, slotsDir as sd } from './os/index.js';\nexport const h = (dir: string) => slotsDir({ dir, config: '' });\nexport const i = (dir: string) => sd({ dir, config: '' });\nexport const j = () => slotsDir();\n"],
    ['src/health2.ts', "import * as os from './os/index.js';\nexport const k = (g: string) => (os as unknown as Record<string, (d: string) => unknown>)['slot' + 'DirAt']!(g) === os.slotsDir();\nexport const l = (dir: string) => os.slotsDir({ dir, config: '' });\n"],
    // The OS layer has no scope (#806 round-2 review, principle 9): the maker may name slotPathOf, and nothing else.
    [MAKER, "import { slotPathOf } from '../slot-file.js';\nexport const f = slotPathOf('/x');\nexport const m = (dir: string) => slotsDir({ dir, config: '' });\n"],
    ['src/os/system-paths.ts', "import * as os from './index.js';\nexport const n = () => os.slotsDir({ dir: '/x', config: '' });\n"],
    ['src/os/stats.ts', "import * as sf from '../slot-file.js';\nexport const o = (g: string) => (sf as unknown as Record<string, (d: string) => unknown>)['slotPath' + 'Of']!(g);\nexport const p = () => import('../slot-file.js');\nexport const q = () => import('./index.js');\n"],
    // #806 round 3, A8 through a re-export: the re-export is reported; the module that uses it imports a name from a
    // module that is neither, which the check can't follow (its source is reported instead).
    ['src/reexp.ts', "export * as osns from './os/index.js';\nexport * from './os/index.js';\nexport * from './slot-file.js';\nexport { slotsDirFor } from './os/index.js';\n"],
    ['src/use-reexp.ts', "import { osns } from './reexp.js';\nimport * as r from './reexp.js';\nexport const s = (g: string) => (osns as unknown as Record<string, (d: string) => unknown>)['slot' + 'DirAt']!(g) === (r as unknown as Record<string, (d: string) => unknown>)['slot' + 'DirAt']!(g);\n"],
    // The mark oracle: slotsDirFor in any form outside os/index.ts (slotsDir itself takes no argument now).
    ['src/github/budget.ts', "import { slotsDirFor, slotsDir } from '../os/index.js';\nconst f = slotsDirFor;\nexport const t = (dir: string) => [slotsDirFor.call(undefined, { dir, config: '' }), [{ dir, config: '' }].map(f), slotsDir()];\n"],
  ]);
  assert.deepEqual(show(slotPathMakers(files)).map((l) => l.replace(/^(.*?:\d+: [^:]*?)(: |\(…|\(\{).*$/, '$1')), [
    'src/cores.ts:1: slotPathOf',
    'src/dashboard.ts:1: slotDirAt',
    'src/dashboard.ts:2: slotDirAt',
    'src/health.ts:1: import * from ./slot-file.js',
    'src/health.ts:3: import() of slot-file.js or os/index.js',
    'src/demo.ts:1: slotDirAt',
    'src/demo.ts:2: slotDirAt',
    'src/slots.ts:2: slotsDir',
    'src/slots.ts:3: sd',
    'src/health2.ts:1: import * from ./os/index.js',
    'src/health2.ts:3: os.slotsDir',
    'src/os/index.ts:3: slotsDir',
    'src/os/system-paths.ts:1: import * from ./index.js',
    'src/os/system-paths.ts:2: os.slotsDir',
    'src/os/stats.ts:1: import * from ../slot-file.js',
    'src/os/stats.ts:3: import() of slot-file.js or os/index.js',
    'src/os/stats.ts:4: import() of slot-file.js or os/index.js',
    'src/reexp.ts:1: export * as from ./os/index.js',
    'src/reexp.ts:2: export * from ./os/index.js',
    'src/reexp.ts:3: export * from ./slot-file.js',
    'src/reexp.ts:4: slotsDirFor',
    'src/github/budget.ts:1: slotsDirFor',
    'src/github/budget.ts:2: slotsDirFor',
    'src/github/budget.ts:3: slotsDirFor',
  ]);
  // cores.ts:2 (`mk(…)`, the renamed import) is the import's line: the name is caught where it is imported.
});

test("the maker check: a specifier it can't resolve exactly, in any form, and every import-equals are reported (#806 round-4 review)", () => {
  const lines = [
    "import osx = require('./os/index.js');",
    "import sfx = require('./slot-file.js');",
    "import * as q1 from './os/index.js?x';",
    "import * as q2 from './os/index.js#x';",
    "export * as q3 from './os/index.js?x';",
    "export { slotsDir as q4 } from './os/index.js#y';",
    "export const q5 = () => import('./os/index.js?x');",
    "export const q6 = () => import('./os/index.js#x');",
    "export const q7 = () => import('./os/%69ndex.js');",
    "export const q8 = () => import('/abs/src/os/index.js');",
    "export const q9 = () => import('file:///abs/src/os/index.js');",
    'export const q10 = (u: URL) => import(u.href);',
    'export const q11 = () => import(`./os/index.js`);',
    "import { slotsDir } from './os/index.js';",
    "import yaml from 'yaml'; import { join } from 'node:path'; import { SandboxManager } from '@anthropic-ai/sandbox-runtime';",
    "import '#internal';",
    "import w from '.\\\\os\\\\index.js';",
    'void [osx, sfx, q1, q2, slotsDir, yaml, join, SandboxManager, w];',
  ];
  const found = slotPathMakers(new Map([['src/cores.ts', lines.join('\n')]])).map((x) => x.line);
  // Lines 14 and 15 (a plain relative path, package and builtin names) are not reported.
  assert.deepEqual([...new Set(found)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17]);
});

test("the maker check: a plain specifier that names no module it reads is reported: out of src/, into test/, a package's .. (#806 round-5 review, B1 B3 B4 C1)", () => {
  const lines = [
    "import * as b1 from '../../dist/src/os/index.js';",
    "import * as b3 from '../../dist/src/slot-file.js';",
    "export const b2 = () => import('../../dist/src/os/index.js');",
    "import * as b4 from '@anthropic-ai/sandbox-runtime/../../../dist/src/os/index.js';",
    "import * as c1 from '../test/launder-r5.js';",
    "import * as e1 from './OS/index.js';",
    "import pkg from '../package.json';",
    "import lodash from 'lodash';",
    "import { slotsDir } from './os/index.js';",
    "import { parse } from 'yaml'; import { z } from 'zod'; import { SandboxManager } from '@anthropic-ai/sandbox-runtime'; import { join } from 'node:path'; import { EventEmitter } from 'events';",
    'void [b1, b3, b4, c1, e1, pkg, lodash, slotsDir, parse, z, SandboxManager, join, EventEmitter];',
  ];
  const found = slotPathMakers(new Map([['src/cores.ts', lines.join('\n')]])).map((x) => x.line);
  // Lines 9 and 10 (an existing src/ module; dependencies and builtins) are not reported.
  assert.deepEqual([...new Set(found)], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('src/: no eval, Function, node:vm, or Worker but from a src/ module (#806 round-5 review, D1 to D4)', () => {
  assert.deepEqual(show(dynamicCode(srcFiles())), []);
});

test('the dynamic-code check: eval, Function, node:vm and Workers from a string, a data: URL or eval are reported; F1 and F2 are not (closed by design)', () => {
  const lines = [
    "export const d1 = (u: string) => eval('import(u)') as unknown;",
    "export const d2 = (u: string) => new Function('u', 'return import(u)')(u) as unknown;",
    "import { Worker } from 'node:worker_threads';",
    "export const d3 = (u: string) => new Worker('import(process.argv[2])', { eval: true, argv: [u] });",
    "export const d4 = () => new Worker(new URL('data:text/javascript,import(\"x\")'));",
    "import * as vm from 'node:vm';",
    "export const d5 = (u: string) => globalThis.eval(u) as unknown;",
    "export const d6 = () => new Worker(new URL('./setup-worker.js', import.meta.url), { eval: true });",
    "export const d7 = () => new Worker(new URL('../../dist/src/setup-worker.js', import.meta.url));",
    "export const ok = () => new Worker(new URL('./setup-worker.js', import.meta.url), { workerData: 1 });",
    "export const f1 = (u: string) => (async () => 0).constructor('u', 'return import(u)')(u) as unknown;",
    "export const f2 = (u: string) => (globalThis as unknown as Record<string, (s: string) => unknown>)['ev' + 'al']!(`import(${JSON.stringify(u)})`);",
    'void vm;',
  ];
  const found = dynamicCode(new Map([['src/setup-steps.ts', lines.join('\n')]])).map((x) => x.line);
  // Line 3 (worker_threads itself) and 10 (a src/ module, no eval) are not reported; 11 and 12 (F1, F2) aren't either:
  // no name gives them away. They reach no oracle: a slot path compares equal to no other (the run-time tests).
  assert.deepEqual([...new Set(found)], [1, 2, 4, 5, 6, 7, 8, 9]);
});

test('src/: no symlink (a module the checks would know by one name, loaded by another)', () => {
  assert.deepEqual(symlinksUnder(join(repoRoot, 'src')), []);
});

test('the symlink check: a link in the tree is reported, wherever it points', () => {
  const root = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'links-'));
  mkdirSync(join(root, 'os'));
  writeFileSync(join(root, 'os', 'index.ts'), '');
  symlinkSync(join(root, 'os', 'index.ts'), join(root, 'osx.ts'));
  symlinkSync(join(root, 'os'), join(root, 'os2'));
  assert.deepEqual(symlinksUnder(root).sort(), ['os2', 'osx.ts']);
});

test('the source check: the slot dir\'s location read anywhere but the OS layer is reported (env, SYSTEM_SLOTS, the name)', () => {
  const files = new Map([
    ['src/cores.ts', "import { SYSTEM_SLOTS } from './os/index.js';\nexport const a = SYSTEM_SLOTS.dir;\nexport const b = process.env.AGENT_SLOTS_DIR;\nexport const c = process.env['AGENT_SLOTS_DIR'];\nexport const d = `/var/lib/${'x'}/agent-slots`;\n// agent-slots in a comment is not a read\n"],
    ['src/os/system-paths.ts', "export const devSlotsPath = () => '/var/tmp/agent-slots';\n"],
    [MAKER, 'export const e = process.env.AGENT_SLOTS_DIR;\n'],
  ]);
  assert.deepEqual(show(rawSlotSources(files)).map((l) => l.replace(/: (only|names).*$/, '')), [
    'src/cores.ts:1: SYSTEM_SLOTS',
    'src/cores.ts:2: SYSTEM_SLOTS',
    'src/cores.ts:3: AGENT_SLOTS_DIR',
    'src/cores.ts:4: "AGENT_SLOTS_DIR"',
    'src/cores.ts:5: "/agent-slots"',
  ]);
});

test('the untyped-fs check: R2, R3, R5b, R6, R7 and an import() by a computed name are reported (#772)', () => {
  const files = new Map([
    [
      'src/slots.ts',
      [
        "import { createRequire } from 'node:module';",
        "const { writeFileSync: rw } = createRequire(import.meta.url)('node:fs'); // R2",
        "const req = createRequire(import.meta.url); const rfs = req('node:fs'); const w = rfs.writeFileSync; // R3",
        "export const r5b = (fd: number) => (process as unknown as { binding(m: string): any }).binding('fs').writeString(fd, 'x', null, 'utf8');",
        "const { writeFileSync: gw } = (globalThis.process as any).getBuiltinModule('fs'); // R6",
        "export const r7 = async () => { const { writeFileSync: dw } = await import('node:fs'); return dw; };",
        "export const r7b = async (m: string) => import(m);",
        "export const ok = async () => import('./slots.js');",
        'void [rw, w, gw];',
        "import fsDefault from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';",
        'export const patch = (spy: typeof fsDefault.readFileSync) => { fsDefault.readFileSync = spy; syncBuiltinESMExports(); };',
      ].join('\n'),
    ],
  ]);
  // R3's `req('node:fs')` is a local's call: its createRequire, on the same line, is what is reported.
  assert.deepEqual(show(untypedFs(files)).map((l) => l.replace(/(…\)|'\)|\(\)): .*$/, '$1')), [
    'src/slots.ts:2: createRequire(…)',
    'src/slots.ts:3: createRequire(…)',
    'src/slots.ts:4: binding(…)',
    'src/slots.ts:5: getBuiltinModule(…)',
    "src/slots.ts:6: import('node:fs')",
    "src/slots.ts:7: import() of a name not written out: tsc can't type it",
    'src/slots.ts:11: syncBuiltinESMExports()',
  ]);
});

test('the conversion check: casts to or from a slot path and its conversions to a string are reported; other code is not', () => {
  const files = srcFiles();
  const FIX = 'src/fixture-cast-772.ts';
  files.set(
    FIX,
    [
      "import { slotsDir } from './os/index.js';",
      "import { slotFile, type SlotPath, type SlotPathLike } from './slot-file.js';",
      'export const a = slotsDir() as unknown as string;',
      "export const b = '/x' as unknown as SlotPath;",
      'export const c = `${slotsDir()}/x`;',
      'export const d = String(slotsDir());',
      "export const e = (slotFile(slotsDir(), 'x') as SlotPathLike) + '';",
      'export const f = <SlotPath>(<unknown>{});',
      "export const g = ({}) as SlotPath;",
      "export const h = slotFile('/plain', 'x') + '';",
      "export const i = 'x' as string;",
    ].join('\n'),
  );
  const found = show(slotPathConversions(program(files), new Set([FIX]))).map((l) => l.replace(/^(.*?:\d+: ).*: (a cast|a slot path to) .*$/, '$1$2'));
  assert.deepEqual(found, [
    `${FIX}:3: a cast`,
    `${FIX}:4: a cast`,
    `${FIX}:5: a slot path to`,
    `${FIX}:6: a slot path to`,
    `${FIX}:7: a slot path to`,
    `${FIX}:7: a cast`,
    `${FIX}:8: a cast`,
    `${FIX}:9: a cast`,
  ]);
});

test('src/: nothing patches a built-in prototype or Error.prepareStackTrace (#806 round-2 review, 3b)', () => {
  assert.deepEqual(show(builtinPatches(srcFiles())), []);
});

test('the built-in patch check: a getter or method on a built-in prototype, a prototype reached around .prototype, and Error.prepareStackTrace are reported', () => {
  const files = new Map([
    [
      'src/os/stats.ts',
      [
        "Object.defineProperty(String.prototype, 'href', { get() { return undefined; } });",
        'Object.prototype.toJSON = () => 1;',
        "(Array.prototype as unknown as Record<string, unknown>)['push'] = () => 0;",
        "globalThis.Map.prototype.get = () => undefined;",
        "export const a = (''.constructor as unknown as Record<string, unknown>)['prototype'];",
        "export const b = Object.getPrototypeOf('');",
        'export const c = Reflect.setPrototypeOf({}, null);',
        'export const d = { __proto__: null };',
        'Error.prepareStackTrace = () => 1;',
        "Object.defineProperty(Error, 'prepareStackTrace', { value: 1 });",
        "export const e = Reflect.get(Uint8Array, 'prototype');",
        "import { setPrototypeOf } from 'node:util';",
        "export const ok = (o: { proto: number; prototypes: string[] }) => [o.proto, o.prototypes, 'prototypes'];",
        'void setPrototypeOf;',
      ].join('\n'),
    ],
  ]);
  assert.deepEqual(show(builtinPatches(files)).map((l) => l.replace(/^(src\/os\/stats\.ts:\d+): .*$/, '$1')), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14].map((n) => `src/os/stats.ts:${n}`));
});

test('the introspection check: node:inspector and heap snapshots are reported (#806 review, A4)', () => {
  const files = new Map([
    [
      'src/cores.ts',
      [
        "import { Session } from 'node:inspector';",
        "import * as ip from 'inspector/promises';",
        "import v8, { writeHeapSnapshot } from 'node:v8';",
        'export const a = () => v8.getHeapSnapshot();',
        'export const b = () => writeHeapSnapshot();',
        "export const c = async () => import('node:inspector');",
        "export { Session as S2 } from 'inspector';",
        "export const ok = (s: string) => s === 'inspector';",
        'void [Session, ip];',
      ].join('\n'),
    ],
  ]);
  assert.deepEqual(show(introspection(files)).map((l) => l.replace(/^(.*?:\d+: .*?): (reads|a heap) .*$/, '$1')), [
    'src/cores.ts:1: node:inspector',
    'src/cores.ts:2: inspector/promises',
    'src/cores.ts:3: writeHeapSnapshot',
    'src/cores.ts:4: getHeapSnapshot',
    'src/cores.ts:5: writeHeapSnapshot',
    'src/cores.ts:6: node:inspector',
    'src/cores.ts:7: inspector',
  ]);
});

// ---------------------------------------------------------------------------------------------------------------
// The value at run time: what tsc doesn't see (an `any`, Reflect.apply's arguments) still gets no path

type SlotFile = typeof import('../src/slot-file.js');
type Os = typeof import('../src/os/index.js');

test('run time: fs, path.join, String() and a template literal refuse a slot path, and nothing prints its path', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const dir = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'opaque-'));
  const p = sf.slotFile(sf.slotPathOf(dir), 'f.json') as unknown;
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, (...a: unknown[]) => unknown>;
  const refused = (what: string, f: () => unknown) => assert.throws(f, (e: Error) => e instanceof TypeError || /ERR_INVALID_ARG/.test((e as NodeJS.ErrnoException).code ?? ''), what);
  refused('writeFileSync', () => writeFileSync(p as string, 'x'));
  refused('appendFileSync', () => appendFileSync(p as string, 'x'));
  refused('Reflect.apply(writeFileSync)', () => Reflect.apply(writeFileSync, undefined, [p, 'x']));
  refused('an untyped fs (createRequire)', () => fs['writeFileSync']!(p, 'x'));
  refused('openSync', () => fs['openSync']!(p, 'w'));
  refused('path.join', () => join(p as string, 'x'));
  refused('String()', () => String(p));
  refused('a template literal', () => `${p as string}`);
  refused('+', () => (p as string) + '');
  assert.deepEqual(readdirSync(dir), [], 'nothing was written');
  assert.equal(JSON.stringify({ p }), '{"p":"[slot path]"}');
  assert.ok(!inspect(p, { showHidden: true, depth: 5 }).includes(dir), 'inspect shows no path');
  assert.deepEqual(Reflect.ownKeys(p as object), [], 'no own key holds it');
  assert.ok(Object.isFrozen(p));
});

test('run time: a forged slot path is refused (a plain object, its prototype, its constructor, a subclass, a Proxy)', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const dir = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'forged-'));
  const real = sf.slotPathOf(dir) as unknown as object;
  const Ctor = (real as { constructor: new (...a: unknown[]) => object }).constructor;
  const forged: [string, () => unknown][] = [
    ['a plain object', () => ({})],
    ['an object with its prototype', () => Object.create(Object.getPrototypeOf(real) as object)],
    ['a Proxy of a real one', () => new Proxy(real, {})],
  ];
  for (const [what, make] of forged) assert.throws(() => sf.writeSlotFile(sf.slotFile(make() as never, 'x'), 'x'), TypeError, what);
  assert.throws(() => new Ctor('/x'), TypeError, 'its constructor makes no other');
  assert.throws(() => new Ctor(Symbol('slot path'), '/x'), TypeError, 'not with a symbol of the same name either');
  class Sub extends Ctor {}
  assert.throws(() => new Sub('/x'), TypeError, 'nor a subclass');
  assert.equal((Ctor as unknown as { path?: unknown }).path, undefined, 'no static method reads one');
  assert.ok(Object.isFrozen(Ctor) && Object.isFrozen(Object.getPrototypeOf(real)), 'its class and prototype are frozen');
  assert.deepEqual(readdirSync(dir), []);
});

test('run time: an error from a slot file keeps its code and names no path', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const dir = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'errors-'));
  const missing = sf.slotFile(sf.slotPathOf(dir), 'missing.json');
  const failures: [string, () => unknown][] = [
    ['readSlotFile', () => sf.readSlotFile(missing)],
    ['removeSlotFile', () => sf.removeSlotFile(missing)],
    ['renameSlotFile', () => sf.renameSlotFile(missing, sf.slotFile(sf.slotPathOf(dir), 'other.json'))],
    ['writeSlotFile into a missing dir', () => sf.writeSlotFile(sf.slotFile(sf.slotFile(sf.slotPathOf(dir), 'no-dir'), 'f.json'), 'x')],
  ];
  for (const [what, f] of failures) {
    assert.throws(f, (e: NodeJS.ErrnoException) => {
      assert.equal(e.code, 'ENOENT', what);
      assert.equal(e.path, undefined, what);
      assert.equal((e as { dest?: string }).dest, undefined, what);
      assert.ok(!`${e.message}\n${e.stack}`.includes(dir), `${what}: ${e.message}`);
      return true;
    });
  }
  // A plain path's error is fs's own, as before.
  assert.throws(() => sf.readSlotFile(join(dir, 'missing.json')), (e: NodeJS.ErrnoException) => e.path === join(dir, 'missing.json'));
});

test('run time: a slot file name is one plain name, and every slot path is a fresh value (#806 round 6)', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const d = sf.slotPathOf(mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'names-')));
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => sf.slotFile(d, bad), TypeError, JSON.stringify(bad));
  assert.throws(() => sf.slotSibling(d, '/../x'), TypeError);
  assert.notEqual(sf.slotFile(d, 'a'), sf.slotFile(d, 'a'), 'two slot paths for one file are two values');
  assert.equal(sf.slotFileName(sf.slotFile(d, 'a.lock')), 'a.lock');
  sf.writeSlotFile(sf.slotFile(d, 'a'), 'text');
  assert.equal(sf.readSlotFile(sf.slotFile(d, 'a')), 'text');
});

test('run time: nothing walks up from the slot dir or names it, so nothing spells out where it is', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const d = os.slotsDir();
  assert.throws(() => sf.slotFileName(d), TypeError, "not the slot dir's name");
  // No export gives a directory above one: listing it, then `===` with slotFile, would tell its entries apart.
  assert.deepEqual(Object.keys(sf).filter((k) => /parent|dirname|up$/i.test(k)), []);
  for (const up of ['..', '../', '/..', '.']) {
    assert.throws(() => sf.slotFile(d, up), TypeError, `slotFile(${up})`);
    assert.throws(() => sf.slotSibling(d, up), TypeError, `slotSibling(${up})`);
  }
});

test('run time: a patched Map, WeakSet or Object.prototype is never handed a slot path\'s path', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const dir = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'patched-'));
  const seen: unknown[] = [];
  const saved = { get: Map.prototype.get, set: Map.prototype.set, has: WeakSet.prototype.has, add: WeakSet.prototype.add };
  const spy = <F extends (...a: never[]) => unknown>(f: F) =>
    function (this: unknown, ...a: never[]) {
      seen.push(...a);
      return Reflect.apply(f, this, a);
    } as unknown as F;
  Map.prototype.get = spy(saved.get);
  Map.prototype.set = spy(saved.set);
  WeakSet.prototype.has = spy(saved.has);
  WeakSet.prototype.add = spy(saved.add);
  Object.defineProperty(Object.prototype, dir, { configurable: true, get: () => seen.push('a lookup on Object.prototype') });
  try {
    const d = sf.slotPathOf(dir);
    const f = sf.slotFile(sf.slotFile(d, 'x.json') && d, 'y.json');
    sf.writeSlotFile(f, 'v');
    sf.slotFileName(f);
  } finally {
    Object.assign(Map.prototype, { get: saved.get, set: saved.set });
    Object.assign(WeakSet.prototype, { has: saved.has, add: saved.add });
    delete (Object.prototype as Record<string, unknown>)[dir];
  }
  assert.deepEqual(seen.filter((x) => typeof x === 'string' && x.includes(dir.slice(1))), []);
});

test("run time: no sibling of the slot dir itself, so slotFileName can't give the slot dir's own name (#806 review, A1)", async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const d = os.slotsDir();
  assert.throws(() => sf.slotFileName(sf.slotSibling(d, '-x')), TypeError);
  assert.throws(() => sf.slotSibling(d, '.claim'), TypeError, 'a sibling only of a named file');
  // Beside a named file it is what tryLock's claim and the budget's move-aside need.
  const lock = sf.slotFile(d, 'x.lock');
  assert.equal(sf.slotFileName(sf.slotSibling(lock, '.abc.claim')), 'x.lock.abc.claim');
  assert.equal(sf.slotFileName(sf.slotSibling(sf.slotSibling(lock, '.a'), '.b')), 'x.lock.a.b');
});

test('run time: no descriptor of a slot path leaves the helper, so /proc/self/fd names none (#806 review, A2)', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const d = os.slotsDir();
  // Every export, called with the slot dir (and a name where it takes one): none returns a number (a descriptor).
  const numbers: string[] = [];
  for (const [k, f] of Object.entries(sf)) {
    if (typeof f !== 'function' || k === 'writeSlotFile' || k === 'removeSlotFile' || k === 'renameSlotFile' || k === 'linkSlotFile') continue;
    try {
      if (typeof (f as (...a: unknown[]) => unknown)(d, 'x', 10) === 'number') numbers.push(k);
    } catch {
      // refused, or not for a directory
    }
  }
  assert.deepEqual(numbers, [], 'no export hands out a descriptor');
  // readRegularFile still reads a slot file, and refuses a symlink, as before.
  const f = sf.slotFile(d, 'regular.json');
  sf.writeSlotFile(f, '{"a":1}');
  const r = os.readRegularFile(f, 100);
  assert.equal(r.kind === 'file' && r.text, '{"a":1}');
  assert.equal(os.readRegularFile(d, 100).kind, 'not-file');
});

test('run time: no caller can learn whether a guessed path is the slot dir, by identity, keys or text (#806 round 6)', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const real = process.env.AGENT_SLOTS_DIR!;
  const d = os.slotsDir();
  /** Everything a caller can ask of a minted value against slotsDir() without a file system: the same for any guess. */
  const answers = (g: unknown) => {
    const weak = new WeakMap<object, number>([[d as unknown as object, 1]]);
    return [g === d, Object.is(g, d), new Set([g, d]).size, new Map<unknown, number>([[d, 1]]).get(g), weak.get(g as object), JSON.stringify(g), inspect(g, { showHidden: true, depth: 5 }), Reflect.ownKeys(g as object).length];
  };
  const mints: [string, (dir: string) => unknown][] = [
    ['slotPathOf', (dir) => sf.slotPathOf(dir)],
    ['slotsDirFor', (dir) => os.slotsDirFor({ dir, config: '' })],
    ['slotFile of a mint', (dir) => sf.slotFile(sf.slotPathOf(dirname(dir)), basename(dir))],
  ];
  for (const [name, mint] of mints) {
    const right = answers(mint(real));
    assert.deepEqual(right, answers(mint(`${real}-not-it`)), `${name}: a right guess and a wrong one answer alike`);
    assert.equal(right[0], false, `${name}: never === slotsDir()`);
  }
  assert.equal(os.slotsDir(), d, 'slotsDir() itself is one value while the slot dir stays put');
});

test('run time: no call of slotsDir, however made, marks a guess as the system slot dir (#806 round-3 review, the mark oracle)', async () => {
  const os = (await import('../src/os/index.js')) as Os;
  const real = process.env.AGENT_SLOTS_DIR!;
  const before = typeof os.updateDrainPath();
  const loose = os.slotsDir as unknown as (s?: unknown) => unknown;
  const right = { dir: real, config: '' };
  loose.call(undefined, right);
  loose(right);
  [right].map(loose);
  Reflect.apply(loose, undefined, [right]);
  assert.equal(before, 'object');
  assert.equal(typeof os.updateDrainPath(), before, "updateDrainPath's type doesn't change with a right guess");
  assert.throws(() => {
    (os.SYSTEM_SLOTS as { dir: string }).dir = real;
  }, TypeError, 'SYSTEM_SLOTS is frozen: no module points it at a guess');
});

test("run time: the machine's own system slot dir is still the system one: root's drain file and the system config (principle 3)", async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const saved = process.env.AGENT_SLOTS_DIR;
  delete process.env.AGENT_SLOTS_DIR;
  const madeConfigDir = !existsSync(dirname(os.SYSTEM_SLOTS.config));
  try {
    mkdirSync(os.SYSTEM_SLOTS.dir, { recursive: true });
    const d = os.slotsDir();
    assert.equal(os.slotsDir(), d, 'slotsDir() is one value while the slot dir stays put');
    // Where it points: a marker made in SYSTEM_SLOTS.dir with plain fs is seen through it, read-only (a slot path has
    // nothing else to compare; nothing is written through it: rule A, #806 round 7).
    const marker = `.p3-${randomBytes(6).toString('hex')}`;
    writeFileSync(join(os.SYSTEM_SLOTS.dir, marker), '');
    assert.ok(sf.slotFileExists(sf.slotFile(d, marker)), 'slotsDir() is the machine system dir');
    assert.equal(os.updateDrainPath(), os.UPDATE_DRAIN_FILE);
    assert.equal(typeof os.slotsConfigPath(), 'object', 'no system config yet: config.json in the slot dir');
    mkdirSync(dirname(os.SYSTEM_SLOTS.config), { recursive: true });
    writeFileSync(os.SYSTEM_SLOTS.config, '{}');
    assert.equal(os.slotsConfigPath(), os.SYSTEM_SLOTS.config);
  } finally {
    process.env.AGENT_SLOTS_DIR = saved;
    rmSync(os.SYSTEM_SLOTS.dir, { recursive: true, force: true });
    rmSync(madeConfigDir ? dirname(os.SYSTEM_SLOTS.config) : os.SYSTEM_SLOTS.config, { recursive: true, force: true });
  }
});

test("run time: updateDrainPath and slotsConfigPath never compare a caller's system with the slot path (#806 review, A3)", async () => {
  const os = (await import('../src/os/index.js')) as Os;
  const real = process.env.AGENT_SLOTS_DIR!;
  const config = join(mkdtempSync(join(real, 'cfg-')), 'slots.json');
  writeFileSync(config, '{}');
  // A guess that is right: before, each gave a string (the system's) for it and a slot path for a wrong guess.
  const guess = { dir: real, config };
  assert.notEqual(typeof os.updateDrainPath(os.slotsDir(), guess), 'string', 'updateDrainPath answers nothing about the guess');
  assert.notEqual(typeof os.slotsConfigPath(os.slotsDir(), guess), 'string', 'slotsConfigPath answers nothing about the guess');
  // A string is the caller's own path: compared as written, as before.
  assert.equal(os.slotsConfigPath(real, guess), config);
});

test('run time: a patched String.prototype or Array.prototype method is never handed the slot dir (#806 review, A5)', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const dir = process.env.AGENT_SLOTS_DIR!;
  sf.makeSlotDir(os.slotsDir());
  const includes = String.prototype.includes;
  const holds = (v: unknown): boolean => typeof v === 'string' && (Reflect.apply(includes, v, [dir]) as boolean);
  const hits = new Set<string>();
  let busy = false;
  const saved: [Record<string, unknown>, string, unknown][] = [];
  for (const proto of [String.prototype, Array.prototype] as unknown as Record<string, unknown>[]) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      const f = proto[k];
      if (typeof f !== 'function' || k === 'constructor' || k === 'toString' || k === 'valueOf') continue;
      saved.push([proto, k, f]);
      proto[k] = function (this: unknown, ...a: unknown[]) {
        if (!busy) {
          busy = true;
          try {
            let seen = holds(this);
            for (let i = 0; i < a.length && !seen; i++) seen = holds(a[i]);
            if (!seen && globalThis.Array.isArray(this)) for (let i = 0; i < (this as unknown[]).length && !seen; i++) seen = holds((this as unknown[])[i]);
            if (seen) hits.add(k);
          } finally {
            busy = false;
          }
        }
        return Reflect.apply(f as (...x: unknown[]) => unknown, this, a);
      };
    }
  }
  try {
    const d = os.slotsDir();
    const f = sf.slotFile(d, 'patched.json');
    sf.writeSlotFile(f, 'v');
    sf.readSlotFile(f);
    sf.listSlotDir(d);
    sf.slotFileName(sf.slotSibling(f, '.x'));
    os.updateDrainPath();
    os.slotsConfigPath();
    os.readRegularFile(f, 100);
    os.diskFree(d);
  } finally {
    for (const [proto, k, f] of saved) proto[k] = f;
  }
  assert.deepEqual([...hits], []);
});
