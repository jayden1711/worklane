#!/usr/bin/env node
// The packages the desktop backstop (test/desktop-removed.test.ts) loads, checked before any of them runs (#746
// round 21): CI's test shards run this right after `npm ci --ignore-scripts` and before the locked `tsc` builds.
// Built-ins only, and in scripts/ci/ (a guard path), so a changed line here waits for the owner.
//
// For each pinned package it refuses unless:
//   - package-lock.json's entry carries the pinned integrity and is no link (npm ci checks the tarball against it);
//   - the installed directory, node_modules/<name>, is a plain directory whose files hash to the pinned tree hash
//     (so bytes changed after the install, or by a swapped tarball whose lockfile line was put back, are refused);
//   - the repo's own package.json isn't named after it (a self-reference resolves first);
//   - Node's resolver, from every place in the checkout that loads code (dist/test/, dist/src/ and its folders,
//     test/, the top), finds it in the top node_modules/<name>/, links resolved.
// And for the whole checkout, outside .git and the top node_modules (round 22; a symlinked dist/node_modules and a
// dist/test/package.json named yaml got past round 21's walk, which looked only at plain directories):
//   - no entry named node_modules, of any type (a directory, a symlink, a file);
//   - no symbolic link at all (a linked dist/, dist/test/ or folder can hold either of these);
//   - no package.json but the top one and ALLOWED_PACKAGE_JSON (a nested one is a package scope, and its name or
//     exports can answer a bare import first, under conditions require.resolve doesn't try).
// The integrity strings are the test's PINNED_PACKAGES, which checks they agree. A bump of either package changes
// both files, and each change waits for the owner.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package.json files the checkout may hold besides its top one (tracked today: examples/basic only). */
// check-table: never-grow
export const ALLOWED_PACKAGE_JSON = ['examples/basic/package.json'];
/** The places, relative to the top, that load code in a test shard: Node resolves a bare name from each. */
export const LOADERS = ['x.js', 'test/x.js', 'dist/test/x.js', 'dist/src/x.js', 'dist/src/os/x.js', 'dist/src/coordinator/x.js', 'dist/src/guardrails/x.js'];

export const PINS = {
  yaml: {
    integrity: 'sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==',
    tree: 'fd705c159cda06094fac0519b9656ba80d6cba67fe6768f5ab2150fc13780286',
  },
  typescript: {
    integrity: 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==',
    tree: '39f8494b8a73a0e7b0ac40d4e89d0dd3efe8c53d79f4f8451be5543936dd3d04',
  },
};

/** Every regular file under `dir`, as a sorted list of POSIX paths relative to it; null if anything else is there. */
function filesOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(dir, p).split(sep).join('/'));
      else throw new Error(`${p}: neither a file nor a directory`);
    }
  };
  walk(dir);
  return out.sort();
}

/** One hash over a directory's files: each path, its size and its bytes, in path order. */
export function treeHash(dir) {
  const h = createHash('sha256');
  for (const rel of filesOf(dir)) {
    const bytes = readFileSync(join(dir, rel));
    h.update(`${rel}\0${bytes.length}\0`);
    h.update(bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Why the checkout at `root` may load another package than the pinned one; empty when it can't. `pins` defaults to
 * PINS (a fixture test passes its own).
 */
export function pinProblems(root, pins = PINS) {
  const out = [];
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // The checkout first (round 22): a nested node_modules of any type, any symlink, a nested package.json.
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(root, p).split(sep).join('/');
      if (d === root && (name === 'node_modules' || name === '.git')) continue;
      const st = lstatSync(p);
      if (name === 'node_modules') out.push(`${rel}: a node_modules Node would look in first`);
      if (st.isSymbolicLink()) out.push(`${rel}: a symbolic link`);
      else if (st.isDirectory()) walk(p);
      else if (name === 'package.json' && rel !== 'package.json' && !ALLOWED_PACKAGE_JSON.includes(rel)) out.push(`${rel}: a package.json besides the top one (a package scope)`);
    }
  };
  walk(root);
  for (const [name, pin] of Object.entries(pins)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (entry?.integrity !== pin.integrity) out.push(`${name}: the lockfile's integrity is ${JSON.stringify(entry?.integrity)}`);
    if (entry?.link) out.push(`${name}: the lockfile entry is a link`);
    if (pkg.name === name) out.push(`${name}: package.json is named ${name}`);
    const dir = join(root, 'node_modules', name);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      out.push(`${name}: not installed`);
      continue;
    }
    if (!st.isDirectory()) {
      out.push(`${name}: node_modules/${name} is not a plain directory`);
      continue;
    }
    let tree;
    try {
      tree = treeHash(dir);
    } catch (e) {
      out.push(`${name}: ${e.message}`);
      continue;
    }
    if (tree !== pin.tree) out.push(`${name}: the installed files hash to ${tree}`);
    // Where Node's resolver finds the name from each place that loads code, links resolved: the top copy only.
    const top = realpathSync(dir) + sep;
    for (const from of LOADERS) {
      let at;
      try {
        at = realpathSync(createRequire(join(root, from)).resolve(name));
      } catch (e) {
        out.push(`${name}: not resolvable from ${from} (${e.code ?? e.message})`);
        continue;
      }
      if (!at.startsWith(top)) out.push(`${name}: resolves from ${from} to ${relative(root, at)}`);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
  const problems = pinProblems(root);
  for (const p of problems) console.error(`check-pins: ${p}`);
  if (problems.length) process.exit(1);
  console.log(`check-pins: ${Object.keys(PINS).join(', ')} are the pinned ones`);
}
