// #941: the R1184 attacks (R1184f-j: reviews/1184-adversarial-2..4, 1184-final-4..5), kept as regression cases against
// a data table (`src/x-rules.tables.json`, loaded by src/x-rules.ts as the engine's modules load theirs). Each case is a
// real repo, a base commit and an attack commit, asked through weakeningOf with git's changeFiles, as the merge decision
// asks it, and asserts the attack WAITS. Three kinds:
//   - a change to the data (the table's entries, its file moved or renamed): held by the parsed compare;
//   - a write to the loaded table at run time (H4, I1-I6, J1-J5): nothing to hold in the diff; each throws against a
//     real loaded table (test/check-tables.test.ts, "the R1184g-j write shapes");
//   - a use moved off the table: to a decoy, a shadow, a re-pointed import, a dead branch (A1, A3-A5, A7, A8, H1-H3, I7,
//     J8; A6 and A10 are the same shape as A5 and A3). The data is unchanged and nothing is written, so neither the compare nor the freeze sees it. These are OPEN:
//     each is a `todo` that asserts the hold, so it reports and doesn't fail; the fix that holds one takes its todo away.
//     Which fix, if any, is the owner's (~/projects/QUESTIONS.md, 2026-11-08); #941 stays open for them.
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

test('R1184 attacks on the data itself wait: an entry taken out, the table renamed away, the file moved; and H5 (#941)', () => {
  assert.ok(reasons({ [DATA]: shrunk }).length, 'entries taken out');
  assert.ok(reasons({ [DATA]: TABLES.replace('"CHECKS"', '"CHECKS_OLD"') }).length, 'the table renamed in its file');
  assert.ok(reasons({ [DATA]: null, 'src/x-rules2.tables.json': shrunk, 'src/x-rules2.ts': RULES }).length, "the file moved, the module's copy loading the new one");
  assert.ok(reasons({ [DATA]: '{ "CHECKS": ' }).length, "the file made unparseable");
  // H5: the user taken out of the build: tsconfig.json is a guard file, so its line taken out waits.
  assert.ok(reasons({ 'tsconfig.json': '{ "exclude": ["src/x-user.ts"] }\n' }, { 'tsconfig.json': '{}\n' }).length, 'H5 tsconfig exclude');
  // A9: a rename plus an edit is a delete and an add.
  assert.ok(reasons({ [DATA]: null, 'src/x-other.tables.json': shrunk }).length, 'renamed and edited');
});

test('control: a use added, an entry added, and an unrelated change give no reason (#941)', () => {
  assert.deepEqual(reasons(user('return CHECKS.includes(x);', 'return CHECKS.includes(x) || CHECKS.length > 9;')), []);
  assert.deepEqual(reasons({ [DATA]: TABLES.replace('"c"', '"c",\n      "d"') }), []);
  assert.deepEqual(reasons({ 'src/x-user.ts': `${USER}// a comment\n` }), []);
});

/** The open cases: a use moved off the table, the data unchanged. Each asserts the hold, as a todo. */
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
  ['the module loads its table from text of its own, not its file', () => ({ 'src/x-rules.ts': "import { tablesFrom } from './check-tables.js';\nexport const CHECKS: readonly string[] = tablesFrom('{\"CHECKS\":{\"kind\":\"never-shrink\",\"value\":[\"a\"]}}', 'x').get('CHECKS');\n" })],
];
for (const [name, head, base] of OPEN) {
  test(`OPEN (#941, the owner's call): ${name} waits`, { todo: 'a use moved off a data table, its data unchanged: neither the compare nor the freeze sees it' }, () => {
    assert.ok(reasons(head(), base).length > 0, 'not held');
  });
}
