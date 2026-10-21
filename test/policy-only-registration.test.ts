// #726 / #770: the machine helper's POLICY_ONLY (the one value of land_mode, main_watch and auto_merge a coordinator may
// set) is a registered check table (src/merge-policy-weakening.ts CHECK_TABLES, never-shrink), so a PR that takes a
// key out of it waits for the owner. Measured through the merge decision's own path (merge-flow calls weakeningOf with
// changeFiles): a real git change of the real helper file, found only through BRAND, so a rename keeps it.
//
// POLICY_ONLY is a one-line table: any change to it changes the line that declares it, which the gate holds as
// unreadable (it can't tell the table after the change is the same table), naming the table. So adding a key waits
// too (fail closed); a change elsewhere in the file names no table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { changeFiles } from '../src/coordinator/change-files.js';
import { WEAKENING_REASON, weakeningOf } from '../src/merge-policy-weakening.js';
import { exampleProject, repoRoot } from './helpers.js';

const HELPER = `scripts/machine/${BRAND.cli}-machine.cjs`;
const REAL = readFileSync(join(repoRoot, HELPER), 'utf8');
const LINE = /^const POLICY_ONLY = \{.*\};$/m;

/** The merge decision's weakening reasons for a change of the real helper file from `before` to `after`. */
function reasonsFor(before: string, after: string): string[] {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(dir, 'scripts', 'machine'), { recursive: true });
  writeFileSync(join(dir, HELPER), before);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, HELPER), after);
  g('commit', '-q', '-am', 'head');
  const head = g('rev-parse', 'HEAD');
  return weakeningOf(dir, base, head, changeFiles(dir, base, head), undefined);
}
/** The reasons that name the helper's POLICY_ONLY. */
const naming = (r: string[]) => r.filter((x) => x.startsWith(WEAKENING_REASON) && x.includes(`${HELPER}: "POLICY_ONLY: `));

test("taking one key out of the machine helper's POLICY_ONLY waits for the owner: a weakening reason names the table (#726, #770)", () => {
  const line = REAL.match(LINE)?.[0];
  assert.ok(line, `${HELPER} declares POLICY_ONLY on one line`);
  assert.ok(line.includes("main_watch: 'auto', "), 'main_watch is one of its keys');
  const r = reasonsFor(REAL, REAL.replace(line, line.replace("main_watch: 'auto', ", '')));
  assert.deepEqual(naming(r), [`${WEAKENING_REASON}can't read a change to check it, so it may weaken a check (${HELPER}: "POLICY_ONLY: the line that declares it is removed or changed")`], r.join(' | '));
});

test("adding a key to POLICY_ONLY waits too (its one line changes, fail closed); a change elsewhere in the helper names no table (#726, #770)", () => {
  const line = REAL.match(LINE)![0];
  const added = reasonsFor(REAL, REAL.replace(line, line.replace("auto_merge: 'off' }", "auto_merge: 'off', extra: 'x' }")));
  assert.equal(naming(added).length, 1, added.join(' | '));
  const elsewhere = reasonsFor(REAL, `${REAL}// a comment added at the end\n`);
  assert.deepEqual(elsewhere.filter((x) => x.includes('POLICY_ONLY')), [], elsewhere.join(' | '));
});
