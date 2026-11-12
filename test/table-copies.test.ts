// #941: the scripts that run on their own carry a generated, deep-frozen copy of their tables file
// (scripts/lib/table-copies.mjs). Each copy is exactly what the generator makes of the data the weakening hold compares,
// so a copy can't be loosened on its own; and its values are the loader's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { tablesFrom } from '../src/check-tables.js';
import { repoRoot } from './helpers.js';

type Copy = { script: string; exported: string[] };
type Lib = {
  COPIES: Copy[];
  resolved(root: string, c: Copy): Copy;
  tablesFileFor(script: string): string;
  blockFor(root: string, c: Copy, text: string): string;
  blockIn(text: string, c: Copy): string | null;
};
const lib = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'table-copies.mjs')).href)) as Lib;
const copies = lib.COPIES.map((c) => lib.resolved(repoRoot, c));

test("each script that runs on its own carries exactly what the generator makes of its tables file (#941)", () => {
  assert.equal(copies.length, 7);
  for (const c of copies) {
    const block = lib.blockIn(readFileSync(join(repoRoot, c.script), 'utf8'), c);
    assert.ok(block, `${c.script} has its generated block`);
    assert.equal(block, lib.blockFor(repoRoot, c, readFileSync(join(repoRoot, lib.tablesFileFor(c.script)), 'utf8')), `${c.script}: out of date: run node scripts/gen-table-copies.mjs --write`);
  }
});

test("a copy's tables are the loader's, deep-frozen; a copy changed on its own is caught (#941)", async () => {
  const shape = (v: unknown): unknown => (v instanceof Object && Symbol.iterator in v && !Array.isArray(v) ? { set: [...(v as Iterable<unknown>)] } : Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v);
  // A script with no table exported (the gate, which runs its main when imported) is held by its block alone.
  for (const c of copies.filter((x) => x.exported.length || x.script.endsWith('.cjs'))) {
    const data = tablesFrom(readFileSync(join(repoRoot, lib.tablesFileFor(c.script)), 'utf8'), c.script);
    // Only the exported ones (and the CommonJS helper's module.exports) can be read from outside.
    // The hook runs its main when imported: its tables are read from its --print-gate-files instead.
    const mod = (
      c.script === 'scripts/push-gate-hook.mjs'
        ? (({ code, rules }) => ({ GATE_CODE: Object.freeze(code), GATE_RULES: Object.freeze(rules) }))(JSON.parse(execFileSync(process.execPath, [join(repoRoot, c.script), '--print-gate-files'], { encoding: 'utf8' })) as { code: unknown; rules: unknown })
        : c.script.endsWith('.cjs')
          ? createRequire(import.meta.url)(join(repoRoot, c.script))
          : await import(pathToFileURL(join(repoRoot, c.script)).href)
    ) as Record<string, unknown>;
    for (const n of data.names.filter((n) => n in mod)) {
      assert.deepEqual(shape(mod[n]), shape(data.get(n)), `${c.script} ${n}`);
      // (The hook's values come back as JSON, so their freeze is the block's, checked above.)
      if (c.script !== 'scripts/push-gate-hook.mjs') assert.ok(Object.isFrozen(mod[n]), `${c.script} ${n} frozen`);
    }
  }
  // Fail-without of the drift check: the hook's block with an entry taken out is not what the generator makes.
  const hook = copies.find((c) => c.script === 'scripts/push-gate-hook.mjs')!;
  const text = readFileSync(join(repoRoot, hook.script), 'utf8').replace('"scripts/lib/denylist.mjs"', '');
  assert.notEqual(lib.blockIn(text, hook), lib.blockFor(repoRoot, hook, readFileSync(join(repoRoot, lib.tablesFileFor(hook.script)), 'utf8')));
});

test("a copy writes a key named __proto__ as an own key, as the loader reads it, never as the copy's prototype (#941, R1184y Y4j)", async () => {
  const { literal } = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'table-copies.mjs')).href)) as { literal(v: unknown): string };
  const data = tablesFrom('{"T": {"kind": "never-shrink", "value": {"__proto__": ["x"], "a": 1}}}', 'p.tables.json').get<Record<string, unknown>>('T');
  const copy = new Function(`return ${literal(data)};`)() as Record<string, unknown>;
  assert.deepEqual([Object.keys(copy), Object.getPrototypeOf(copy) === Object.prototype, Object.isFrozen(copy)], [['__proto__', 'a'], true, true]);
});

/**
 * What a script's copy binds, read by TypeScript's parser (R1184ah D1, R1184ai D1-D2: a copy turned off by lines around
 * it, so no line of its block changes). Each of the copy's tables is declared once, by a top-level statement inside the
 * block; nothing else in the file binds, declares or assigns that name (escapes read as the parser reads them); and the
 * file reaches no global object, `with`, eval or Function, where a name the block no longer binds could be answered.
 */
