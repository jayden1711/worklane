// An emergency stop raised while the combined check runs (it can take minutes) holds the merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeAll, stopAll } from '../src/slots.js';
import { approve, green, openPr, skip } from './repro-state-graph/harness.js';

test('emergency stop raised during the combined gate: no merge', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  const c = t.c as unknown as { combinedGate: () => Promise<'merge'> };
  c.combinedGate = async () => {
    stopAll('operator', 'stop everything', t.f.slotsDir);
    return 'merge';
  };
  let merges = 0;
  const mergePr = t.f.backlog.mergePr.bind(t.f.backlog);
  t.f.backlog.mergePr = (...a: Parameters<typeof mergePr>) => {
    merges++;
    return mergePr(...a);
  };
  try {
    await green(t);
    assert.equal(merges, 0, 'mergePr is not called once the stop is in force');
    assert.equal(t.f.log.read(0, ['merge.done']).length, 0, 'no merge.done');
    assert.ok(!t.pr().merged, 'the PR is not merged');
  } finally {
    resumeAll(t.f.slotsDir);
  }
});
