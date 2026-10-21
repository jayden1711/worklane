// #869, #886's round-6 final check: the whole-file reader decides a regex literal against a division only where that is
// certain, and gives up (the rest of the file counts as code) everywhere else; and its global-name and computed-key
// checks don't hold a ternary's array, a key or a local named `self`. Fixtures for the pure reader. No repo file is read
// or edited.
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

const F = 'test/x-rules.test.ts';
const M = 'scripts/x-rules.mjs';
const BASE = "import { test } from 'node:test';\n// check-table: never-shrink\nexport const CHECKS = [\n  'a',\n  'b',\n  'c',\n];\ntest('t', () => { for (const c of CHECKS) void c; });\n";
const ESC = "export const C\\u0048ECKS = ['a'];";
/** The table's old lines kept in a block comment, `after` on the next line. */
const inComment = (text: string, after: string) => text.replace('// check-table', '/*\n// check-table').replace('];\n', `];\n*/\n${after}\n`);

test('A1 to A6: where the reader would have to guess a regex literal against a division, the escaped declaration after it waits', () => {
  const cases: [string, string, string][] = [
    ['A1 a unary `!` after `void`', F, `void !/'/.test(''); ${ESC}`],
    ['A2 a unary operator chain', F, `void + +/'/; ${ESC}`],
    ['A3 `for await (...)`', M, `for await (const z of []) /'/; ${ESC}`],
    ['A4 a member call named like a keyword', F, `const o = { if: (n) => n }; void (o.if(4) / 2 + '/' + ''); ${ESC}`],
    ['A5 a `>` that closes type arguments', F, `type N<T> = number;\nconst y = 1 as N<string> / 2 + '/'.length; const s = ''; ${ESC}`],
    ['A6 a line start after an operand (a semicolon may be inserted)', F, `let k: string\n/'/.test(''); ${ESC}`],
  ];
  for (const [what, path, after] of cases) assert.ok(weakens({ [path]: BASE }, { [path]: inComment(BASE, after) }).includes(HIDDEN), what);
});

test("the global-name and computed-key checks don't hold a ternary's array, a key, a property or a file's own `self`", () => {
  const withSelf = `${BASE}const self = new RegExp('x');\n`;
  const add = (base: string, l: string) => weakens({ [F]: base }, { [F]: `${base}${l}\n` });
  for (const l of ["const extra = process.env.X ? ['x'] : [];", 'const helper = { self: 1 };', 'const other = {\n  window: 2,\n};', 'opts.global = true;', `const s = { x: /['"]/ };`]) {
    assert.deepEqual(add(BASE, l), [], l);
  }
  assert.deepEqual(add(withSelf, 'const both = [self, self];'), [], "the file's own `self`");
  // Still held: the global object by any of its names, and a key built from strings.
  for (const l of ["global.CHECKS = ['a'];", "Object.assign(globalThis, { ['CHE' + 'CKS']: ['a'] });", "const o = {\n  ['CHE' + 'CKS']: ['a'],\n};", "const t = flag ? self : other;"]) {
    assert.ok(add(BASE, l).includes(HIDDEN), l);
  }
});
