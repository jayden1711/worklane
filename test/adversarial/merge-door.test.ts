// The merge door (#715, #957 round 3 Q20): an auto-merge stop raised after the merge decision said yes, before the merge
// call, holds the merge. The coordinator decides a real PR on a real remote (test/repro-state-graph/harness.ts); the
// stop is raised the way the engine raises one (stopFor, as after a red main), while the merge train re-reads the PR
// right before it calls GitHub's merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approve, green, openPr, skip, type OpenPr } from '../repro-state-graph/harness.js';

/** A ready PR whose combined check passes; `during` runs while the merge train re-reads the PR before its merge call. */
async function atTheDoor(during?: (t: OpenPr) => void) {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  const c = t.c as unknown as { combinedGate: () => Promise<'merge'> };
  let decided = false;
  c.combinedGate = async () => {
    decided = true;
    return 'merge';
  };
  const pullRequest = t.f.backlog.pullRequest.bind(t.f.backlog);
  t.f.backlog.pullRequest = async (...a: Parameters<typeof pullRequest>) => {
    if (decided) {
      decided = false;
      during?.(t);
    }
    return pullRequest(...a);
  };
  let merges = 0;
  const mergePr = t.f.backlog.mergePr.bind(t.f.backlog);
  t.f.backlog.mergePr = (...a: Parameters<typeof mergePr>) => {
    merges++;
    return mergePr(...a);
  };
  await green(t);
  const auto = t.f.log.read(0, ['merge.decided']).map((e) => (e.payload as { auto: boolean }).auto);
  // A throw anywhere in the pass also leaves the PR unmerged: none may happen, so "not merged" means the stop held it.
  assert.deepEqual(t.f.log.read(0, ['coordinator.error']).map((e) => e.payload), [], 'the merge pass ran to its end');
  return { t, merges, auto };
}

const REASON = 'main went red after an auto-merge';

test('merge door: with nothing raised, the ready PR the decision passes is merged (the control)', { skip }, async () => {
  const { t, merges, auto } = await atTheDoor();
  assert.deepEqual(auto, [true], 'the decision lets it merge');
  assert.equal(merges, 1);
  assert.ok(t.pr().merged, 'the PR is merged');
});

test('merge door: an auto-merge stop raised after the decision, right before the merge call, holds the merge', { skip }, async () => {
  const { t, merges, auto } = await atTheDoor((x) => {
    const stop = (x.c as unknown as { stopFor: (reason: string, number: null, sha: string, revert: null) => void }).stopFor.bind(x.c);
    stop(REASON, null, x.pr().headSha, null);
  });
  // The stop was really raised, once, and is in force: the merge was held by it, not by a pass that ended early.
  assert.deepEqual(t.f.log.read(0, ['merge.stopped']).map((e) => (e.payload as { reason: string }).reason), [REASON], 'one stop, with its reason');
  assert.equal(t.c.autoMergeStopped(), REASON, 'auto-merge is stopped');
  assert.deepEqual(auto, [true], 'the decision had let it merge before the stop');
  assert.equal(merges, 0, 'mergePr is not called once auto-merge is stopped');
  assert.equal(t.f.log.read(0, ['merge.done']).length, 0, 'no merge.done');
  assert.ok(!t.pr().merged, 'the PR is not merged');
});
