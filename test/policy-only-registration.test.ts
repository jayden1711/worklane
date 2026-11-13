// #726 / #770: the machine helper's POLICY_ONLY (the one value of land_mode, main_watch and auto_merge a coordinator may
// set) is a registered check table, so a PR that takes a key out of it waits for the owner. Measured through the merge
// decision's own path (merge-flow calls weakeningOf with changeFiles): a real git change of the real files, found only
// through BRAND, so a rename keeps it.
//
// Since #941 the table is data: scripts/machine/<cli>-machine.tables.json, compared parsed, never-shrink. The helper is
// installed alone, so it carries a generated frozen copy (scripts/lib/table-copies.mjs), which test/table-copies.test.ts
// holds to the data. So a key taken out of the data, or its value changed, waits, naming the table; a key added only
// narrows what a coordinator may set, and passes (before #941 the one-line reader held any change to the line, fail
// closed); a change elsewhere in the helper names no table.
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
const DATA = `scripts/machine/${BRAND.cli}-machine.tables.json`;
const REAL = { [HELPER]: readFileSync(join(repoRoot, HELPER), 'utf8'), [DATA]: readFileSync(join(repoRoot, DATA), 'utf8') };

/** The merge decision's weakening reasons for a change of the real files from `before` to `after` (path to text). */
function reasonsFor(before: Record<string, string>, after: Record<string, string>): string[] {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(dir, 'scripts', 'machine'), { recursive: true });
  const put = (files: Record<string, string>) => {
    for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, p), text);
    g('add', '-A');
    g('commit', '-q', '-m', 'step');
    return g('rev-parse', 'HEAD');
  };
  const base = put(before);
  const head = put(after);
  // The default branch's tip is the change's base here (claimed at the tip).
  return weakeningOf(dir, base, head, changeFiles(dir, base, head), undefined, base);
}
/** The reasons that name the data's POLICY_ONLY. */
const naming = (r: string[]) => r.filter((x) => x.startsWith(WEAKENING_REASON) && x.includes(`${DATA}: `) && x.includes('POLICY_ONLY: '));
/** The data with POLICY_ONLY's value changed by `f`. */
const withPolicy = (f: (v: Record<string, string>) => void) => {
  const top = JSON.parse(REAL[DATA]!) as { POLICY_ONLY: { value: Record<string, string> } };
  f(top.POLICY_ONLY.value);
  return { ...REAL, [DATA]: `${JSON.stringify(top, null, 2)}\n` };
};

test("taking one key out of the machine helper's POLICY_ONLY, or changing its value, waits for the owner: a weakening reason names the table (#726, #770, #941)", () => {
  assert.equal(JSON.parse(REAL[DATA]!).POLICY_ONLY.value.main_watch, 'auto', 'main_watch is one of its keys');
  const r = reasonsFor(REAL, withPolicy((v) => delete v.main_watch));
  assert.equal(naming(r).length, 1, r.join(' | '));
  assert.ok(naming(r)[0]!.startsWith(`${WEAKENING_REASON}removes or changes an entry in a check's rules or a guard's list (`), r.join(' | '));
  assert.ok(naming(r)[0]!.includes('main_watch') && naming(r)[0]!.includes('auto'), r.join(' | '));
  const changed = reasonsFor(REAL, withPolicy((v) => (v.auto_merge = 'on')));
  assert.equal(naming(changed).length, 1, changed.join(' | '));
  assert.ok(naming(changed)[0]!.includes('auto_merge') && naming(changed)[0]!.includes('off'), changed.join(' | '));
});

test('adding a key to POLICY_ONLY passes (it only narrows what a coordinator may set); a change elsewhere in the helper names no table (#726, #770, #941)', () => {
  const added = reasonsFor(REAL, withPolicy((v) => (v.extra = 'x')));
  assert.deepEqual(naming(added), [], added.join(' | '));
  const elsewhere = reasonsFor(REAL, { ...REAL, [HELPER]: `${REAL[HELPER]}// a comment added at the end\n` });
  assert.deepEqual(elsewhere.filter((x) => x.includes('POLICY_ONLY')), [], elsewhere.join(' | '));
});
