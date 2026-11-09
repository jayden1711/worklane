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
  // Control: a new module's own load, imported the plain way, adds nothing to hold.
  assert.deepEqual(reasons({ 'src/x-new.ts': "import { tablesOf } from './check-tables.js';\nexport const NEW_RULES: readonly string[] = tablesOf(import.meta.url).get('NEW_RULES');\n", 'src/x-new.tables.json': '{ "NEW_RULES": { "kind": "never-shrink", "value": ["a"] } }\n' }), []);
});
