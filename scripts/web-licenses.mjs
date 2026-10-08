#!/usr/bin/env node
// Writes dist/web/licenses.txt: the license text of every package bundled into
// the dashboard (MIT/ISC require shipping the notice with copies). Walks the
// runtime dependency tree of the UI's direct imports.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['react', 'react-dom', 'cmdk', '@radix-ui/react-dialog', 'lucide-react'];
const seen = new Map();
function visit(name) {
  if (seen.has(name)) return;
  const dir = join(root, 'node_modules', name);
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) return;
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  const lic = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  seen.set(name, { version: pkg.version, license: pkg.license ?? 'see text', text: lic ? readFileSync(join(dir, lic), 'utf8').trim() : `(${pkg.license}; no license file in the package)` });
  for (const d of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) })) visit(d);
}
ROOTS.forEach(visit);
const out = [`Third-party software bundled in this dashboard (${seen.size} packages).`, ''];
for (const [name, p] of [...seen].sort()) out.push('='.repeat(72), `${name}@${p.version} (${p.license})`, '-'.repeat(72), p.text, '');
const target = join(root, 'dist', 'web', 'licenses.txt');
writeFileSync(target, out.join('\n'));
console.log(`wrote ${target}: ${seen.size} packages (${[...new Set([...seen.values()].map((p) => p.license))].join(', ')})`);
