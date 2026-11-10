// #941: the R1184 attacks (R1184f-j: reviews/1184-adversarial-2..4, 1184-final-4..5), kept as regression cases against
// a data table (`src/x-rules.tables.json`, loaded by src/x-rules.ts as the engine's modules load theirs). Each case is a
// real repo, a base commit and an attack commit, asked through weakeningOf with git's changeFiles, as the merge decision
// asks it. Three kinds:
//   - a change to the data (the table's entries, its file moved or renamed), or to the line that loads it (the owner's
//     rule, 2026-11-08: `tablesOf(import.meta.url)`, a `.tables.json` name, a generated copy's marker): WAITS;
//   - a write to the loaded table at run time (H4, I1-I6, J1-J5): nothing to hold in the diff; each throws against a
//     real loaded table (test/check-tables.test.ts, "the R1184g-j write shapes");
//   - a use moved off the table while its data and its load line stay: to a decoy, a shadow, a re-pointed import of the
//     module, a dead branch, the user taken out of the build (A1, A3-A5, A7, A8, H1-H3, H5, I7, J8; A6 and A10 are the
//     shapes of A5 and A3). Neither the compare, the load rule nor the freeze sees it. The owner named this class OPEN
//     (2026-11-08, #941 stays open for it): each case asserts that it is open today, so a fix that holds one makes its
//     test fail, and the fix then turns it into a held case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changeFiles } from '../src/coordinator/change-files.js';
import { weakeningOf } from '../src/merge-policy-weakening.js';
import { exampleProject } from './helpers.js';

const DATA = 'src/x-rules.tables.json';
const TABLES = `${JSON.stringify({ CHECKS: { kind: 'never-shrink', value: ['a', 'b', 'c'] } }, null, 2)}\n`;
const RULES = "import { tablesOf } from './check-tables.js';\nexport const CHECKS: readonly string[] = tablesOf(import.meta.url).get('CHECKS');\n";
const USER = "import { CHECKS } from './x-rules.js';\nexport function run(x: string) {\n  return CHECKS.includes(x);\n}\n";
const DECOY = { 'src/x-live.ts': "export const CHECKS: readonly string[] = ['a'];\nexport const LIVE: readonly string[] = ['a'];\n" };
const BASE = { [DATA]: TABLES, 'src/x-rules.ts': RULES, 'src/x-user.ts': USER };

/** weakeningOf for BASE (plus `base`) to that with `head` applied (a path to its text, or null to delete it). */
function reasons(head: Record<string, string | null>, base: Record<string, string> = {}): string[] {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Record<string, string | null>) => {
    for (const [p, t] of Object.entries(files)) {
      if (t === null) rmSync(join(dir, p));
      else {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t);
      }
    }
    g('add', '-A');
    g('commit', '-q', '-m', 'step');
    return g('rev-parse', 'HEAD');
  };
  const b = commit({ ...BASE, ...base });
  const h = commit(head);
  return weakeningOf(dir, b, h, changeFiles(dir, b, h), undefined, b);
}
const user = (from: string, to: string) => ({ 'src/x-user.ts': USER.replace(from, to) });
const shrunk = `${JSON.stringify({ CHECKS: { kind: 'never-shrink', value: ['a'] } }, null, 2)}\n`;

test('R1184 attacks on the data itself wait: an entry taken out, the table renamed away, the file moved (#941)', () => {
  assert.ok(reasons({ [DATA]: shrunk }).length, 'entries taken out');
  assert.ok(reasons({ [DATA]: TABLES.replace('"CHECKS"', '"CHECKS_OLD"') }).length, 'the table renamed in its file');
  assert.ok(reasons({ [DATA]: null, 'src/x-rules2.tables.json': shrunk, 'src/x-rules2.ts': RULES }).length, "the file moved, the module's copy loading the new one");
  assert.ok(reasons({ [DATA]: '{ "CHECKS": ' }).length, "the file made unparseable");
  // A tsconfig line taken out (tsconfig.json is a guard file) waits; H5's own shape adds one and is open (below).
  assert.ok(reasons({ 'tsconfig.json': '{ "exclude": ["src/x-user.ts"] }\n' }, { 'tsconfig.json': '{}\n' }).length, 'a tsconfig line replaced');
  // A9: a rename plus an edit is a delete and an add.
  assert.ok(reasons({ [DATA]: null, 'src/x-other.tables.json': shrunk }).length, 'renamed and edited');
});

