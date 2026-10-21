// Every NOT_YET_FILES entry in test/merge-policy.test.ts is a self-modification lock in src/review.ts (#885).
// NOT_YET_FILES lets a lock glob match no file yet. An entry with no lock beside it exempts nothing the dead-glob test
// checks, so it would sit there unseen: a glob dropped from src/review.ts while its entry stays, or an entry added with
// no lock. This test reads the table the way the weakening hold does (src/merge-policy-weakening.ts tableLines) and
// fails on any entry that isn't, glob for glob, one of SELF_MODIFICATION_PARTS's globs.
// The protection itself is by design: NOT_YET_FILES is a never-grow table (CHECK_TABLES), so any entry added holds the
// PR for the owner. This test is the backstop that keeps each entry paired with its lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { tableLines, withoutComments } from '../src/merge-policy-weakening.js';
import { LOCKED_CATEGORIES, SELF_MODIFICATION, SELF_MODIFICATION_PARTS } from '../src/review.js';
import { repoRoot } from './helpers.js';

const TABLE = 'NOT_YET_FILES';

/** The table's entries, as the strings the test compares. Throws when the table is missing, empty or can't be read plainly. */
function notYetEntries(source: string): string[] {
  const lines = tableLines(source, TABLE);
  if (!lines) throw new Error(`${TABLE} is not declared`);
  // The value starts after the declaration's `=`; the rest of the lines are the list.
  const [first, ...rest] = lines.map(withoutComments);
  const eq = first!.search(/=(?!>)/);
  if (eq < 1) throw new Error(`${TABLE}: no = on its line`);
  const text = [first!.slice(eq + 1), ...rest].join('\n');
  const out: string[] = [];
  for (const m of text.matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g)) {
    const raw = m[1] ?? m[2] ?? m[3]!;
    // The one interpolation the table may use is the config folder's name; any other fails closed.
    const value = raw.replaceAll('${BRAND.configDir}', BRAND.configDir);
    if (value.includes('${')) throw new Error(`${TABLE}: unknown interpolation in ${raw}`);
    out.push(value);
  }
  // Anything left between the strings but commas, brackets and blanks is a name or a call this reading can't follow.
  const left = text.replace(/'[^'\\]*'|"[^"\\]*"|`[^`\\]*`/g, '').replace(/[\s,[\]();]/g, '');
  if (left) throw new Error(`${TABLE}: holds more than plain strings: ${left}`);
  if (!out.length) throw new Error(`${TABLE} has no entries`);
  return out;
}

/** The entries with no self-modification lock glob equal to them. */
function unpaired(entries: readonly string[], locks: readonly string[]): string[] {
  return entries.filter((e) => !locks.includes(e));
}

const lockGlobs = SELF_MODIFICATION_PARTS.flatMap((p) => p.globs);

test("every NOT_YET_FILES entry in test/merge-policy.test.ts is a self-modification lock glob in src/review.ts", () => {
  assert.deepEqual(LOCKED_CATEGORIES[SELF_MODIFICATION], lockGlobs);
  const entries = notYetEntries(readFileSync(join(repoRoot, 'test', 'merge-policy.test.ts'), 'utf8'));
  assert.deepEqual(unpaired(entries, lockGlobs), [], 'each of these needs its lock in SELF_MODIFICATION_PARTS, or must leave NOT_YET_FILES');
  assert.equal(new Set(entries).size, entries.length, 'no entry twice');
});

test('the pairing check catches an entry without its lock, and fails closed on a table it cannot read', () => {
  const one = `const NOT_YET_FILES = [\`\${BRAND.configDir}/experiments.yaml\`, 'deploy/**', 'compose.*'];\n`;
  assert.deepEqual(notYetEntries(one), [`${BRAND.configDir}/experiments.yaml`, 'deploy/**', 'compose.*']);
  assert.deepEqual(unpaired(notYetEntries(one), [`${BRAND.configDir}/experiments.yaml`, 'deploy/**']), ['compose.*']);
  // The same table over several lines, with a comment.
  const many = "const NOT_YET_FILES = [\n  'deploy/**', // the manifests\n  \"compose.*\",\n];\n";
  assert.deepEqual(notYetEntries(many), ['deploy/**', 'compose.*']);
  // A lock dropped from src/review.ts while its entry stays.
  assert.deepEqual(unpaired(['deploy', 'compose.*'], ['compose.*']), ['deploy']);
  for (const bad of [
    'const OTHER = [];\n',
    'const NOT_YET_FILES = [];\n',
    "const NOT_YET_FILES = [`${process.env.X}`];\n",
    "const NOT_YET_FILES = ['deploy', ...MORE];\n",
    "const NOT_YET_FILES = ['deploy'];\nconst NOT_YET_FILES = ['compose.*'];\n",
  ]) assert.throws(() => notYetEntries(bad), Error, bad);
});
