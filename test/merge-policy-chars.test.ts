// #869, #886's round-6 final check: the whole-file reader gives up (the rest of the file counts as code) at any
// character it doesn't read: one outside printable ASCII, or whitespace other than a space, tab, CR or LF, outside a
// string or comment. A word after `...` or `#` is never a property or a keyword. A name for the global object first on
// its line is a key only after a line that ends in `{` or `,`. Fixtures for the pure reader. No repo file is read or
// edited.
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
const ch = (n: number) => String.fromCharCode(n);

test('N1 to N6, W1: a spread, a private name, a name outside ASCII or odd whitespace before a `/`, then the escaped declaration, waits', () => {
  const cases: Record<string, string> = {
    'N1 a word after a spread': `const q = [...typeof /'/]; ${ESC}`,
    'N1b the same with void': `const q = () => [...void /'/]; ${ESC}`,
    'N2 a private method named like a keyword': `class K { #if(n) { return n; } m() { return this.#if(4) / 2 + '/' + ''; } } ${ESC}`,
    'N3 a private field named like a keyword': `class K { #return = 8; m() { return this.#return / 2 + '/' + ''; } } ${ESC}`,
    'N4 a name outside ASCII ending in if': `const ${ch(0xe9)}if = (n) => n; void (${ch(0xe9)}if(4) / 2 + '/' + ''); ${ESC}`,
    'N5 a name outside ASCII ending in return': `const ${ch(0xe9)}return = 8; void (${ch(0xe9)}return / 2 + '/' + ''); ${ESC}`,
    'N6 a zero-width joiner inside a name': `const a${ch(0x200d)}if = (n) => n; void (a${ch(0x200d)}if(4) / 2 + '/' + ''); ${ESC}`,
    'W1 a no-break space between `.` and a keyword': `const o = { if: (n) => n }; void (o.${ch(0xa0)}if(4) / 2 + '/' + ''); ${ESC}`,
    'W1b a form feed': `const o = { if: (n) => n }; void (o.${ch(0x0c)}if(4) / 2 + '/' + ''); ${ESC}`,
    'W1c a vertical tab': `const o = { if: (n) => n }; void (o.${ch(0x0b)}if(4) / 2 + '/' + ''); ${ESC}`,
    'W1d a byte order mark': `const o = { if: (n) => n }; void (o.${ch(0xfeff)}if(4) / 2 + '/' + ''); ${ESC}`,
  };
  for (const [what, after] of Object.entries(cases)) assert.ok(weakens({ [F]: BASE }, { [F]: inComment(BASE, after) }).includes(HIDDEN), what);
});

test('N7: a name for the global object first on its line, in a ternary, waits; one that is a key after `{` or `,` does not', () => {
  for (const name of ['globalThis', 'global']) {
    const after = inComment(BASE, `const g = 1 ?\n  ${name} : 0;\ng['CHE' + 'CKS'] = ['a'];`);
    assert.ok(weakens({ [F]: BASE }, { [F]: after }).includes(HIDDEN), name);
  }
  assert.deepEqual(weakens({ [F]: BASE }, { [F]: `${BASE}const o = {\n  global: 1,\n  window: 2,\n};\n` }), []);
});

test('characters outside ASCII in strings and comments are read as before', () => {
  const add = (l: string) => weakens({ [F]: BASE }, { [F]: `${BASE}${l}\n` });
  assert.deepEqual(add(`const s = 'caf${ch(0xe9)} ${ch(0xa0)}';`), []);
  assert.deepEqual(add(`// caf${ch(0xe9)}`), []);
});