test("the owner's load-site rule (2026-11-08): a removed or changed line that loads a table waits, whatever replaces it (#941)", () => {
  const LOAD = "removes or changes the line that loads a check's table from its data";
  const kinds = (r: string[]) => r.filter((x) => x.includes(LOAD));
  // The module's own load replaced by a literal, by a load of text of its own, or by another module's tables.
  assert.equal(kinds(reasons({ 'src/x-rules.ts': "export const CHECKS: readonly string[] = ['a'];\n" })).length, 1, 'a literal');
  assert.equal(kinds(reasons({ 'src/x-rules.ts': "import { tablesFrom } from './check-tables.js';\nexport const CHECKS: readonly string[] = tablesFrom('{\"CHECKS\":{\"kind\":\"never-shrink\",\"value\":[\"a\"]}}', 'x').get('CHECKS');\n" })).length, 1, "text of its own");
  // A `.tables.json` name in code, changed (a read of another file), and a generated copy's marker taken out.
  const reader = "import { readFileSync } from 'node:fs';\nexport const CHECKS = JSON.parse(readFileSync(new URL('./x-rules.tables.json', import.meta.url), 'utf8')).CHECKS.value;\n";
  assert.equal(kinds(reasons({ 'src/x-read.ts': reader.replace('x-rules.tables', 'x-weak.tables') }, { 'src/x-read.ts': reader })).length, 1, 'a .tables.json name');
  const copy = '// BEGIN tables from x-copy.tables.json: generated, do not edit\nconst CHECKS = Object.freeze(["a", "b"]);\n// END tables from x-copy.tables.json\n';
  assert.equal(kinds(reasons({ 'scripts/x-copy.mjs': 'const CHECKS = Object.freeze(["a"]);\n' }, { 'scripts/x-copy.mjs': copy })).length, 1, "a copy's markers");
  // A comment that names a tables file is no load; nor is a test's line (the test rules hold those).
  assert.deepEqual(kinds(reasons({ 'src/x-rules.ts': RULES.replace("import {", "// see src/x-rules.tables.json\nimport {") }, { 'src/x-rules.ts': RULES.replace("import {", "// see x-rules.tables.json\nimport {") })), []);
});

test('control: a use added, an entry added, and an unrelated change give no reason (#941)', () => {
  assert.deepEqual(reasons(user('return CHECKS.includes(x);', 'return CHECKS.includes(x) || CHECKS.length > 9;')), []);
  assert.deepEqual(reasons({ [DATA]: TABLES.replace('"c"', '"c",\n      "d"') }), []);
  assert.deepEqual(reasons({ 'src/x-user.ts': `${USER}// a comment\n` }), []);
});

