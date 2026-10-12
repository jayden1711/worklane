// P0 item 1: an emergency stop must halt landing and auto-merge, not only agent runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeAll, stopAll } from '../../src/slots.js';
import { agents, approve, BUG, coordinator, fixture, git, green, openPr, skip } from './harness.js';

test('emergency stop: a queued land does not land while the stop is in force', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = coordinator(f, agents());
  // Build only: the change is queued for landing, not landed.
  (c as unknown as { landing: boolean }).landing = true;
  await c.tick();
  await c.idle();
  (c as unknown as { landing: boolean }).landing = false;
  assert.equal(f.log.read(0, ['land.queued']).length, 1, 'queued for landing');
  const mainBefore = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
  stopAll('operator', 'stop everything', f.slotsDir);
  try {
    await c.tick();
    const landed = f.log.read(0, ['land.result']).map((e) => (e.payload as { outcome: string }).outcome);
    assert.deepEqual(landed.filter((o) => o === 'landed'), [], `nothing lands under an emergency stop (land.result outcomes: ${landed.join(', ')})`);
    assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], mainBefore, 'main untouched under an emergency stop');
  } finally {
    resumeAll(f.slotsDir);
  }
});

test('emergency stop: a ready, policy-approved PR does not auto-merge while the stop is in force', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  stopAll('operator', 'stop everything', t.f.slotsDir);
  try {
    await green(t);
    assert.equal(t.f.log.read(0, ['merge.done']).length, 0, 'no merge.done under an emergency stop');
    assert.ok(!t.pr().merged, 'the PR is not merged under an emergency stop');
  } finally {
    resumeAll(t.f.slotsDir);
  }
});

test('emergency stop: once lifted, the queued land lands and the ready PR auto-merges', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const c = coordinator(f, agents());
  (c as unknown as { landing: boolean }).landing = true;
  await c.tick();
  await c.idle();
  (c as unknown as { landing: boolean }).landing = false;
  stopAll('operator', 'stop everything', f.slotsDir);
  await c.tick();
  resumeAll(f.slotsDir);
  await c.tick();
  assert.deepEqual(f.log.read(0, ['land.result']).map((e) => (e.payload as { outcome: string }).outcome).filter((o) => o === 'landed'), ['landed'], 'lands after the stop is lifted');

  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  stopAll('operator', 'stop everything', t.f.slotsDir);
  await green(t);
  assert.equal(t.f.log.read(0, ['merge.done']).length, 0);
  resumeAll(t.f.slotsDir);
  await t.c.tick();
  assert.equal(t.f.log.read(0, ['merge.done']).length, 1, 'auto-merges after the stop is lifted');
});
