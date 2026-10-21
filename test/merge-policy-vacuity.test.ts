// The merge gate's vacuity check (#784, src/merge-policy-vacuity.ts): a PR that changes app code auto-merges only when
// its own tests assert something and, run under coverage, execute a function in an app file it changes. Every other
// outcome is a named `design:` reason, and nothing it adds can make a held PR mergeable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDecision, type MergeInput } from '../src/merge-policy.js';
import { VACUITY_TRIES, VACUITY_UNMEASURED, vacuityCheck, type VacuityConfig, type VacuityMeasured } from '../src/merge-policy-vacuity.js';
import { selfModificationPart } from '../src/review.js';

const cfg: VacuityConfig = { test_globs: ['test/**/*.test.js'], assertion_pattern: '\\b(assert|expect)\\b', app_paths: ['src/**'], dynamic: true };
const ASSERTS = "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n";
const NO_ASSERT = "import { test } from 'node:test';\ntest('x', () => {});\n";
const NONE = "and no test: it adds or changes none, and its task's done_when names none";

/**
 * The check over a head holding `files` (path -> text; absent: deleted at the head) as the PR's changes, and `kept`
 * as files it leaves alone, with these coverage runs.
 */
function check(o: { files: Record<string, string | null>; kept?: Record<string, string>; contractTests?: string[]; cfg?: VacuityConfig | undefined; runOne?: string | undefined; started?: number; last?: VacuityMeasured | null }) {
  return vacuityCheck({
    cfg: 'cfg' in o ? o.cfg : cfg,
    runOne: 'runOne' in o ? o.runOne : 'node --test {file}',
    changed: Object.keys(o.files),
    ...(o.contractTests ? { contractTests: o.contractTests } : {}),
    atHead: (p) => o.files[p] ?? o.kept?.[p] ?? null,
    runs: { started: o.started ?? 0, last: o.last ?? null },
  });
}

test('vacuity: its tests include those its task\'s done_when names (what verification ran), changed or not, once each, if the head has them', () => {
  const v = check({ files: { 'src/a.js': 'x' }, kept: { 'test/price.test.js': ASSERTS }, contractTests: ['test/price.test.js'] });
  assert.deepEqual(v, { reasons: [], run: { tests: ['test/price.test.js'], appPaths: ['src/**'] } }, 'an unchanged test the contract names');
  assert.deepEqual(check({ files: { 'src/a.js': 'x', 'test/a.test.js': ASSERTS }, kept: { 'test/price.test.js': ASSERTS }, contractTests: ['test/price.test.js', 'test/a.test.js'] }).run?.tests, ['test/a.test.js', 'test/price.test.js'], 'changed ones first, no repeats');
  assert.deepEqual(check({ files: { 'src/a.js': 'x' }, contractTests: ['test/gone.test.js'] }).reasons, [`design: vacuity: it changes app code (src/a.js) ${NONE}`], 'one the head lacks is no test');
  assert.deepEqual(check({ files: { 'src/a.js': 'x' }, kept: { 'test/price.test.js': NO_ASSERT }, contractTests: ['test/price.test.js'] }).reasons, ['design: vacuity: its tests (test/price.test.js) have no assertion matching /\\b(assert|expect)\\b/']);
  assert.match(check({ files: { 'src/a.js': 'x' }, kept: { 'test/$(x).js': ASSERTS }, contractTests: ['test/$(x).js'] }).reasons.join(), /a test path has characters other than/, 'a named path is never put in a command unquoted either');
});

test('vacuity: app code changed with a test that asserts and nothing measured yet: the gate asks for the coverage run first', () => {
  const v = check({ files: { 'src/a.js': 'x', 'test/a.test.js': ASSERTS } });
  assert.deepEqual(v, { reasons: [], run: { tests: ['test/a.test.js'], appPaths: ['src/**'] } }, 'no reason of its own: pending (mergeDecision holds it, below)');
});

test('vacuity: a measured run that executed a changed app file clears it; one that executed none holds it, naming both sides', () => {
  const files = { 'src/a.js': 'x', 'src/b.js': 'y', 'test/a.test.js': ASSERTS };
  assert.deepEqual(check({ files, started: 1, last: { tests: ['test/a.test.js'], touched: ['src/b.js'], error: null } }), { reasons: [] }, 'one changed app file run is enough');
  assert.deepEqual(check({ files, started: 1, last: { tests: ['test/a.test.js'], touched: ['src/other.js'], error: null } }).reasons, ['design: vacuity: its tests (test/a.test.js) ran none of the app code it changes (src/a.js, src/b.js)'], 'an app file it does not change does not count');
  assert.deepEqual(check({ files, started: 1, last: { tests: ['test/a.test.js'], touched: [], error: null } }).reasons, ['design: vacuity: its tests (test/a.test.js) ran none of the app code it changes (src/a.js, src/b.js)']);
});