/** The open class (the owner, 2026-11-08): a use moved off the table, its data and its load line unchanged. */
const OPEN: [string, () => Record<string, string | null>, Record<string, string>?][] = [
  ['A1 a local const CHECKS shadows the import', () => user('  return CHECKS.includes(x);', "  const CHECKS = ['a'];\n  return CHECKS.includes(x);")],
  ['A3/H1 the import re-pointed at a decoy that exports the same name', () => ({ ...DECOY, ...user("'./x-rules.js'", "'./x-live.js'") })],
  ['A3 split import: only the specifier line re-pointed', () => ({ ...DECOY, 'src/x-user.ts': USER.replace("import { CHECKS } from './x-rules.js';", "import { CHECKS } from\n  './x-live.js';") }), { 'src/x-user.ts': USER.replace("import { CHECKS } from './x-rules.js';", "import { CHECKS } from\n  './x-rules.js';") }],
  ['A4/H1a a namespace import re-pointed', () => ({ ...DECOY, 'src/x-user.ts': "import * as M from './x-live.js';\nexport const run = (x: string) => M.CHECKS.includes(x);\n" }), { 'src/x-user.ts': "import * as M from './x-rules.js';\nexport const run = (x: string) => M.CHECKS.includes(x);\n" }],
  ['H2 an export * barrel re-pointed', () => ({ ...DECOY, 'src/x-barrel.ts': "export * from './x-live.js';\n" }), { 'src/x-barrel.ts': "export * from './x-rules.js';\n", 'src/x-user.ts': USER.replace("'./x-rules.js'", "'./x-barrel.js'") }],
  ['H3a a block-scoped destructuring shadow', () => ({ ...DECOY, ...user('  return CHECKS.includes(x);', "  for (const [CHECKS] of [[['a']]]) return CHECKS.includes(x);\n  return CHECKS.includes(x);") })],
  ['I7 a hoisted function declaration shadows it', () => user('  return CHECKS.includes(x);', '  return CHECKS.includes(x);\n  function CHECKS() {}')],
  ['A5 a function wrapper returns a decoy', () => ({ 'src/x-user.ts': "import { CHECKS } from './x-rules.js';\nvoid CHECKS;\nfunction rules() { return ['a']; }\nexport function run(x: string) {\n  return rules().includes(x);\n}\n" })],
  ['A7 the use kept, made dead', () => user('  return CHECKS.includes(x);', '  if (Math.random() > 2) return CHECKS.includes(x);\n  return true;')],
  ['J8 a computed key on the module object moved to a decoy', () => ({ ...DECOY, 'src/x-user.ts': "import * as M from './x-rules.js';\nimport * as N from './x-live.js';\nconst K = 'LIVE' as const;\nexport const run = (x: string) => N[K].includes(x) || M === M;\n" }), { 'src/x-user.ts': "import * as M from './x-rules.js';\nconst K = 'CHECKS' as const;\nexport const run = (x: string) => M[K].includes(x);\n" }],
  ['A8 a package.json "imports" entry re-pointed', () => ({ ...DECOY, 'package.json': '{ "imports": { "#rules": "./src/x-live.js" } }\n' }), { 'package.json': '{ "imports": { "#rules": "./src/x-rules.js" } }\n', 'src/x-user.ts': USER.replace("'./x-rules.js'", "'#rules'") }],
  // H5, R1184h's shape: one `exclude` line added to the tsconfig, nothing removed (a guard file holds removed lines).
  ['H5 the user taken out of the build: a tsconfig exclude added', () => ({ 'tsconfig.json': '{\n  "exclude": ["src/x-user.ts"],\n  "include": ["src/**/*.ts"]\n}\n' }), { 'tsconfig.json': '{\n  "include": ["src/**/*.ts"]\n}\n' }],
];
for (const [name, head, base] of OPEN) {
  test(`OPEN (#941, named by the owner, 2026-11-08): ${name} gives no reason today`, () => {
    assert.deepEqual(reasons(head(), base), [], 'held now: make this a held case, and take it out of the open list in the PR body and design.md');
  });
}

