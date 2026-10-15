#!/usr/bin/env node
// Writes dist/web/licenses.txt: the license text of every package bundled into the dashboard (MIT/ISC require
// shipping the notice with copies). Walks the runtime dependency tree of the UI's direct imports.
//
// INVARIANT: byte-identical output for a given package-lock.json, on any machine and filesystem (#458: a rebuild of
// the signed v0.5.0 gave another licenses.txt). So:
//   - a dependency resolves as Node and the bundler resolve it: the requiring package's own node_modules first, then
//     each parent's, up to the root; and the version found must be package-lock.json's for that path;
//   - a missing dependency fails the build (no silent gap); an optional peer is left out (types only, not bundled);
//   - the license file is chosen by a fixed preference (LICENSE, LICENSE.md, LICENSE.txt, LICENCE..., COPYING...),
//     never by directory order;
//   - line endings are LF and a leading BOM is dropped (git stores this file with LF: a CRLF license, as tslib's,
//     made the built bytes differ from the committed ones);
//   - packages are listed by name, then version, by code point (no locale).
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOTS = ['react', 'react-dom', 'cmdk', '@radix-ui/react-dialog', 'lucide-react'];
const LICENSE_FILE = /^(licen[cs]e|copying)(\.|$)/i;
const PREFERRED = ['license', 'license.md', 'license.txt', 'licence', 'licence.md', 'licence.txt', 'copying', 'copying.md', 'copying.txt'];
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The license file to read among a package's files: the preferred names first, then the rest by code point. */
export function pickLicenseFile(names) {
  const rank = (n) => {
    const i = PREFERRED.indexOf(n.toLowerCase());
    return i < 0 ? PREFERRED.length : i;
  };
  return names.filter((n) => LICENSE_FILE.test(n)).sort((a, b) => rank(a) - rank(b) || byCodePoint(a, b))[0];
}

/** LF line endings, no BOM, no surrounding blank space. */
export const normalizeText = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();

/** licenses.txt for the packages `roots` reach from `root`'s node_modules, checked against its package-lock.json. */
export function licensesText(root, roots = ROOTS) {
  const lockFile = join(root, 'package-lock.json');
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')).packages ?? {} : null;
  const seen = new Map();
  const resolve = (name, from) => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
      if (dir === root || dirname(dir) === dir) return null;
    }
  };
  const visit = (name, from, why) => {
    const dir = resolve(name, from);
    if (!dir) throw new Error(`web-licenses: ${name} (needed by ${why}) isn't installed: run npm ci`);
    const key = relative(root, dir).split(sep).join('/');
    if (seen.has(key)) return;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (lock && lock[key]?.version !== pkg.version) {
      throw new Error(`web-licenses: ${key} is ${pkg.version}, package-lock.json says ${lock[key]?.version ?? 'nothing'}: run npm ci`);
    }
    const file = pickLicenseFile(readdirSync(dir));
    const text = file ? normalizeText(readFileSync(join(dir, file), 'utf8')) : `(${pkg.license}; no license file in the package)`;
    seen.set(key, { name: pkg.name ?? name, version: pkg.version, license: pkg.license ?? 'see text', text });
    const optionalPeer = (d) => pkg.peerDependenciesMeta?.[d]?.optional === true;
    const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}).filter((d) => !optionalPeer(d))];
    for (const d of [...new Set(deps)].sort(byCodePoint)) visit(d, dir, key);
  };
  for (const r of roots) visit(r, root, 'the dashboard');
  const pkgs = [...seen.values()].sort((a, b) => byCodePoint(a.name, b.name) || byCodePoint(a.version, b.version));
  const out = [`Third-party software bundled in this dashboard (${pkgs.length} packages).`, ''];
  for (const p of pkgs) out.push('='.repeat(72), `${p.name}@${p.version} (${p.license})`, '-'.repeat(72), p.text, '');
  return { text: out.join('\n'), packages: pkgs };
}

// Run as a script (not imported): argv[1] through any symlink, as import.meta.url is.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { text, packages } = licensesText(root);
  const target = join(root, 'dist', 'web', 'licenses.txt');
  writeFileSync(target, text);
  console.log(`wrote ${target}: ${packages.length} packages (${[...new Set(packages.map((p) => p.license))].join(', ')})`);
}
