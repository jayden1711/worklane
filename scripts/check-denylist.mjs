#!/usr/bin/env node
// Fail if project-specific terms leak into this repo (rules: scripts/lib/denylist.mjs).
//
//   node scripts/check-denylist.mjs            scan tracked + new files
//   node scripts/check-denylist.mjs --hash t   print the hash entry for term t
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRules, scanBinary, scanText, sha, SKIP } from './lib/denylist.mjs';

const args = process.argv.slice(2);
if (args[0] === '--hash') {
  for (const t of args.slice(1)) console.log(`"${sha(t.toLowerCase())}"`);
  process.exit(0);
}
const root = args[0] ?? '.';
const rules = loadRules(root);
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.has(f));

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    continue;
  }
  // A file holding a NUL byte is scanned for the hashed terms, as the push gate does (#1057).
  hits.push(...(text.includes('\0') ? scanBinary(rules, file, text) : scanText(rules, file, text)));
}

if (hits.length) {
  console.error('Project-specific terms found. Describe the need generically, move project details to the');
  console.error("project's own instance config, or add an intentional mention to .denylist-allow:\n");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`denylist: ${files.length} files clean`);
