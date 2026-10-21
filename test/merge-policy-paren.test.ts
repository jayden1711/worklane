// #869, #886's round-6 review: in the whole-file reader, a `/` after a `)` is a regex literal only after a condition's
// parentheses (`if`, `while`, `for`, `for await`, `with`); after any other `)`, or one with no `(`, the reader can't place
// it and the rest of the file counts as code. Fixtures for the pure reader. No repo file is read or edited.
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

test('a regex literal after `for await (...)` holding a quote, then the escaped declaration, waits', () => {
  assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, `for await (const x of xs) /'/.test(x); ${ESC}`) }).includes(HIDDEN));
});

test("a `/` after a `)` that closes no condition, or that has no `(`, is one the reader can't place: the rest waits", () => {
  for (const line of [`f(x) /'/; ${ESC}`, `x) /'/; ${ESC}`, `(a + b) /'/; ${ESC}`]) {
    assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, line) }).includes(HIDDEN), line);
  }
  // A later line too: the reader stops placing anything after it.
  assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, `const half = (a + b) / 2;\nconst s = '${ESC}';`) }).includes(HIDDEN), 'after the line');
});

test('a regex literal after a condition is still read as one: what follows it is placed, and an ordinary line passes', () => {
  assert.deepEqual(weakens({ [F]: BASE }, { [F]: `${BASE}if (ok) /'/.test('x');\nconst accent = '\\u00e9';\n` }), []);
  assert.deepEqual(weakens({ [F]: BASE }, { [F]: `${BASE}for await (const x of xs) /'/.test(x);\nconst accent = '\\u00e9';\n` }), []);
});
