#!/usr/bin/env node
// Writes the root updater's generated copy of the shared redactor (scripts/lib/redact-vendor.mjs says why).
// Usage: node scripts/gen-redact-vendor.mjs [--write]   (without --write: exit 1 when the copy is out of date)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockIn, vendoredBlock, withBlock } from './lib/redact-vendor.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const machine = join(root, 'scripts', 'machine');
const updaters = readdirSync(machine).filter((f) => f.endsWith('-update.cjs'));
if (updaters.length !== 1) throw new Error(`expected one scripts/machine/*-update.cjs, found ${updaters.length}`);
const file = join(machine, updaters[0]);
const text = readFileSync(file, 'utf8');
const block = vendoredBlock(readFileSync(join(root, 'src', 'events', 'redact.ts'), 'utf8'));
if (blockIn(text) === block) {
  console.log(`${updaters[0]}: the redactor copy is current`);
} else if (process.argv.includes('--write')) {
  writeFileSync(file, withBlock(text, block));
  console.log(`${updaters[0]}: the redactor copy written`);
} else {
  console.error(`${updaters[0]}: the redactor copy is out of date: run node scripts/gen-redact-vendor.mjs --write`);
  process.exit(1);
}