test("R1184m P1d/P1e: a module's TABLES.get('NAME') line changed waits, as its load does; R1184n N3: an added line that loads the loader another way, or reassigns import.meta.url, waits (#941)", () => {
  const LOAD = "removes or changes the line that loads a check's table from its data";
  const ADDED = "adds a line that loads a check's table some other way than its module's one load";
  const has = (r: string[], k: string) => r.some((x) => x.includes(k));
  const split = "import { tablesOf } from './check-tables.js';\nconst TABLES = tablesOf(import.meta.url);\nexport const CHECKS: readonly string[] = TABLES.get('CHECKS');\n";
  const base = { 'src/x-rules.ts': split };
  // P1d: the table filtered on its binding line; P1e: sliced.
  assert.ok(has(reasons({ 'src/x-rules.ts': split.replace("TABLES.get('CHECKS');", "TABLES.get<readonly string[]>('CHECKS').filter((c) => c !== 'a');") }, base), LOAD), 'P1d filtered');
  assert.ok(has(reasons({ 'src/x-rules.ts': split.replace("TABLES.get('CHECKS');", "TABLES.get<readonly string[]>('CHECKS').slice(0, -1);") }, base), LOAD), 'P1e sliced');
  // N3: a second module loads another's tables through an alias; a namespace; import.meta.url reassigned.
  assert.ok(has(reasons({ 'scripts/zz.mjs': "import { tablesOf as load } from './lib/check-tables.mjs';\nconst T = load(new URL('../src/x-rules.ts', import.meta.url).href);\n" }), ADDED), 'an alias');
  assert.ok(has(reasons({ 'src/zz.ts': "import * as L from './check-tables.js';\nvoid L;\n" }), ADDED), 'a namespace');
  assert.ok(has(reasons({ 'src/x-rules.ts': split.replace('const TABLES', "import.meta.url = new URL('./x-decoy.ts', import.meta.url).href;\nconst TABLES") }, base), ADDED), 'import.meta.url reassigned');
  // R1184o 1: the shape redact.ts has: the removed line carries `TABLES.get<T>(` (a type argument), sliced (P1e) or
  // filtered (R1184o's PATTERNS case), on the one line its statement now takes.
  const typed = "import { tablesOf } from './check-tables.js';\nconst TABLES = tablesOf(import.meta.url);\nexport const CHECKS: readonly string[] = Object.freeze(TABLES.get<readonly string[]>('CHECKS').map((c) => c));\n";
  assert.ok(has(reasons({ 'src/x-rules.ts': typed.replace(".map((c) => c));", ".slice(0, -1).map((c) => c));") }, { 'src/x-rules.ts': typed }), LOAD), 'P1e: TABLES.get<T> sliced');
  assert.ok(has(reasons({ 'src/x-rules.ts': typed.replace(".map((c) => c));", ".filter((c) => c !== 'a').map((c) => c));") }, { 'src/x-rules.ts': typed }), LOAD), 'PATTERNS: TABLES.get<T> filtered');
  // R1184o 2: import.meta redefined without an assignment operator; R1184o 3: a computed specifier.
  assert.ok(has(reasons({ 'src/x-rules.ts': split.replace('const TABLES', "Object.assign(import.meta, { url: new URL('./x-decoy.ts', import.meta.url).href });\nconst TABLES") }, base), ADDED), 'Object.assign(import.meta, …)');
  assert.ok(has(reasons({ 'src/x-rules.ts': split.replace('const TABLES', "Reflect.set(import.meta, 'url', 'file:///x');\nconst TABLES") }, base), ADDED), 'Reflect.set(import.meta, …)');
  // A computed specifier is a named limit (R1184o 3): not followed by the hold or the backstop.
  assert.ok(!has(reasons({ 'src/zz.ts': "const L = await import('./check' + '-tables.js');\nvoid L;\n" }), ADDED), 'a computed dynamic import: a named limit');
  // Controls (R1184o's smaller notes): a type-only import of the loader and a trailing comment pass; so does reading import.meta.
  assert.deepEqual(reasons({ 'src/zz.ts': "import type { TableKind } from './check-tables.js'; // the kinds\nexport type K = TableKind;\nexport const here = import.meta.dirname;\n" }), []);
  // Control: a new module's own load, imported the plain way, adds nothing to hold.
  assert.deepEqual(reasons({ 'src/x-new.ts': "import { tablesOf } from './check-tables.js';\nexport const NEW_RULES: readonly string[] = tablesOf(import.meta.url).get('NEW_RULES');\n", 'src/x-new.tables.json': '{ "NEW_RULES": { "kind": "never-shrink", "value": ["a"] } }\n' }), []);
});

