import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import ts from 'typescript';
import { repoRoot } from './helpers.js';

// WHY: an install of the package gets `dependencies` only. A package the built engine imports that is only a
// devDependency installs fine and then crashes the command that reaches it (the release's tarball check runs
// --version and init --help, not every path); a build-only tool (vite, typescript, react) in `dependencies` makes
// every install download it for nothing. So the built engine's imports and `dependencies` are kept the same set.

/** The package a bare specifier names (`@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`); null for a relative one or a builtin. */
function packageOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || isBuiltin(spec)) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** The packages a built module imports: static and dynamic imports, require() and re-exports (not text in strings). */
function importedPackages(source: string): string[] {
  const { importedFiles } = ts.preProcessFile(source, true, true);
  return [...new Set(importedFiles.map((f) => packageOf(f.fileName)).filter((p): p is string => p !== null))];
}

/** What is wrong between the built engine's imports (package -> the files importing it) and package.json. */
function dependencyProblems(imports: ReadonlyMap<string, readonly string[]>, pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string[] {
  const deps = Object.keys(pkg.dependencies ?? {});
  const problems: string[] = [];
  for (const [p, files] of [...imports].sort()) {
    if (!deps.includes(p)) problems.push(`${p} is imported at run time (${files.slice(0, 3).join(', ')}) but is not in dependencies: an install from the package won't have it`);
  }
  for (const d of deps) {
    if (!imports.has(d)) problems.push(`${d} is in dependencies but nothing in dist/src imports it: a build-only package belongs in devDependencies (every install downloads dependencies)`);
    if (pkg.devDependencies && d in pkg.devDependencies) problems.push(`${d} is in both dependencies and devDependencies`);
  }
  return problems;
}

/** Every built engine module (dist/src/**\/*.js), relative to the repo root. */
function builtModules(dir = join(repoRoot, 'dist', 'src')): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? builtModules(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('packageOf: the package of a bare specifier; null for relative paths and builtins', () => {
  assert.equal(packageOf('zod'), 'zod');
  assert.equal(packageOf('zod/mini'), 'zod');
  assert.equal(packageOf('@scope/name/sub'), '@scope/name');
  assert.equal(packageOf('./x.js'), null);
  assert.equal(packageOf('../x.js'), null);
  assert.equal(packageOf('node:fs'), null);
  assert.equal(packageOf('fs'), null);
});

test('importedPackages: static, dynamic, require and re-export; never a specifier inside a string', () => {
  const src = [
    "import { a } from 'alpha';",
    "import 'beta/side';",
    "export { c } from '@gamma/core';",
    "const d = await import('delta');",
    "const e = require('epsilon');",
    "import { readFileSync } from 'node:fs';",
    "import { x } from './local.js';",
    "const script = `const { Client } = require('in-a-template'); import('also-text')`;",
    "const s = \"import { y } from 'in-a-string'\";",
  ].join('\n');
  assert.deepEqual(importedPackages(src).sort(), ['@gamma/core', 'alpha', 'beta', 'delta', 'epsilon']);
});

test('dependencyProblems: a run-time import missing from dependencies, and a dependency nothing imports, each fail', () => {
  const imports = new Map([['zod', ['dist/src/a.js']], ['yaml', ['dist/src/b.js']]]);
  assert.deepEqual(dependencyProblems(imports, { dependencies: { zod: '1', yaml: '1' }, devDependencies: { vite: '1' } }), []);
  const missing = dependencyProblems(imports, { dependencies: { zod: '1' }, devDependencies: { yaml: '1' } });
  assert.equal(missing.length, 1);
  assert.match(missing[0]!, /^yaml is imported at run time \(dist\/src\/b\.js\) but is not in dependencies/);
  const buildOnly = dependencyProblems(imports, { dependencies: { zod: '1', yaml: '1', vite: '1' } });
  assert.equal(buildOnly.length, 1);
  assert.match(buildOnly[0]!, /^vite is in dependencies but nothing in dist\/src imports it/);
});

test("the built engine's imports and package.json's dependencies are the same set (build tools only in devDependencies)", () => {
  const imports = new Map<string, string[]>();
  const modules = builtModules();
  assert.ok(modules.length > 50, `found the built engine (${modules.length} modules; run npm run build)`);
  for (const file of modules) {
    for (const p of importedPackages(readFileSync(file, 'utf8'))) imports.set(p, [...(imports.get(p) ?? []), file.slice(repoRoot.length).replace(/^[\\/]/, '')]);
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert.deepEqual(dependencyProblems(imports, pkg), []);
});
