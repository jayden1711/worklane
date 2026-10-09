// Shared rules for the denylist check and the push gate.
//
// .denylist.json holds SHA-256 hashes of denied terms (lowercase), so the
// list doesn't publish the very names it protects, plus plain regexes for
// generic shapes (emails, home paths, private addresses). Hashes hide terms
// from casual reading, not from someone who guesses them. .denylist-allow
// lists intentional mentions, one per line:
//   <path-glob> <term>       e.g.  README.md some-handle
// The push gate scans commit messages as the path COMMIT_MSG.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha = (t) => createHash('sha256').update(t).digest('hex');

function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp(`^${re}$`);
}

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

/** Load the rules from a repo root. Throws if the config is missing or invalid (callers fail closed). */
export function loadRules(root) {
  const config = JSON.parse(readFileSync(join(root, '.denylist.json'), 'utf8'));
  if (!Array.isArray(config.hashed) || !Array.isArray(config.patterns)) throw new Error('.denylist.json needs "hashed" and "patterns" arrays');
  const allowFile = join(root, '.denylist-allow');
  const allow = existsSync(allowFile)
    ? readFileSync(allowFile, 'utf8')
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
        .map((l) => {
          const [glob, term] = l.split(/\s+/);
          if (!term) throw new Error(`.denylist-allow: "${l}" needs <path-glob> <term>`);
          return { re: globToRe(glob), term: term.toLowerCase() };
        })
    : [];
  return { hashed: new Set(config.hashed), patterns: config.patterns.map((p) => ({ src: p, re: new RegExp(p, 'g') })), allow };
}

/** Every denied term or pattern in `text`, as "path:line: why" strings. */
export function scanText(rules, path, text) {
  const allowed = (term) => rules.allow.some((a) => a.term === term && a.re.test(path));
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const t of tokens(line)) if (rules.hashed.has(sha(t)) && !allowed(t)) hits.push(`${path}:${i + 1}: denied term "${t}"`);
    for (const { src, re } of rules.patterns) {
      for (const m of line.matchAll(re)) if (!allowed(m[0].toLowerCase())) hits.push(`${path}:${i + 1}: "${m[0]}" matches /${src}/`);
    }
  });
  return hits;
}

export const SKIP = new Set(['.denylist.json', '.denylist-allow', 'package-lock.json', 'desktop/Cargo.lock', 'LICENSE']);
