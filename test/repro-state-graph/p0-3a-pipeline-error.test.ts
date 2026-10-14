// P0 item 3a: an uncaught error in the issue pipeline leaves a comment on the issue, an event, and the claim released.
import '../isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimRef } from '../../src/claims.js';
import { FakeRunner } from '../../src/runner.js';
import { BUG, coordinator, fixture, git, skip } from './harness.js';

test('pipeline error: a task that throws is reported on the issue, recorded, and its claim released (not silently stuck)', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const crashing = new FakeRunner(() => {
    throw new Error('simulated pipeline failure');
  });
  const c = coordinator(f, crashing);
  await c.tick();
  await c.idle();
  const errors = f.log.read(0, ['coordinator.error']).map((e) => e.payload as { where: string; message: string });
  assert.ok(errors.some((e) => e.where === `task #${n}`), 'an event records the error');
  const comments = (await f.backlog.comments(n)).map((x) => x.body);
  const told = comments.some((b) => /simulated pipeline failure|error|failed/i.test(b) && !/^\[[^\]]+\] Claimed/.test(b));
  const released = f.log.read(0, ['issue.released']).some((e) => (e.payload as { issue: number }).issue === n);
  const claimHeld = git(f.repo, 'ls-remote', 'origin', claimRef(n)) !== '';
  const labels = (await f.backlog.get(n)).labels;
  assert.ok(told && released && !claimHeld, `the owner is told on the issue and the claim released; got comment=${told}, issue.released=${released}, claim ref still held=${claimHeld}, labels=${JSON.stringify(labels)}, comments=${JSON.stringify(comments.map((b) => b.slice(0, 60)))}`);
});
