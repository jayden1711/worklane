// #941: the test tables stay code (read by the weakening hold's line reader), and the test loader freezes each one
// right after its declaration (test/table-freeze.ts, registered by test/isolate.ts in every test process the suite
// starts). This file registers tables of its own, so the hook's work is checked where it happens: under the preload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frozenSet } from '../src/check-tables.js';
import { freezeTestTable } from './isolate.js';
import * as me from './table-freeze.test.js';
import { withFreezes } from './table-freeze.js';

/** A probe: rules, as a test table holds them. */
// check-table: never-shrink
export const PROBE_RULES = ['a', 'b', ['nested']];

/** A probe: a set, as a test table holds one (a frozenSet: a Set can't be frozen). */
// check-table: never-shrink
const PROBE_WORDS = frozenSet(['w']);

// R1184l's shape: this module's own later top-level code tries to empty its table, through its own namespace. The
// table was frozen when its statement ended, so the write throws here, at load.
let selfWrite: unknown = null;
try {
  (me.PROBE_RULES as unknown[]).length = 1;
} catch (e) {
  selfWrite = e;
}

test('a test table is frozen right after its declaration: a write throws, from another place or from its own module (#941)', () => {
  assert.ok(Object.isFrozen(PROBE_RULES), 'run under the preload (--import ./dist/test/isolate.js): the hook froze it');
  assert.ok(selfWrite instanceof TypeError, 'its own module emptying it at top level, after it, through its namespace');
  assert.deepEqual(PROBE_RULES, ['a', 'b', ['nested']]);
  assert.throws(() => PROBE_RULES.push('c'), TypeError);
  assert.throws(() => ((PROBE_RULES[2] as string[]).length = 0), TypeError);
  assert.equal((PROBE_WORDS as unknown as { add?: unknown }).add, undefined);
  assert.throws(() => Set.prototype.clear.call(PROBE_WORDS as unknown as Set<string>), TypeError);
  assert.throws(() => Set.prototype.delete.call(PROBE_WORDS as unknown as Set<string>, 'w'), TypeError);
  assert.deepEqual([...PROBE_WORDS], ['w']);
});

test("the loader freezes after each top-level statement that declares a registered table, and never inside a fixture's text (#941)", () => {
  const src = "// check-table: never-shrink\nconst RULES = ['a'];\nconst DOC = `\n// check-table: never-grow\nconst ALLOWED = [];\n`;\nRULES.length = 0;\n";
  const out = withFreezes(src, 'file:///x/dist/test/a.test.js')!;
  assert.equal(out.split('\n').length, src.split('\n').length, 'no line moves');
  assert.ok(out.split('\n')[1]!.includes('(RULES, '), `frozen on its own line: ${out}`);
  assert.ok(!out.includes('(ALLOWED, ') && out.includes('const ALLOWED = [];\n`'), 'the fixture text is unchanged');
  assert.equal(withFreezes("const RULES = ['a'];\n", 'file:///x.js'), null, 'no mark, no change');
  // Run: the table is frozen before the line after it, so that line's write throws.
  const frozen: unknown[] = [];
  // Strict, as a module is (a sloppy write to a frozen object is ignored, not refused).
  const run = new Function('freeze', '"use strict";\n' + out.replace(/globalThis\[Symbol\.for\("worklane\.test\.freezeTable"\)\]/g, 'freeze'));
  assert.throws(() => run((v: unknown) => (frozen.push(v), Object.freeze(v))), TypeError);
  assert.deepEqual(frozen, [['a']]);
});

test('freezeTestTable refuses a Set or a Map anywhere in a table, leaves a RegExp and a Buffer, and freezes the rest (#941)', () => {
  assert.throws(() => freezeTestTable(new Set(['a'])), /can't be one/);
  assert.throws(() => freezeTestTable({ inner: new Map() }), /a Map/);
  const t = { re: /x/g, buf: Buffer.from('ab'), list: [1], deep: { k: [2] } };
  freezeTestTable(t);
  assert.ok(!Object.isFrozen(t.re) && t.re.test('x'), 'the RegExp still works');
  assert.throws(() => t.list.push(3), TypeError);
  assert.throws(() => t.deep.k.push(3), TypeError);
});
