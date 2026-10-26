// #1077 round 2: a PR whose merge into the tip conflicts in a test file is held by the tip-conflict reason. While GitHub
// is still computing whether it can merge (the first poll after every merge), that hold waits: GitHub's `dirty` on a
// later poll sends it to the conflict fix, as on main. Only a GitHub that says clean, or never says, hands it to the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { approve, changeOnMain, green, openPr, skip, type OpenPr } from './repro-state-graph/harness.js';
import { MERGEABLE_CAP } from '../src/coordinator/wait-caps.js';

const pollNow = (t: OpenPr) => (t.c as unknown as { prPolled: Map<number, number> }).prPolled.clear();
const decided = (t: OpenPr) => t.f.log.read(0, ['merge.decided']).map((e) => e.payload as { number: number; auto: boolean; reasons: string[] }).filter((p) => p.number === t.opened.number);

/** The PR adds test/repro-qty.test.js; main adds a different file there: an add/add conflict in a test file. */
async function conflictingInATest(state: 'unknown' | 'clean') {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  changeOnMain(t, join('test', 'repro-qty.test.js'), () => "import { test } from 'node:test';\ntest('another', () => {});\n");
  t.f.backlog.setPr(t.opened.number, { mergeableState: state });
  await green(t);
  return t;
}

test('mergeability unknown: a conflict with the tip in a test file is not handed to the owner, and goes to the conflict fix once GitHub says dirty', { skip }, async () => {
  const t = await conflictingInATest('unknown');
  assert.deepEqual(decided(t), [], 'no merge decision while GitHub is still computing');
  assert.ok(!t.pr().labels.includes('needs-owner'), `no owner label: ${t.pr().labels.join(', ')}`);
  assert.equal(t.pr().comments.length, 0, 'no owner comment');
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'dirty' });
  pollNow(t);
  await t.c.tick();
  assert.ok(t.f.log.read(0, ['conflict_fix.started']).length >= 1, 'the conflict fix starts');
  assert.deepEqual(decided(t), [], 'the conflict fix, not a merge decision');
});

test('mergeability unknown for good: the tip-conflict hold reaches the owner at the cap', { skip }, async () => {
  const t = await conflictingInATest('unknown');
  for (let i = 0; i < MERGEABLE_CAP + 1 && !decided(t).length; i++) {
    pollNow(t);
    await t.c.tick();
  }
  const d = decided(t).at(-1);
  assert.ok(d && !d.auto && d.reasons.some((r) => /conflicts with the default branch's current tip/.test(r)), `held for the owner: ${JSON.stringify(d)}`);
});

test('GitHub says clean while the merge into the tip conflicts in a test file: held for the owner on that poll', { skip }, async () => {
  const t = await conflictingInATest('clean');
  const d = decided(t).at(-1);
  assert.ok(d && !d.auto && d.reasons.some((r) => /conflicts with the default branch's current tip.*test\/repro-qty\.test\.js/.test(r)), `held: ${JSON.stringify(d)}`);
});
