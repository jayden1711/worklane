#!/usr/bin/env node
// Rename the product everywhere in one pass.
//   npm run rename -- <newname> [--dry-run]
// Reads the current name from src/brand.ts, then rewrites the three case
// variants (Name, name, NAME) in every tracked or new non-ignored text file.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Files that mention the name as data, not as our identity.
const SKIP = new Set(['LICENSE', 'CODE_OF_CONDUCT.md', 'docs/names.md', 'package-lock.json']);

const [next, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
if (!next || !/^[a-z][a-z0-9-]{1,30}$/.test(next)) {
  console.error('usage: npm run rename -- <newname> [--dry-run]   (lowercase, [a-z0-9-])');
  process.exit(2);
}

const brand = readFileSync('src/brand.ts', 'utf8');
const current = brand.match(/cli: '([a-z0-9-]+)'/)?.[1];
if (!current) throw new Error('could not read current name from src/brand.ts');
if (current === next) {
  console.log(`already named ${next}`);
  process.exit(0);
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const pairs = [
  [cap(current), cap(next)],
  [current.toUpperCase(), next.toUpperCase().replaceAll('-', '_')],
  [current, next],
];

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.has(f));

let changed = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  if (text.includes('\0')) continue; // binary
  let out = text;
  for (const [from, to] of pairs) out = out.replaceAll(from, to);
  if (out !== text) {
    changed++;
    console.log(`${dryRun ? 'would update' : 'updated'} ${file}`);
    if (!dryRun) writeFileSync(file, out);
  }
}
console.log(`${current} -> ${next}: ${changed} file(s)${dryRun ? ' (dry run)' : ''}`);
if (!dryRun && changed) console.log('next: npm install (refresh lockfile), npm test, rename the GitHub repo');
