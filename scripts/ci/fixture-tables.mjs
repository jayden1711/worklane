// The systemd-acceptance fixtures, read from their round tables (test/fixtures/systemd-acceptance/r1169*.json and
// bases.json; README.md there says the format). One loader for the test that runs them and for the check that
// compares them with the folders they came from (the owner, 2026-11-12).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every case, by name: { exit, reason, listed?, files } where files maps each folder-relative path (`x.test.ts.txt`,
 * `src/flags.ts.root`) to its exact text. Throws on a name in two tables, a missing base or a malformed entry.
 */
export function loadCases(dir) {
  const bases = JSON.parse(readFileSync(join(dir, 'bases.json'), 'utf8')).bases;
  const cases = new Map();
  for (const t of readdirSync(dir).filter((f) => /^r1169[a-z]+\.json$/.test(f)).sort()) {
    for (const [name, c] of Object.entries(JSON.parse(readFileSync(join(dir, t), 'utf8')).cases)) {
      if (cases.has(name)) throw new Error(`${t}: case ${name} is in another table too`);
      if (typeof c.exit !== 'number' || typeof c.reason !== 'string' || !c.files || (c.listed !== undefined && typeof c.listed !== 'string')) throw new Error(`${t}: case ${name} is malformed`);
      const files = new Map();
      for (const [p, v] of Object.entries(c.files)) {
        const lines = typeof v === 'string' ? bases[v.replace(/^@/, '')] : v;
        if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) throw new Error(`${t}: ${name}/${p} is neither lines nor a known base`);
        files.set(p, lines.join('\n'));
      }
      cases.set(name, { exit: c.exit, reason: c.reason, listed: c.listed, files });
    }
  }
  return cases;
}