/**
 * OPEN, named by the owner (2026-11-08, R1184p P1; the hold side is #1251): an added line in a module that runs before a table's
 * load replaces a built-in the loader calls, so the load returns other data, frozen like any table. No use moves and
 * no load line changes, so neither the compare, the load rule nor the freeze sees it. Each case asserts it gives no
 * reason today; when #1251 holds such lines, each becomes a held case.
 */
const BUILTIN_OPEN: [string, string][] = [
  ['P1a JSON.parse replaced', "const parse = JSON.parse;\nJSON.parse = (t: string) => { const v = parse(t); if (v.CHECKS) v.CHECKS.value = ['a']; return v; };\n"],
  ['P1b Array.prototype.map replaced', "const map = Array.prototype.map;\nArray.prototype.map = function (this: unknown[], f: never) { return map.call(this.slice(0, 1), f); } as never;\n"],
  ['P1c Object.freeze turned off', 'Object.freeze = ((x: unknown) => x) as never;\n'],
  ['P1d readFileSync redirected for every importer', "import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst read = fs.readFileSync;\nfs.readFileSync = ((p: string, o: never) => read(String(p).replace('x-rules', 'x-weak'), o)) as never;\nsyncBuiltinESMExports();\n"],
];
for (const [name, early] of BUILTIN_OPEN) {
  test(`OPEN (R1184p P1, named by the owner; #1251): ${name} in a module that runs first gives no reason today`, () => {
    assert.deepEqual(reasons({ 'src/x-early.ts': early, 'src/x-user.ts': `import './x-early.js';\n${USER}` }), [], 'held now: make this a held case, and update the body and design.md');
  });
}