test('vacuity: fail closed: a run that failed, one that never finished, and one of other tests than the head has', () => {
  const files = { 'src/a.js': 'x', 'test/a.test.js': ASSERTS };
  assert.deepEqual(check({ files, started: 1, last: { tests: ['test/a.test.js'], touched: ['src/a.js'], error: 'test/a.test.js exited 1' } }).reasons, ['design: vacuity: its coverage run failed: test/a.test.js exited 1'], 'an error holds even beside touched files');
  assert.deepEqual(check({ files, started: VACUITY_TRIES }).reasons, [`design: vacuity: its coverage run started ${VACUITY_TRIES} times at this head and never finished`]);
  assert.deepEqual(check({ files, started: VACUITY_TRIES - 1 }).run?.tests, ['test/a.test.js'], 'below the cap: run again');
  const stale = check({ files: { ...files, 'test/b.test.js': ASSERTS }, started: 1, last: { tests: ['test/a.test.js'], touched: ['src/a.js'], error: null } });
  assert.deepEqual([stale.reasons, stale.run?.tests], [[], ['test/a.test.js', 'test/b.test.js']], 'a run of a different set of tests is not this head\'s');
});

test('vacuity: no test, no assertion, a static-only config, no runner.one: each holds by name, with no run', () => {
  assert.deepEqual(check({ files: { 'src/a.js': 'x' } }), { reasons: [`design: vacuity: it changes app code (src/a.js) ${NONE}`] });
  assert.deepEqual(check({ files: { 'src/a.js': 'x', 'test/a.test.js': NO_ASSERT } }), { reasons: ['design: vacuity: its tests (test/a.test.js) have no assertion matching /\\b(assert|expect)\\b/'] });
  assert.deepEqual(check({ files: { 'src/a.js': 'x', 'test/a.test.js': '// assert.ok(x)\n/* expect(y) */\n' } }).reasons, ['design: vacuity: its tests (test/a.test.js) have no assertion matching /\\b(assert|expect)\\b/'], 'an assertion in a comment is not one');
  assert.deepEqual(check({ files: { 'src/a.js': 'x', 'test/a.test.js': ASSERTS }, cfg: { ...cfg, dynamic: false } }), { reasons: ['design: vacuity: tests.yaml vacuity.dynamic is off, so nothing measured whether its tests run the app code it changes (src/a.js)'] });
  assert.deepEqual(check({ files: { 'src/a.js': 'x', 'test/a.test.js': ASSERTS }, runOne: undefined }), { reasons: ["design: vacuity: tests.yaml runner.one is not set, so its tests can't be run one by one under coverage"] });
});

test('vacuity: a test path the gate would have to quote is never put in a command: it holds', () => {
  const any = { ...cfg, test_globs: ['**/*.test.js'] };
  for (const odd of ['test/$(touch x).test.js', 'test/a b.test.js', "test/a'b.test.js", '-x.test.js', '--require=x.test.js', 'test/../src/a.test.js', '../a.test.js', 'test/a;b.test.js', 'test/a\nb.test.js']) {
    const v = check({ files: { 'src/a.js': 'x', [odd]: ASSERTS }, cfg: any });
    assert.equal(v.run, undefined, `${odd}: no run`);
    assert.match(v.reasons.join('\n'), /design: vacuity: a test path has characters other than/, odd);
  }
  for (const plain of ['test/a.test.js', 'test/sub-dir/x_y.2.test.js', 'test/-x.test.js', 'test/..a.test.js']) {
    assert.deepEqual(check({ files: { 'src/a.js': 'x', [plain]: ASSERTS }, cfg: any }).run?.tests, [plain], `${plain}: one plain word, not an option, no parent segment`);
  }
});

test('vacuity: what counts as changed app code: types-only and config, data, docs and assets do not; deleted files and tests do not; an unknown kind does', () => {
  for (const p of ['src/types.d.ts', 'src/x.d.mts', 'src/config.json', 'src/a.yaml', 'src/a.yml', 'src/a.toml', 'src/README.md', 'src/style.css', 'src/logo.svg', 'src/a.png']) {
    assert.deepEqual(check({ files: { [p]: 'x' } }), { reasons: [] }, `${p}: nothing for a test to run`);
  }
  assert.deepEqual(check({ files: { 'src/gone.js': null } }), { reasons: [] }, 'a deleted app file: nothing left to run');
  assert.deepEqual(check({ files: { 'docs/a.md': 'x', 'lib/a.js': 'x' } }), { reasons: [] }, 'outside app_paths');
  assert.deepEqual(check({ files: { 'src/a.test.js': ASSERTS } }).reasons, [`design: vacuity: it changes app code (src/a.test.js) ${NONE}`], 'no test glob matches it: app code');
  assert.deepEqual(check({ files: { 'src/a.test.js': ASSERTS }, cfg: { ...cfg, test_globs: ['src/**/*.test.js'] } }), { reasons: [] }, 'a test glob matches it: a test, not app code');
  for (const p of ['src/a.ts', 'src/a.mjs', 'src/a.py', 'src/a.weird', 'src/Makefile']) {
    assert.deepEqual(check({ files: { [p]: 'x' } }).reasons, [`design: vacuity: it changes app code (${p}) ${NONE}`], `${p}: code, or a kind it doesn't know (fail closed)`);
  }
});

