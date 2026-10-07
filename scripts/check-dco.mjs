#!/usr/bin/env node
// Fail if any commit in <base>..<head> lacks a Signed-off-by trailer that
// matches its author (Developer Certificate of Origin, see CONTRIBUTING.md).
//   node scripts/check-dco.mjs <base> [head]
import { execFileSync } from 'node:child_process';

const [base, head = 'HEAD'] = process.argv.slice(2);
if (!base) {
  console.error('usage: check-dco.mjs <base> [head]');
  process.exit(2);
}

const SEP = '\x1e';
const log = execFileSync(
  'git',
  ['log', '--no-merges', `--format=%H%x1f%an <%ae>%x1f%B${SEP}`, `${base}..${head}`],
  { encoding: 'utf8' },
);

const bad = [];
for (const entry of log.split(SEP)) {
  if (!entry.trim()) continue;
  const [sha, author, body] = entry.trim().split('\x1f');
  const signoffs = [...(body ?? '').matchAll(/^Signed-off-by: (.+)$/gm)].map((m) => m[1].trim());
  if (!signoffs.includes(author)) bad.push(`${sha.slice(0, 10)} ${author}`);
}

if (bad.length) {
  console.error('Commits missing a matching "Signed-off-by:" (use `git commit -s`):');
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log('DCO: all commits signed off');