test("R1184q, R1184s D1: import.meta.url written as a pattern or for...of target, through a TypeScript wrapper or over lines, and a line the old comment strip cut, wait; R1184r D2: a load spelled TABLES?.get or tablesOf ( is a load line (#941)", () => {
  const LOAD = "removes or changes the line that loads a check's table from its data";
  const ADDED = "adds a line that loads a check's table some other way than its module's one load";
  const has = (r: string[], k: string) => r.some((x) => x.includes(k));
  const split = "import { tablesOf } from './check-tables.js';\nconst TABLES = tablesOf(import.meta.url);\nexport const CHECKS: readonly string[] = TABLES.get('CHECKS');\n";
  const base = { 'src/x-rules.ts': split };
  const above = (line: string) => ({ 'src/x-rules.ts': split.replace('const TABLES', `${line}\nconst TABLES`) });
  // Q1a-c: a destructuring or for...of target.
  assert.ok(has(reasons(above("[import.meta.url] = [new URL('./x-decoy.ts', import.meta.url).href];"), base), ADDED), 'Q1a array pattern');
  assert.ok(has(reasons(above("({ url: import.meta.url } = { url: new URL('./x-decoy.ts', import.meta.url).href });"), base), ADDED), 'Q1b object pattern');
  assert.ok(has(reasons(above("for (import.meta.url of [new URL('./x-decoy.ts', import.meta.url).href]) break;"), base), ADDED), 'Q1c for...of head');
  // R1184s D1: a write through a TypeScript wrapper tsc erases, a parenthesized target, a target split over lines, and a
  // code line that starts with `*` (each also refused by the loader at run time: test/check-tables.test.ts).
  const decoy = "new URL('./x-decoy.ts', import.meta.url).href";
  for (const [label, line] of [
    ['S1a non-null', `import.meta.url! = ${decoy};`],
    ['S1b as', `(import.meta.url as string) = ${decoy};`],
    ['S1c satisfies', `(import.meta.url satisfies string) = ${decoy};`],
    ['S1d a type assertion', `(<string>import.meta.url) = ${decoy};`],
    ['S1e non-null in a pattern', `[import.meta.url!] = [${decoy}];`],
    ['S1f as in a for...of head', `for ((import.meta.url as string) of [${decoy}]) break;`],
    ['S1g parenthesized', `(import.meta.url) = ${decoy};`],
    ['S1h a pattern split over lines', `[import.meta.url\n] = [${decoy}];`],
    ['S1i an assignment split over lines', `import.meta.url\n  = ${decoy};`],
    ['S1j a code line that starts with *', `const one = 1\n* ((import.meta.url = ${decoy}), 1);`],
    ['S1k a delete through a wrapper', 'delete (import.meta.url as never);'],
    ['S1l a delete in parentheses', 'delete (import.meta.url);'],
    ['S1m an increment in parentheses', '(import.meta.url)++;'],
    // R1184w W2: a line terminator other than \n ends the `//` comment, so the write after it is code (the loader
    // refuses it at run time too).
    ['W2a Object.assign after U+2028 in a comment', `// note\u2028Object.assign(import.meta, { url: ${decoy} });`],
    ['W2b a write after a lone CR in a comment', `// note\rimport.meta.url = ${decoy};`],
  ] as const) assert.ok(has(reasons(above(line), base), ADDED), label);
  assert.ok(has(reasons({ 'src/zz.ts': "// note\u2029import { tablesOf as load } from './check-tables.js';\nvoid load;\n" }), ADDED), 'W2c an aliased import after U+2029 in a comment');
  // Control: a JSDoc comment that names import.meta passes.
  assert.deepEqual(reasons(above('/**\n * reads import.meta.url as its own\n * import\n */'), base), [], 'a JSDoc comment');
  // R1184y Y2: a `//` or `/*` line inside a template literal is the template's text, so the code on it after the
  // template closes is read. Control: a real comment that names the loader passes.
  assert.ok(has(reasons({ 'src/zz-y2.ts': "const pad = `\n// `; const L = await import('./check-tables.js'); void L; const pad2 = `\n`;\nvoid pad; void pad2;\n" }), ADDED), 'Y2a a // line in a template');
  assert.ok(has(reasons({ 'src/zz-y2.ts': "const pad = `\n/* `; Object.assign(import.meta, { url: 'file:///x.ts' }); const pad2 = `\n`;\nvoid pad; void pad2;\n" }), ADDED), 'Y2b a /* line in a template');
  assert.deepEqual(reasons({ 'src/zz-y2.ts': "const pad = `a`;\n// see check-tables.js: Object.assign(import.meta, {}) is refused\n/* and import.meta.url = x */\nvoid pad;\n" }), [], 'real comments');
  // Q2a-c: a `//` inside a template literal, and a line that starts with an empty block comment.
  assert.ok(has(reasons(above("const sep = `//`; Object.assign(import.meta, { url: `${new URL(`./x-decoy.ts`, import.meta.url).href}` });"), base), ADDED), 'Q2a');
  assert.ok(has(reasons({ 'src/zz.ts': "const sep = `//`; const L = await import(`./check-tables.js`);\nvoid sep;\nvoid L;\n" }), ADDED), 'Q2b');
  assert.ok(has(reasons(above("/**/ Object.assign(import.meta, { url: new URL('./x-decoy.ts', import.meta.url).href });"), base), ADDED), 'Q2c');
  // D2: a load spelled with ?. or a space, then narrowed on its line.
  const opt = split.replace("TABLES.get('CHECKS')", "TABLES?.get('CHECKS')");
  assert.ok(has(reasons({ 'src/x-rules.ts': opt.replace("TABLES?.get('CHECKS');", "TABLES?.get<readonly string[]>('CHECKS').slice(1);") }, { 'src/x-rules.ts': opt }), LOAD), 'V1 TABLES?.get');
  const spaced = "import { tablesOf } from './check-tables.js';\nexport const CHECKS: readonly string[] = tablesOf (import.meta.url).get('CHECKS');\n";
  assert.ok(has(reasons({ 'src/x-rules.ts': spaced.replace(".get('CHECKS');", ".get<readonly string[]>('CHECKS').slice(1);") }, { 'src/x-rules.ts': spaced }), LOAD), 'V4 tablesOf (');
});

