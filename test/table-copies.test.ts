// #941: the scripts that run on their own carry a generated, deep-frozen copy of their tables file
// (scripts/lib/table-copies.mjs). Each copy is exactly what the generator makes of the data the weakening hold compares,
// so a copy can't be loosened on its own; and its values are the loader's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tablesFrom } from '../src/check-tables.js';
import { repoRoot } from './helpers.js';

type Copy = { script: string; exported: string[] };
type Lib = {
  COPIES: Copy[];
  resolved(root: string, c: Copy): Copy;
  tablesFileFor(script: string): string;
  blockFor(root: string, c: Copy, text: string): string;
  blockIn(text: string, c: Copy): string | null;
};
const lib = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'table-copies.mjs')).href)) as Lib;
const copies = lib.COPIES.map((c) => lib.resolved(repoRoot, c));

test("each script that runs on its own carries exactly what the generator makes of its tables file (#941)", () => {
  assert.equal(copies.length, 6);
  for (const c of copies) {
    const block = lib.blockIn(readFileSync(join(repoRoot, c.script), 'utf8'), c);
    assert.ok(block, `${c.script} has its generated block`);
    assert.equal(block, lib.blockFor(repoRoot, c, readFileSync(join(repoRoot, lib.tablesFileFor(c.script)), 'utf8')), `${c.script}: out of date: run node scripts/gen-table-copies.mjs --write`);
  }
});

test("a copy's tables are the loader's, deep-frozen; a copy changed on its own is caught (#941)", async () => {
  const shape = (v: unknown): unknown => (v instanceof Object && Symbol.iterator in v && !Array.isArray(v) ? { set: [...(v as Iterable<unknown>)] } : Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v);
  // A script with no table exported (the gate, which runs its main when imported) is held by its block alone.
  for (const c of copies.filter((x) => x.exported.length || x.script.endsWith('.cjs'))) {
    const data = tablesFrom(readFileSync(join(repoRoot, lib.tablesFileFor(c.script)), 'utf8'), c.script);
    // Only the exported ones (and the CommonJS helper's module.exports) can be read from outside.
    // The hook runs its main when imported: its tables are read from its --print-gate-files instead.
    const mod = (
      c.script === 'scripts/push-gate-hook.mjs'
        ? (({ code, rules }) => ({ GATE_CODE: Object.freeze(code), GATE_RULES: Object.freeze(rules) }))(JSON.parse(execFileSync(process.execPath, [join(repoRoot, c.script), '--print-gate-files'], { encoding: 'utf8' })) as { code: unknown; rules: unknown })
        : c.script.endsWith('.cjs')
          ? createRequire(import.meta.url)(join(repoRoot, c.script))
          : await import(pathToFileURL(join(repoRoot, c.script)).href)
    ) as Record<string, unknown>;
    for (const n of data.names.filter((n) => n in mod)) {
      assert.deepEqual(shape(mod[n]), shape(data.get(n)), `${c.script} ${n}`);
      // (The hook's values come back as JSON, so their freeze is the block's, checked above.)
      if (c.script !== 'scripts/push-gate-hook.mjs') assert.ok(Object.isFrozen(mod[n]), `${c.script} ${n} frozen`);
    }
  }
  // Fail-without of the drift check: the hook's block with an entry taken out is not what the generator makes.
  const hook = copies.find((c) => c.script === 'scripts/push-gate-hook.mjs')!;
  const text = readFileSync(join(repoRoot, hook.script), 'utf8').replace('"scripts/lib/denylist.mjs"', '');
  assert.notEqual(lib.blockIn(text, hook), lib.blockFor(repoRoot, hook, readFileSync(join(repoRoot, lib.tablesFileFor(hook.script)), 'utf8')));
});
