#!/usr/bin/env node
// Writes the generated table copies of the scripts that run on their own (scripts/lib/table-copies.mjs says why).
// Usage: node scripts/gen-table-copies.mjs [--write]   (without --write: exit 1 when a copy is out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockFor, blockIn, COPIES, resolved, tablesFileFor, withBlock } from './lib/table-copies.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let stale = 0;
for (const c of COPIES.map((x) => resolved(root, x))) {
  const file = join(root, c.script);
  const text = readFileSync(file, 'utf8');
  const block = blockFor(root, c, readFileSync(join(root, tablesFileFor(c.script)), 'utf8'));
  if (blockIn(text, c) === block) console.log(`${c.script}: its tables copy is current`);
  else if (process.argv.includes('--write')) {
    writeFileSync(file, withBlock(text, c, block));
    console.log(`${c.script}: its tables copy written`);
  } else {
    console.error(`${c.script}: its tables copy is out of date: run node scripts/gen-table-copies.mjs --write`);
    stale++;
  }
}
if (stale) process.exit(1);
