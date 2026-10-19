// A slot-dir path is a SlotPath (#772): an opaque value that only src/slot-file.ts turns back into the path, so tsc
// rejects one handed to any writer but writeSlotFile, whatever the call chain. This file holds that in place:
// - tsc, fed source text (no file is written): a slot path passed through a `mixed` module's parameter to another
//   module's writer (#772's case C), kept in a property under another name (P1, P3), assigned to a local later (P4),
//   returned by a local function (P6), or given to a method of a value not traced to its module (U1 to U3), and the
//   forms #766's lint doesn't resolve (U4 to U6b, B10c, R8): each fails to compile, and the same text with a plain
//   path compiles (a control).
// - checks over src/, each tested against fixture text fed to its own function:
//   - only src/os/index.ts makes a slot path (slotPathOf), and only demo.ts and replay.ts ask it for one of their own
//     (slotDirAt);
//   - only src/os/index.ts and src/os/system-paths.ts read where the slot dir is (AGENT_SLOTS_DIR, SYSTEM_SLOTS, the
//     `agent-slots` name);
//   - no cast to or from a slot path, and no string conversion of one (a template literal, String(), `+`);
//   - fs is reached only through imports tsc types: no require, createRequire, getBuiltinModule, process.binding, and
//     no import() of fs or of a name not written out;
// - the value at run time: fs, path.join, String() and a template literal refuse it, nothing prints its path, an
//   error from a slot file names no path, and a forged one (its prototype, its constructor, a Proxy) is refused.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
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
/** Callers of slotDirAt in src/: a coordinator with a slot dir of its own, in its own state dir. */
const OWN_SLOT_DIRS = new Set(['src/demo.ts', 'src/harness-evals/replay.ts']);
/** Where the slot dir's location may be read: the maker, and the system paths it reads it from. */
const SLOT_SOURCES = new Set([MAKER, 'src/os/system-paths.ts']);
const SOURCE_NAMES = new Set(['AGENT_SLOTS_DIR', 'SYSTEM_SLOTS', 'devSlotsPath', 'unguardedSlotsDir']);

const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const nameText = (n: ts.Node): string | null => (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) ? n.text : ts.isStringLiteralLike(n) ? n.text : null);

/** Who makes a slot path: slotPathOf only in the maker (and the helper, which defines it), slotDirAt only in OWN_SLOT_DIRS. */
function slotPathMakers(files: Map<string, string>): Finding[] {
  const out: Finding[] = [];
  for (const [file, text] of files) {
    if (file === HELPER) continue;
    const sf = parse(file, text);
    const visit = (n: ts.Node) => {
      const name = nameText(n);
      if (name === 'slotPathOf' && file !== MAKER) out.push({ file, line: lineOf(sf, n), what: `slotPathOf: only ${MAKER} makes a slot path` });
      if (name === 'slotDirAt' && file !== MAKER && !OWN_SLOT_DIRS.has(file)) out.push({ file, line: lineOf(sf, n), what: `slotDirAt: only ${[...OWN_SLOT_DIRS].join(' and ')} make a slot dir of their own` });
      // A namespace import of the helper reads any of its exports by a computed name: slotPathOf too.
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /(^|\/)slot-file\.js$/.test(n.moduleSpecifier.text) && n.importClause?.namedBindings && ts.isNamespaceImport(n.importClause.namedBindings)) out.push({ file, line: lineOf(sf, n), what: 'import * from slot-file.js: import its functions by name' });
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && /slot-file/.test(n.arguments[0]?.getText(sf) ?? '')) out.push({ file, line: lineOf(sf, n), what: 'import() of slot-file.js: import its functions by name' });
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

test('src/: only os/index.ts makes a slot path, only demo.ts and replay.ts ask for one of their own, and only the OS layer reads where the slot dir is', () => {
  const files = srcFiles();
  assert.deepEqual(show([...slotPathMakers(files), ...rawSlotSources(files)]), []);
});

test('src/: no cast to or from a slot path, and no conversion of one to a string', () => {
  assert.deepEqual(show(slotPathConversions(program(srcFiles()))), []);
});

test('src/: fs is reached only through imports tsc types (no require, createRequire, getBuiltinModule, process.binding, import() of fs)', () => {
  assert.deepEqual(show(untypedFs(srcFiles())), []);
});

test('the maker check: another module making a slot path, or reading the helper by a computed name, is reported', () => {
  const files = new Map([
    ['src/cores.ts', "import { slotPathOf as mk } from './slot-file.js';\nexport const a = mk('/var/lib/x/agent-slots');\n"],
    ['src/dashboard.ts', "import { slotDirAt } from './os/index.js';\nexport const b = slotDirAt('/x');\n"],
    ['src/health.ts', "import * as sf from './slot-file.js';\nexport const c = (sf as Record<string, (d: string) => unknown>)['slotPath' + 'Of']!('/x');\nexport const d = import('./slot-file.js');\n"],
    ['src/demo.ts', "import { slotDirAt } from './os/index.js';\nexport const e = slotDirAt('/demo');\n"],
    [MAKER, "import { slotPathOf } from '../slot-file.js';\nexport const f = slotPathOf('/x');\n"],
  ]);
  assert.deepEqual(show(slotPathMakers(files)), [
    'src/cores.ts:1: slotPathOf: only src/os/index.ts makes a slot path',
    'src/dashboard.ts:1: slotDirAt: only src/demo.ts and src/harness-evals/replay.ts make a slot dir of their own',
    'src/dashboard.ts:2: slotDirAt: only src/demo.ts and src/harness-evals/replay.ts make a slot dir of their own',
    'src/health.ts:1: import * from slot-file.js: import its functions by name',
    'src/health.ts:3: import() of slot-file.js: import its functions by name',
  ]);
  // cores.ts:2 (`mk(…)`, the renamed import) is the import's line: the name is caught where it is imported.
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

// ---------------------------------------------------------------------------------------------------------------
// The value at run time: what tsc doesn't see (an `any`, Reflect.apply's arguments) still gets no path

type SlotFile = typeof import('../src/slot-file.js');
type Os = typeof import('../src/os/index.js');

test('run time: fs, path.join, String() and a template literal refuse a slot path, and nothing prints its path', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const dir = mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'opaque-'));
  const p = sf.slotFile(os.slotDirAt(dir), 'f.json') as unknown;
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
  const real = os.slotDirAt(dir) as unknown as object;
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
  const missing = sf.slotFile(os.slotDirAt(dir), 'missing.json');
  const failures: [string, () => unknown][] = [
    ['readSlotFile', () => sf.readSlotFile(missing)],
    ['removeSlotFile', () => sf.removeSlotFile(missing)],
    ['renameSlotFile', () => sf.renameSlotFile(missing, sf.slotFile(os.slotDirAt(dir), 'other.json'))],
    ['writeSlotFile into a missing dir', () => sf.writeSlotFile(sf.slotFile(sf.slotFile(os.slotDirAt(dir), 'no-dir'), 'f.json'), 'x')],
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

test('run time: a slot file name is one plain name, and a slot path is one value per path', async () => {
  const sf = (await import('../src/slot-file.js')) as SlotFile;
  const os = (await import('../src/os/index.js')) as Os;
  const d = os.slotDirAt(mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'names-')));
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => sf.slotFile(d, bad), TypeError, JSON.stringify(bad));
  assert.throws(() => sf.slotSibling(d, '/../x'), TypeError);
  assert.equal(sf.slotFile(d, 'a'), sf.slotFile(d, 'a'));
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
    const d = os.slotDirAt(dir);
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
