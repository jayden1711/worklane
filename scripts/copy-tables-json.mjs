#!/usr/bin/env node
// After tsc (#941; the owner's choice for the package budget, 2026-11-12): each src/**/*.tables.json goes into dist/ as
// one line of parsed and re-stringified JSON, not as tsc re-prints it (4-space indents, about 27 KB more over the 8
// files). The data is the same: the loader (src/check-tables.ts) parses the file in dist/, and the weakening hold
// (src/merge-policy-weakening.ts) parses the one in git; neither reads the layout.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const found = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.tables.json')) found.push(p);
  }
};
walk(join(root, 'src'));
for (const f of found) writeFileSync(join(root, 'dist', relative(root, f)), `${JSON.stringify(JSON.parse(readFileSync(f, 'utf8')))}\n`);
console.log(`copy-tables-json: ${found.length} tables files written to dist/src as data`);
