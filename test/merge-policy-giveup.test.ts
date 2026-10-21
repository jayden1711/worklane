// #869, #886's round-7 delta: a `.` is a spread's only as part of exactly `...` (a number's `1..if` is a member), and
// once the whole-file reader gives up, none of the global-name check's skips apply (a raw comment line can't make a
// name read as a key). Fixtures for the pure reader. No repo file is read or edited.
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
const BASE = "import { test } from 'node:test';\n// check-table: never-shrink\nexport const CHECKS = [\n  'a',\n  'b',\n  'c',\n];\ntest('t', () => { for (const c of CHECKS) void c; });\n";
const ESC = "export const C\\u0048ECKS = ['a'];";
/** The table's old lines kept in a block comment, `after` on the next line. */
const inComment = (text: string, after: string) => text.replace('// check-table', '/*\n// check-table').replace('];\n', `];\n*/\n${after}\n`);
const held = (after: string) => weakens({ [F]: BASE }, { [F]: inComment(BASE, after) }).includes(HIDDEN);

test("E1: a number's `1..` is a member dot, so the word after it is a name: the escaped declaration after its division waits", () => {
  assert.ok(held(`Number.prototype.if = (n) => n; void (1..if(4) / 2 + '/' + ''); ${ESC}`), 'E1 1..if(4) / 2');
  assert.ok(held(`Number.prototype.return = 8; void (1..return / 2 + '/' + ''); ${ESC}`), 'E1b 1..return / 2');
  // A `..` that is neither a number's nor part of `...`: it gives up.
  assert.ok(held(`void (x..y / 2 + '/' + ''); ${ESC}`), 'x..y');
});

test('E2: after the reader gives up, a comment ending in `,` or `{` before a name for the global object makes no key of it', () => {
  const cases: Record<string, string> = {
    'E2 a division after a call, then `? // ,`': "void (Date.now() / 1000);\nconst g = 1 ? // ,\n  globalThis : 0;\ng['CHE' + 'CKS'] = ['a'];",
    'E2b a comment line `// ,`': "void (Date.now() / 1000);\nconst g = 1 ?\n// ,\n  globalThis : 0;\ng['CHE' + 'CKS'] = ['a'];",
    'E2c `// {` before `global`': "void (Date.now() / 1000);\nconst g = 1 ? // {\n  global : 0;\ng['CHE' + 'CKS'] = ['a'];",
    'E2d a name outside ASCII, then `? // ,`': `const ${String.fromCharCode(0xe9)} = 1;\nconst g = ${String.fromCharCode(0xe9)} ? // ,\n  globalThis : 0;\ng['CHE' + 'CKS'] = ['a'];`,
  };
  for (const [what, after] of Object.entries(cases)) assert.ok(held(after), what);
});

test('before the reader gives up, a key after `{` or `,` on the line before is still a key', () => {
  assert.deepEqual(weakens({ [F]: BASE }, { [F]: `${BASE}const o = {\n  global: 1,\n};\nconst spread = [...[1, 2]];\n` }), []);
});
