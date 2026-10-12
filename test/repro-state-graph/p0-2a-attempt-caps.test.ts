// P0 item 2a: the attempt cap (maxAttempts, default 3) survives a coordinator restart and an emergency stop's requeue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resumeAll, stopAll } from '../../src/slots.js';
import { FakeRunner, type RunRequest } from '../../src/runner.js';
import { BUG, commitAll, coordinator, fixture, readAll, skip, writeRepro } from './harness.js';

/** A worker that never fixes the bug: each attempt commits an unrelated note, so the frozen repro stays red. */
function uselessWorker(req: RunRequest, k: number) {
  writeFileSync(join(req.cwd, `NOTE-${k}.md`), `attempt ${k}\n`);
  commitAll(req.cwd, `note ${k}`);
  return { summary: 'tried' };
}

const workerAttempts = (f: ReturnType<typeof fixture>) => f.log.read(0, ['run.started']).map((e) => e.payload as { role: string; attempt: number }).filter((p) => p.role === 'worker').map((p) => p.attempt);

test('attempt cap: a coordinator restart mid-task does not reset the attempt count to 1', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  let k = 0;
  const script = (crashAt: number | null) =>
    new FakeRunner((req) => {
      if (req.role === 'evaluator-repro') return { structured: writeRepro(req) };
      if (req.role === 'worker') {
        k++;
        if (crashAt !== null && k === crashAt) throw new Error('simulated crash'); // the process dies mid-attempt
        return { structured: uselessWorker(req, k) };
      }
      return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
    });
  const c1 = coordinator(f, script(2));
  await c1.tick();
  await c1.idle();
  assert.deepEqual(workerAttempts(f), [1, 2], 'two attempts used before the crash');
  const c2 = coordinator(f, script(null));
  await c2.recover();
  await c2.tick();
  await c2.idle();
  const all = workerAttempts(f);
  assert.ok(all.length <= 3, `at most maxAttempts (3) worker attempts across the restart; got attempts ${JSON.stringify(all)}`);
});

test('attempt cap: an emergency stop and resume requeue does not reset the attempt count to 1', { skip }, async () => {
  const f = fixture();
  f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  let k = 0;
  const runner = new FakeRunner(async (req) => {
    if (req.role === 'evaluator-repro') return { structured: writeRepro(req) };
    if (req.role === 'worker') {
      k++;
      if (k === 2) {
        // The second attempt runs until the emergency stop aborts it.
        await new Promise<void>((res) => req.signal?.addEventListener('abort', () => res()));
        return { reason: 'canceled_by_reconciliation' };
      }
      return { structured: uselessWorker(req, k) };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
  });
  const c = coordinator(f, runner);
  await c.tick();
  for (let i = 0; i < 200 && workerAttempts(f).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(workerAttempts(f), [1, 2], 'attempt 2 is running');
  stopAll('operator', 'stop', f.slotsDir);
  c.checkEmergency();
  await c.idle();
  assert.ok(resumeAll(f.slotsDir));
  await c.tick();
  await c.idle();
  const all = workerAttempts(f);
  assert.ok(all.length <= 3, `at most maxAttempts (3) worker attempts across the stop and resume; got attempts ${JSON.stringify(all)}`);
});
