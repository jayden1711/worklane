// lint-test
// #746 round 22: scripts/ci/check-pins.mjs runs in every CI test shard before any pinned package (yaml, typescript)
// runs, and refuses a checkout where Node could load another copy of one. Round 21's walk looked only at plain
// directories, so a symlinked dist/node_modules and a dist/test/package.json named yaml got past it (measured by both
// reviews of dafd6977). Each fixture is a scratch checkout with one such shape; the control has none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
type Pin = { integrity: string; tree: string };
const { pinProblems, PINS } = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'check-pins.mjs')).href)) as {
  pinProblems: (root: string, pins?: Record<string, Pin>) => string[];
  PINS: Record<string, Pin>;
};

/** A scratch checkout: a package.json, a lockfile with yaml's pinned entry, the installed yaml copied, an empty dist/test/. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'pins-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/yaml': { integrity: PINS.yaml!.integrity } } }));
  cpSync(join(repoRoot, 'node_modules', 'yaml'), join(root, 'node_modules', 'yaml'), { recursive: true });
  mkdirSync(join(root, 'dist', 'test'), { recursive: true });
  return root;
}
/** A stand-in yaml package at `dir`. */
function standIn(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'yaml', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), 'module.exports = {};\n');
}

/** [label, the shape added to a scratch checkout, a word the refusal must hold] */
// check-table: never-shrink
const PIN_LAYOUT_FIXTURES: [string, (root: string) => void, string][] = [
  ['a symlinked dist/node_modules to a stand-in yaml', (root) => {
    standIn(join(root, 'evil', 'yaml'));
    symlinkSync('../evil', join(root, 'dist', 'node_modules'));
  }, 'dist/node_modules: a node_modules'],
  ['a plain file named node_modules', (root) => writeFileSync(join(root, 'dist', 'node_modules'), ''), 'dist/node_modules: a node_modules'],
  ['a node_modules directory under dist/test', (root) => standIn(join(root, 'dist', 'test', 'node_modules', 'yaml')), 'dist/test/node_modules: a node_modules'],
  ['a dist/test/package.json named yaml, exports for import only', (root) => {
    writeFileSync(join(root, 'dist', 'test', 'package.json'), JSON.stringify({ name: 'yaml', type: 'module', exports: { import: './yaml-evil.mjs' } }));
    writeFileSync(join(root, 'dist', 'test', 'yaml-evil.mjs'), 'export {};\n');
  }, 'dist/test/package.json: a package.json'],
  ['a dist/test/package.json named yaml, exports for require too', (root) => {
    writeFileSync(join(root, 'dist', 'test', 'package.json'), JSON.stringify({ name: 'yaml', exports: './yaml-evil.js' }));
    writeFileSync(join(root, 'dist', 'test', 'yaml-evil.js'), 'module.exports = {};\n');
  }, 'yaml: resolves from dist/test/x.js to dist/test/yaml-evil.js'],
  ['a symlink elsewhere', (root) => symlinkSync(join(root, 'package.json'), join(root, 'linked.json')), 'linked.json: a symbolic link'],
  ['a symlinked dist/test', (root) => {
    mkdirSync(join(root, 'elsewhere'));
    cpSync(join(root, 'dist', 'test'), join(root, 'elsewhere', 'test'), { recursive: true });
    standIn(join(root, 'elsewhere', 'node_modules', 'yaml'));
    symlinkSync('../elsewhere/test', join(root, 'dist', 'test2'));
  }, 'dist/test2: a symbolic link'],
];

test('the pin check refuses every place Node could find another yaml first, and passes a clean checkout (round 22)', () => {
  const pins = { yaml: PINS.yaml! };
  assert.deepEqual(pinProblems(checkout(), pins), [], 'the control: a clean checkout');
  for (const [label, add, word] of PIN_LAYOUT_FIXTURES) {
    const root = checkout();
    add(root);
    const problems = pinProblems(root, pins);
    assert.ok(problems.some((p) => p.includes(word)), `${label}: ${JSON.stringify(problems)}`);
  }
});