test("R1184r D1, R1184s D2: a changed line, or an added one that isn't a new replacer, of the redactor's REPLACERS (a table's entries in code) waits, in the module and in the updater's copy (#941)", () => {
  const SHRUNK = "removes or changes an entry in a check's rules or a guard's list";
  const redact = "const REPLACERS = Object.freeze({\n  stripe: (m: string, pre?: string, k?: string, v?: string) => (/\\d/.test(v!) ? `${pre}${k}_[REDACTED]` : m),\n  basic: (m: string) => m.slice(0, 1),\n});\nexport const R = REPLACERS;\n";
  const r1e = redact.replace('(/\\d/.test(v!) ?', '(/\\d/.test(v!) && v!.length !== 99 ?');
  assert.ok(reasons({ 'src/events/redact.ts': r1e }, { 'src/events/redact.ts': redact }).some((x) => x.includes(SHRUNK) && x.includes('REPLACERS')), 'R1e: the Stripe replacer declines a 99-character key');
  const upd = "const REPLACERS = Object.freeze({\n    basic: (m) => m.slice(0, 1),\n});\n";
  assert.ok(reasons({ 'scripts/machine/x-update.cjs': upd.replace('m.slice(0, 1)', 'm') }, { 'scripts/machine/x-update.cjs': upd }).some((x) => x.includes(SHRUNK)), "the updater copy's replacer");
  // R1184s D2: an added line that overrides a replacer, removing none: a spread, a name used before, a computed or
  // quoted key, a replacer over several lines.
  const add = (line: string) => reasons({ 'src/events/redact.ts': redact.replace('});', `${line}\n});`) }, { 'src/events/redact.ts': redact });
  for (const [label, line] of [
    ['S2a a spread', "  ...({ stripe: (m: string, pre?: string, k?: string, v?: string) => (/\\d/.test(v!) && !pre!.startsWith('rk') ? `${pre}${k}_[REDACTED]` : m) } as Partial<Record<string, never>>),"],
    ['S2b a name used before', '  stripe: (m: string) => m,'],
    ['S2c a computed key', "  ['basic']: (m: string) => m,"],
    ['S2d a quoted key', "  'basic': (m: string) => m,"],
    ['S2e a new replacer over two lines', '  extra: (m: string) =>\n    m,'],
    ['S2f a new name twice', '  extra: (m: string) => m,\n  extra: (m: string) => m.slice(1),'],
    // R1184t D1: a new first key, then a spread that replaces the Stripe replacer, on one line.
    ['T2a a new key, then a spread', "  zz: (m: string) => m, ...({ stripe: (m: string, pre?: string, k?: string, v?: string) => (/\\d/.test(v!) && !m.includes('rk_test_') ? `${pre}${k}_[REDACTED]` : m) } as Partial<Record<string, never>>),"],
    ['T2b a new method, then a spread', "  zz(m: string) { return m; }, ...({ stripe: (m: string) => m } as Partial<Record<string, never>>),"],
    ['T2f an accessor', '  get zz() { return (m: string) => m; },'],
    // R1184v D1: a bracket in a string, a comment, a regexp or a template hid the spread from the bracket count.
    ['V1a brackets in strings', "  zz: (m: string) => m + '(', ...({ stripe: (m: string) => m } as Partial<Record<string, never>>), yy: (m: string) => m + ')',"],
    ['V1b brackets in comments', '  zz: (m: string) => m /* ( */, ...({ stripe: (m: string) => m } as Partial<Record<string, never>>), yy: (m: string) => m /* ) */,'],
    ['V1c brackets in regexps', "  zz: (m: string) => m.replace(/\\(/, ''), ...({ stripe: (m: string) => m } as Partial<Record<string, never>>), yy: (m: string) => m.replace(/\\)/, ''),"],
    // R1184w D1: a line terminator other than \n ends a `//` comment, so the spread after it is code.
    ['W1a U+2028 after a new key and a comment', '  zz: (m: string) => m, // note\u2028  ...({ stripe: (m: string) => m } as Partial<Record<string, never>>),'],
    ['W1b U+2028 in a comment line', '  // note\u2028  ...({ stripe: (m: string) => m } as Partial<Record<string, never>>),'],
    ['W1c a lone CR in a comment line', '  // note\r  ...({ stripe: (m: string) => m } as Partial<Record<string, never>>),'],
    ['W1d U+2029 in a comment line', '  // note\u2029  ...({ stripe: (m: string) => m } as Partial<Record<string, never>>),'],
    ['V1d brackets in template text', '  zz: (m: string) => `${m}[`, ...({ stripe: (m: string) => m } as Partial<Record<string, never>>), yy: (m: string) => `${m}]`,'],
  ] as const) assert.ok(add(line).some((x) => x.includes(SHRUNK) && x.includes('REPLACERS')), label);
  const updSpread = upd.replace('});', '    ...({ basic: (m) => m }),\n});');
  assert.ok(reasons({ 'scripts/machine/x-update.cjs': updSpread }, { 'scripts/machine/x-update.cjs': upd }).some((x) => x.includes(SHRUNK)), "S2g a spread in the updater's copy");
  // Control: a line added to REPLACERS (a new replacer) and a change outside it pass.
  assert.deepEqual(reasons({ 'src/events/redact.ts': redact.replace('});', '  extra: (m: string) => m,\n});') }, { 'src/events/redact.ts': redact }), []);
  assert.deepEqual(reasons({ 'src/events/redact.ts': `${redact}// a comment\n` }, { 'src/events/redact.ts': redact }), []);
  // Control (R1184v D1): a new one-line replacer whose string, template text or comment holds a comma or a bracket.
  assert.deepEqual(add("  zz: (m: string) => m + ',(' + `[${m},]`, /* ), */ // a trailing comment, ("), [], 'brackets and commas outside code');
  // W1e (R1184w D1): a key the base hides after U+2028 in a comment is a name used before, so adding it again waits.
  const hidden = redact.replace('});', '  // note\u2028  zz: (m: string) => m,\n});');
  assert.ok(reasons({ 'src/events/redact.ts': hidden.replace('\n});', '\n  zz: (m: string) => m.slice(1),\n});') }, { 'src/events/redact.ts': hidden }).some((x) => x.includes(SHRUNK) && x.includes('REPLACERS')), 'W1e a key hidden after U+2028, defined again');
});

