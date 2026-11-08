// #941: the test tables stay code (read by the weakening hold's line reader), and the test loader freezes each one
// once its module has run (test/table-freeze.ts, registered by test/isolate.ts in every test process the suite starts).
// This file registers tables of its own, so the hook's work is checked where it happens: under the suite's preload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeTestTable } from './isolate.js';
import { freezeLine } from './table-freeze.js';

/** A probe: rules, as a test table holds them. */
// check-table: never-shrink
const PROBE_RULES = ['a', 'b', ['nested']];

/** A probe: a set. */
// check-table: never-shrink
const PROBE_WORDS = new Set(['w']);

test('a test table is frozen by the test loader before its tests run: a write throws (#941)', () => {
  assert.ok(Object.isFrozen(PROBE_RULES), 'run under the preload (--import ./dist/test/isolate.js): the hook froze it');
  assert.throws(() => PROBE_RULES.push('c'), TypeError);
  assert.throws(() => ((PROBE_RULES[2] as string[]).length = 0), TypeError);
  assert.throws(() => PROBE_WORDS.add('x'), TypeError);
  assert.throws(() => PROBE_WORDS.clear(), TypeError);
  assert.deepEqual([...PROBE_WORDS], ['w']);
});

test("the loader adds one freeze line for a module's registered tables, and none for a mark in a fixture's text (#941)", () => {
  const src = "// check-table: never-shrink\nconst RULES = ['a'];\nconst DOC = `\n// check-table: never-grow\nconst ALLOWED = [];\n`;\n";
  const line = freezeLine(src, 'file:///x/dist/test/a.test.js')!;
  assert.ok(line.includes("typeof RULES !== 'undefined'") && line.includes("typeof ALLOWED !== 'undefined'"), line);
  assert.equal(freezeLine("const RULES = ['a'];\n", 'file:///x.js'), null, 'no mark, no line');
  // A name the module doesn't bind (the fixture's ALLOWED) is left alone: the line runs without throwing.
  const run = new Function(`const RULES = ['a']; let frozen = []; const globalThis = { [Symbol.for('worklane.test.freezeTable')]: (v) => frozen.push(v) }; ${line} return frozen;`);
  assert.deepEqual(run(), [['a']]);
});

test('freezeTestTable leaves a RegExp alone (freezing one breaks a global regexp and stops no compile) and freezes the rest (#941)', () => {
  const t = { re: /x/g, list: [1], map: new Map([['k', [2]]]) };
  freezeTestTable(t);
  assert.ok(!Object.isFrozen(t.re) && t.re.test('x'), 'the RegExp still works');
  assert.throws(() => t.list.push(3), TypeError);
  assert.throws(() => t.map.set('j', [3]), TypeError);
  assert.throws(() => t.map.get('k')!.push(3), TypeError);
});
