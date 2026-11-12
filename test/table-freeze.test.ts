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

/** The preload's deep frozen-check, read from its non-writable global (R1184al D1: never through a helper's global). */
const deepFrozen = (globalThis as Record<symbol, (v: unknown) => boolean>)[Symbol.for('worklane.test.deepFrozen')]!;

test("every table a test helper registers is deep-frozen, read with the preload's own built-ins (#941, R1184al D1)", async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { registrationsOf } = await import('../src/merge-policy-weakening.js');
  const { repoRoot } = await import('./helpers.js');
  assert.equal(typeof deepFrozen, 'function', 'the preload set its check');
  const desc = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('worklane.test.freezeTable'))!;
  assert.deepEqual([desc.writable, desc.configurable], [false, false], 'the freeze global is neither writable nor configurable');
  for (const m of ['raw-check-reads', 'token-standins', 'host-tools']) {
    const names = registrationsOf(readFileSync(join(repoRoot, 'test', `${m}.ts`), 'utf8')).tables.map((t) => t.table);
    assert.ok(names.length > 0, `${m} registers tables`);
    const mod = (await import(`./${m}.js`)) as Record<string, unknown>;
    for (const n of names.filter((x) => x in mod)) assert.ok(deepFrozen(mod[n]), `${m} ${n} deep-frozen`);
  }
});

test('a helper imported before a table module can neither replace the freeze nor undo it by replacing Object.freeze (#941, R1184al D1)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');
  const { repoRoot } = await import('./helpers.js');
  // Under dist/test, so the loader's hook treats them as test modules; removed after.
  const dir = join(repoRoot, 'dist', 'test');
  const tag = randomBytes(4).toString('hex');
  const [helper, main] = [join(dir, `zz-al-helper-${tag}.js`), join(dir, `zz-al-main-${tag}.js`)];
  try {
    // AL2a: the freeze global replaced; AL2f: Object.freeze replaced (each as a helper would, before the table loads).
    writeFileSync(helper, "export let wrote = 'no';\ntry { globalThis[Symbol.for('worklane.test.freezeTable')] = () => {}; wrote = 'yes'; } catch { wrote = 'refused'; }\nObject.freeze = (x) => x;\n");
    writeFileSync(main, `import { wrote } from './zz-al-helper-${tag}.js';\nimport { RAW_READS_ALLOWED } from './raw-check-reads.js';\nconst check = globalThis[Symbol.for('worklane.test.deepFrozen')];\nlet grew = 'no';\ntry { RAW_READS_ALLOWED['src/x.ts'] = 'x'; grew = String('src/x.ts' in RAW_READS_ALLOWED); } catch { grew = 'refused'; }\nconsole.log(JSON.stringify({ wrote, frozen: check(RAW_READS_ALLOWED), grew }));\n`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'isolate.js')).href, main], { encoding: 'utf8', env: process.env, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { wrote: string; frozen: boolean; grew: string };
    assert.deepEqual(out, { wrote: 'refused', frozen: true, grew: 'refused' });
  } finally {
    rmSync(helper, { force: true });
    rmSync(main, { force: true });
  }
});