function copyBindingProblems(script: string, text: string, names: readonly string[]): string[] {
  const out: string[] = [];
  // A one-file program, so the checker can say what each name resolves to: a global has no declaration in the file.
  const host = ts.createCompilerHost({ allowJs: true, noLib: true, noResolve: true, types: [] });
  const file = script.endsWith('.cjs') ? 'copy.cjs' : 'copy.mjs';
  const real = host.getSourceFile;
  host.getSourceFile = (f, lang, ...rest) => (f === file ? ts.createSourceFile(f, text, lang, true, ts.ScriptKind.JS) : real.call(host, f, lang, ...rest));
  host.fileExists = (f) => f === file;
  const program = ts.createProgram([file], { allowJs: true, noLib: true, noResolve: true, types: [] }, host);
  const sf = program.getSourceFile(file)!;
  const checker = program.getTypeChecker();
  // Local: bound by a binding declaration in this file. `globalThis`'s own symbol points at a synthetic identifier,
  // which is no binding (R1184ak D2: it was caught only behind braces before).
  const binding = (d: ts.Declaration) => ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isBindingElement(d) || ts.isFunctionDeclaration(d) || ts.isFunctionExpression(d) || ts.isClassDeclaration(d) || ts.isClassExpression(d) || ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isImportEqualsDeclaration(d);
  const local = (id: ts.Identifier) => (checker.getSymbolAtLocation(id)?.declarations ?? []).some((d) => d.getSourceFile() === sf && binding(d));
  const lines = text.split('\n');
  const [begin, end] = [lines.findIndex((l) => l.startsWith('// BEGIN tables from ')), lines.findIndex((l) => l.startsWith('// END tables from '))];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
  for (const name of names) {
    const top = sf.statements.filter((s): s is ts.VariableStatement => ts.isVariableStatement(s)).flatMap((s) => s.declarationList.declarations.filter((d) => ts.isIdentifier(d.name) && d.name.text === name).map(() => s));
    const inBlock = top.filter((s) => lineOf(s) > begin && lineOf(s) < end);
    if (top.length !== 1 || inBlock.length !== 1) out.push(`${script}: ${name} is declared ${top.length} times at the top level, ${inBlock.length} in the block`);
  }
  const visit = (n: ts.Node): void => {
    const named = (x: ts.Node | undefined) => x !== undefined && ts.isIdentifier(x) && names.includes(x.text);
    const outsideBlock = lineOf(n) <= begin || lineOf(n) >= end;
    if (outsideBlock && (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n)) && named(n.name)) out.push(`${script}:${lineOf(n) + 1}: ${(n.name as ts.Identifier).text} bound outside its block`);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && named(n.left)) out.push(`${script}:${lineOf(n) + 1}: ${(n.left as ts.Identifier).text} assigned`);
    const isName = (id: ts.Identifier) => !(ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) && !(ts.isPropertyAssignment(id.parent) && id.parent.name === id) && !ts.isPropertyDeclaration(id.parent) && !ts.isMethodDeclaration(id.parent);
    if (ts.isIdentifier(n) && ['globalThis', 'global', 'window', 'self'].includes(n.text) && isName(n) && !local(n)) out.push(`${script}:${lineOf(n) + 1}: reaches ${n.text}`);
    if (ts.isWithStatement(n)) out.push(`${script}:${lineOf(n) + 1}: a with statement`);
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && ts.isIdentifier(n.expression) && ['eval', 'Function'].includes(n.expression.text) && !local(n.expression)) out.push(`${script}:${lineOf(n) + 1}: calls ${n.expression.text}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const copyNamesOf = (text: string, c: Copy) => [...(lib.blockIn(text, c) ?? '').matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]!);

test("each copy's tables are bound once, at the top level, in its block, and nothing else answers their names (#941, R1184ah, R1184ai)", () => {
  for (const c of copies) {
    const text = readFileSync(join(repoRoot, c.script), 'utf8');
    const names = copyNamesOf(text, c);
    assert.ok(names.length > 0, `${c.script}: the copy's names read`);
    assert.deepEqual(copyBindingProblems(c.script, text, names), [], c.script);
  }
});

