// #869, #886's round-8 delta: on a raw line (one the whole-file reader gave up on, or any line of a .jsx or .tsx file)
// the computed-key check pairs no brackets and a nameless declaration is looked for with comments taken out; a bracket
// assignment of a string-built name, and a `with (` statement, wait in a table's file. Fixtures for the pure reader. No
// repo file is read or edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as weakening from '../src/merge-policy-weakening.js';
import type { ChangeFile } from '../src/review.js';

/** The start of the reason (its examples may grow). */
const HIDDEN = "adds a line that could hide a check's table from the line reader";
const kinds = (reasons: string[]) => reasons.map((r) => r.slice(weakening.WEAKENING_REASON.length).replace(/ \(.*$/s, '')).map((k) => (k.startsWith(HIDDEN) ? HIDDEN : k));

/** The pure hold for a change given as each file's text before and after, its lines as a diff gives them. */
function weakens(before: Record<string, string>, after: Record<string, string>): string[] {
  const minus = (a: string[], b: string[]) => {
    const left = [...b];
    return a.filter((x) => {
      const k = left.indexOf(x);
      if (k === -1) return true;
      left.splice(k, 1);
      return false;
    });
  };
  const files: ChangeFile[] = Object.keys(after).map((path) => {
    const [b, a] = [(before[path] ?? '').split('\n'), after[path]!.split('\n')];
    const removed = minus(b, a).filter(Boolean);
    const added = minus(a, b).filter(Boolean);
    return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
  });
  return kinds(weakening.weakeningReasons({ files, deleted: new Set(), before: (p) => before[p] ?? null, after: (p) => after[p] ?? null, scope: undefined }));
}

const GIVE_UP = 'void (Date.now() / 1000);';
const TS = 'test/x-rules.test.ts';
const BASE = "import { test } from 'node:test';\n// check-table: never-shrink\nexport const CHECKS = [\n  'a',\n  'b',\n  'c',\n];\ntest('t', () => { for (const c of CHECKS) void c; });\n";
const inComment = (after: string) => BASE.replace('// check-table', '/*\n// check-table').replace('];\n', `];\n*/\n${after}\n`);
const CJ = 'scripts/x-rules.cjs';
const CJS = "'use strict';\n// check-table: never-shrink\nconst CHECKS = [\n  'a',\n  'b',\n  'c',\n];\nmodule.exports = { CHECKS };\n";
const cjsDecoy = (payload: string) => CJS.replace('// check-table', '/*\n// check-table').replace('];\n', '];\n*/\n').replace('module.exports = { CHECKS };\n', `${payload}\n`);
const ts = (after: string) => weakens({ [TS]: BASE }, { [TS]: inComment(after) }).includes(HIDDEN);
const cjs = (payload: string) => weakens({ [CJ]: CJS }, { [CJ]: cjsDecoy(payload) }).includes(HIDDEN);

test('H2: after the reader gives up, a `]` in a string or comment inside a string-built key ends nothing: it waits', () => {
  assert.ok(cjs(`${GIVE_UP}\nmodule.exports = { ['CHE' + ']'.slice(1) + 'CKS']: ['a'] };`), 'H2 cjs');
  assert.ok(cjs(`${GIVE_UP}\nmodule.exports = { ['CHE' + 'CKS' /* ] */]: ['a'] };`), 'H2b cjs');
  assert.ok(ts(`${GIVE_UP}\nexport const o = { ['CHE' + ']'.slice(1) + 'CKS']: ['a'] };`), 'H2 ts');
  assert.ok(ts(`${GIVE_UP}\nexport const o = { ['CHE' + 'CKS' /* ] */]: ['a'] };`), 'H2b ts');
});

test('H3: a bracket assignment of a string-built name waits, on `module.exports`, `exports` or any object', () => {
  assert.ok(cjs("module.exports['CHE' + 'CKS'] = ['a'];"), 'H3');
  assert.ok(cjs("exports['CHE' + 'CKS'] = ['a'];"), 'H3b');
  assert.ok(ts("const o: Record<string, string[]> = {}; o[`CHE${'CKS'}`] = ['a'];"), 'a template-built name');
});

test('H4: a `with (` statement in a table file waits', () => {
  const sloppy = "// check-table: never-shrink\nconst CHECKS = [\n  'a',\n  'b',\n  'c',\n];\nfunction ok(x) { return CHECKS.includes(x); }\nmodule.exports = { ok };\n";
  const shadow = sloppy.replace('function ok', "const o = {}; o.CHECKS = ['a'];\nwith (o) {\nfunction ok").replace('module.exports', '}\nmodule.exports');
  assert.ok(weakens({ [CJ]: sloppy }, { [CJ]: shadow }).includes(HIDDEN));
});

test('H1: after the reader gives up, a declaration whose name is on the next line waits, a comment after it or not', () => {
  const decoy6 = (head: string) => BASE.replace('// check-table', '/*\n// check-table').replace("  'c',\n];\n", `  'c',\n  CHECKS = ['a'];\n];\n*/\n${head}\n  CHECKS = ['a'];\n`);
  for (const head of [`${GIVE_UP}\nexport const // x`, `${GIVE_UP}\nexport const /* x */`]) assert.ok(weakens({ [TS]: BASE }, { [TS]: decoy6(head) }).includes(HIDDEN), head);
});

test('ordinary lines still pass: a literal key assigned, a string-built name compared, a `with` in a string', () => {
  const add = (l: string) => weakens({ [TS]: BASE }, { [TS]: `${BASE}${l}\n` });
  for (const l of ["process.env['NODE_ENV'] = 'test';", "const same = o['a' + 'b'] === 1;", "const w = 'with (o)';"]) assert.deepEqual(add(l), [], l);
});