test('R1184y Y6a: a line of a generated copy changed without its data waits; changed with its data, the data is judged (#941)', () => {
  const data = (v: string[]) => `${JSON.stringify({ POLICY_ONLY: { kind: 'never-shrink', value: v } }, null, 2)}\n`;
  const copy = (v: string[]) => `// a script\n// BEGIN tables from x-gate.tables.json: generated, do not edit\nconst TABLES = Object.freeze({\n  POLICY_ONLY: Object.freeze(${JSON.stringify(v)}),\n});\n// END tables from x-gate.tables.json\nexport const P = TABLES.POLICY_ONLY;\n`;
  const base = { 'scripts/x-gate.mjs': copy(['auto_merge', 'review']), 'scripts/x-gate.tables.json': data(['auto_merge', 'review']) };
  const r = reasons({ 'scripts/x-gate.mjs': copy(['review']) }, base);
  assert.ok(r.some((x) => x.includes('a generated copy changed without its data')), `Y6a: ${r.join(' | ')}`);
  // Control: the copy and its data, an entry added to both, pass (the compare reads the data; the drift test the copy).
  assert.deepEqual(reasons({ 'scripts/x-gate.mjs': copy(['auto_merge', 'review', 'x']), 'scripts/x-gate.tables.json': data(['auto_merge', 'review', 'x']) }, base), []);
  // A line outside the copy's markers is the script's own code.
  assert.deepEqual(reasons({ 'scripts/x-gate.mjs': `${copy(['auto_merge', 'review'])}export const Q = 1;\n` }, base), []);
});