test("the copy lock refuses a copy turned off by lines around it, by escapes, a global, Function, or a shadow (#941, R1184ah, R1184ai)", () => {
  const changelog = copies.find((c) => c.script === 'scripts/lib/changelog.mjs')!;
  const pins = copies.find((c) => c.script === 'scripts/ci/check-pins.mjs')!;
  const [cl, cp] = [readFileSync(join(repoRoot, changelog.script), 'utf8'), readFileSync(join(repoRoot, pins.script), 'utf8')];
  const block = lib.blockIn(cl, changelog)!;
  const WEAK = 'Object.freeze([])';
  const around = (pre: string, post: string) => cl.replace(block, () => `${pre}${block}${post}`);
  const cases: [string, string][] = [
    ['AH1a braces, then the name declared again', around('{\n', `\n}\nconst GUARDRAIL_PATHS = ${WEAK};`)],
    ['AH1b a comment, then the name declared with an escape', around('/*\n', `\n*/\nconst \\u0047UARDRAIL_PATHS = ${WEAK};`)],
    ['AH1c braces, then a computed global', around('{\n', `\n}\nglobalThis['GUARDRAIL' + '_PATHS'] = ${WEAK};`)],
    ['AH1d braces, then Object.assign(globalThis, …)', around('{\n', `\n}\nObject.assign(globalThis, { GUARDRAIL_PATHS: ${WEAK} });`)],
    ['AH1f a comment, then let over two lines', around('/*\n', `\n*/\nlet GUARDRAIL_PATHS\n= ${WEAK};`)],
    ['AH1g braces, then Function', around('{\n', `\n}\nFunction('GUARDRAIL' + '_PATHS = []')();`)],
    ['AI1b a comment, then const', around('/*\n', `\n*/\nconst GUARDRAIL_PATHS = ${WEAK};`)],
    ['AI1c braces, then \\u{47}', around('{\n', `\n}\nconst \\u{47}UARDRAIL_PATHS = ${WEAK};`)],
    ['AI2 braces alone (a global from another file would answer)', around('{\n', '\n}')],
    ['AI2 a comment alone', around('/*\n', '\n*/')],
  ];
  for (const [label, text] of cases) assert.notDeepEqual(copyBindingProblems(changelog.script, text, copyNamesOf(cl, changelog)), [], label);
  // AI1a/d: a shadow inside a function, written plainly or with an escape.
  const names = copyNamesOf(cp, pins);
  const fn = cp.indexOf('export function pinProblems');
  assert.ok(fn > 0, 'pinProblems found');
  const body = cp.indexOf('{', fn) + 1;
  for (const [label, decl] of [['AI1a', 'const ALLOWED_PACKAGE_JSON = [];'], ['AI1d', 'const \\u0041LLOWED_PACKAGE_JSON = [];']] as const) {
    assert.notDeepEqual(copyBindingProblems(pins.script, `${cp.slice(0, body)}\n  ${decl}${cp.slice(body)}`, names), [], label);
  }
  // R1184aj D1: a comment or braces hidden behind a line terminator other than \n in a `//` line.
  for (const [name, ch] of [['CR', '\r'], ['U+2028', '\u2028'], ['U+2029', '\u2029']] as const) {
    assert.notDeepEqual(copyBindingProblems(changelog.script, around(`// note${ch}/*\n`, `\n// note${ch}*/`), copyNamesOf(cl, changelog)), [], `AJ1 a comment behind ${name}`);
    assert.notDeepEqual(copyBindingProblems(changelog.script, around(`// note${ch}{\n`, `\n// note${ch}}`), copyNamesOf(cl, changelog)), [], `AJ1 braces behind ${name}`);
  }
  // R1184am D1: an escaped quote in a string or an escaped line feed in a comment; the parser reads them as JS does.
  for (const [label, pre, post] of [
    ['AM1 braces behind an escaped quote', "const OPEN = 'note\\u0027'; { const CLOSE = '\\u0027note';\n", '\n}'],
    ['AM1 a comment behind an escaped quote', "const OPEN = 'note\\u0027'; /* const CLOSE = '\\u0027note';\n", '\n*/'],
    ['AM2 braces behind an escaped line feed', '// Line breaks in a subject are \\u000a; the block below is generated.\n{\n', '\n}'],
  ] as const) assert.notDeepEqual(copyBindingProblems(changelog.script, around(pre, post), copyNamesOf(cl, changelog)), [], label);
  // R1184ak D2: each rule with the block intact, so each is pinned on its own.
  for (const [label, line] of [
    ['a global key set', "globalThis.UNRELATED = 1;"],
    ['self reached', 'void self;'],
    ['a with statement', 'with (Math) {}'],
    ['eval', "eval('1');"],
    ['Function', "Function('return 1')();"],
    ['the name assigned', 'GUARDRAIL_PATHS = [];'],
  ] as const) assert.notDeepEqual(copyBindingProblems(changelog.script, around('', `\n${line}`), copyNamesOf(cl, changelog)), [], label);
  // Control: an unrelated line added after the block passes.
  assert.deepEqual(copyBindingProblems(changelog.script, around('', '\nexport const UNRELATED = 1;'), copyNamesOf(cl, changelog)), []);
});
