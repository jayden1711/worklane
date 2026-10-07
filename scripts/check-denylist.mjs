#!/usr/bin/env node
// Fail if project-specific terms leak into this repo.
//
//   node scripts/check-denylist.mjs            scan tracked + new files
//   node scripts/check-denylist.mjs --hash t   print the hash entry for term t
//
// .denylist.json holds SHA-256 hashes of denied terms (lowercase), so the
// list doesn't publish the very names it protects, plus plain regexes for
// generic shapes. Hashes hide terms from casual reading, not from someone
// who guesses them. .denylist-allow lists intentional mentions, one per line:
//   <path-glob> <term>       e.g.  README.md some-handle
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sha = (t) => createHash('sha256').update(t).digest('hex');

const args = process.argv.slice(2);
if (args[0] === '--hash') {
  for (const t of args.slice(1)) console.log(`"${sha(t.toLowerCase())}"`);
  process.exit(0);
}
const root = args[0] ?? '.';

const config = JSON.parse(readFileSync(join(root, '.denylist.json'), 'utf8'));
const hashed = new Set(config.hashed ?? []);
const patterns = (config.patterns ?? []).map((p) => ({ src: p, re: new RegExp(p, 'g') }));

const allowFile = join(root, '.denylist-allow');
const allow = existsSync(allowFile)
  ? readFileSync(allowFile, 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim())
      .filter(Boolean)
      .map((l) => {
        const [glob, term] = l.split(/\s+/);
        return { re: globToRe(glob), term: term.toLowerCase() };
      })
  : [];

function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp(`^${re}$`);
}

const allowed = (path, term) => allow.some((a) => a.term === term && a.re.test(path));

// Every word, plus its parts split on . _ - (so "a.b-c" checks a, b, c, b-c, a.b-c).
function tokens(line) {
  const out = new Set();
  for (const m of line.toLowerCase().matchAll(/[a-z0-9][a-z0-9._@-]*[a-z0-9]|[a-z0-9]/g)) {
    const w = m[0];
    out.add(w);
    for (const sep of [/[.]/, /[._@]/, /[._@-]/]) for (const p of w.split(sep)) if (p) out.add(p);
  }
  return out;
}

const SKIP = new Set(['.denylist.json', '.denylist-allow', 'package-lock.json', 'LICENSE']);
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
  if (text.includes('\0')) continue;
  text.split('\n').forEach((line, i) => {
    for (const t of tokens(line)) {
      if (hashed.has(sha(t)) && !allowed(file, t)) hits.push(`${file}:${i + 1}: denied term "${t}"`);
    }
    for (const { src, re } of patterns) {
      for (const m of line.matchAll(re)) {
        if (!allowed(file, m[0].toLowerCase())) hits.push(`${file}:${i + 1}: "${m[0]}" matches /${src}/`);
      }
    }
  });
}

if (hits.length) {
  console.error('Project-specific terms found. Describe the need generically, move project details to the');
  console.error("project's own .worklane/ folder, or add an intentional mention to .denylist-allow:\n");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`denylist: ${files.length} files clean`);