test('vacuity: no vacuity section in tests.yaml: decided as before (the gate needs app_paths and test_globs to know what to ask)', () => {
  assert.deepEqual(check({ files: { 'src/a.js': 'x' }, cfg: undefined }), { reasons: [] });
});

test('vacuity: fail closed: a head it cannot read holds the PR, never reads as one with nothing to check', () => {
  const v = vacuityCheck({ cfg, runOne: 'x {file}', changed: ['src/a.js', 'test/a.test.js'], atHead: () => { throw new Error('git show failed\nmore'); }, runs: { started: 0, last: null } });
  assert.deepEqual(v, { reasons: ['design: vacuity: could not be checked: git show failed'] });
});

/** Every switch of mergeDecision on its most permissive setting: it merges. */
function clean(over: Partial<MergeInput> = {}): MergeInput {
  return {
    branch: 'b', openedByHarness: true, policyOn: true, repoOn: true, stopped: null,
    level: { level: 'L1', reasons: [], categories: {} }, waitCategories: [], limits: { max_lines: 400, max_files: 10 }, lines: 1, files: 1,
    verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: false }, newTopLevel: [], ciFixRuns: 0, foreignPush: false, pushLimitHit: false,
    ...over,
  };
}

test('merge decision: a vacuity reason holds a PR that would otherwise merge, under its own reason', () => {
  const r = 'design: vacuity: its tests (test/a.test.js) ran none of the app code it changes (src/a.js)';
  assert.deepEqual(mergeDecision(clean({ vacuity: [r] })), { auto: false, reasons: [r], why: [] });
  assert.deepEqual(mergeDecision(clean({ vacuity: [] })), { auto: true, reasons: [], why: [] });
});

test('merge decision: a coverage run still to come holds a PR nothing else holds; beside another reason it adds none, and the PR stays held', () => {
  assert.deepEqual(mergeDecision(clean({ vacuity: [], vacuityPending: true })), { auto: false, reasons: [VACUITY_UNMEASURED], why: [] });
  assert.deepEqual(mergeDecision(clean({ vacuity: [], vacuityPending: true, policyOn: false })), { auto: false, reasons: ['auto-merge is off for this instance (policy.yaml auto_merge)'], why: [] });
  assert.deepEqual(mergeDecision(clean({ vacuity: [], vacuityPending: false })), { auto: true, reasons: [], why: [] });
});

test('merge decision: a tightening only: no input held before is mergeable with any vacuity result, and its reasons are kept in order', () => {
  const held: Partial<MergeInput>[] = [
    { policyOn: false }, { repoOn: false }, { stopped: 'main went red' }, { openedByHarness: false }, { lines: 401 }, { files: 11 }, { verdict: null },
    { ciFixRuns: 1 }, { foreignPush: true }, { pushLimitHit: true }, { claimedProtected: true }, { weakening: ['design: may weaken a check: x'] },
    { instructionEvals: ['eval: role worker changed but was not evaluated'] }, { outsidePlan: ['not in the approved plan: design: new top-level module (x/)'] }, { newTopLevel: ['plugins/'] },
  ];
  const results: Partial<MergeInput>[] = [{ vacuity: [] }, { vacuity: [], vacuityPending: true }, { vacuity: ['design: vacuity: its coverage run failed: x'] }];
  for (const over of held) {
    const before = mergeDecision(clean(over));
    assert.equal(before.auto, false, JSON.stringify(over));
    for (const result of results) {
      const after = mergeDecision(clean({ ...over, ...result }));
      assert.equal(after.auto, false, `${JSON.stringify(over)} with ${JSON.stringify(result)}`);
      assert.deepEqual(after.reasons.filter((r) => !(result.vacuity ?? []).includes(r)), before.reasons, 'every reason it had is still there, and no other');
    }
  }
});

test('the gate\'s vacuity code is locked as the merge policy: a change to it waits for the owner', () => {
  for (const p of ['src/merge-policy-vacuity.ts', 'src/vacuity.ts']) assert.equal(selfModificationPart(p), 'the merge policy', p);
});
