// Rate-limit and budget blocks retry on their own once their window passes, up to a cap; auth blocks never do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import type { EventPayload } from '../src/events/types.js';
import { coordinator, easyIssue, fixture, readAll, skip } from './repro-state-graph/harness.js';

/** Every worker run ends with `reason`. */
function alwaysEndsWith(reason: string) {
  let workers = 0;
  const runner = new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      workers++;
      return { reason: reason as never, detail: `${reason}: resets later` };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
  });
  return { runner, workers: () => workers };
}

const DAY = 24 * 3600_000;

test('an auth block never retries on its own', { skip }, async (t) => {
  const f = fixture();
  const n = f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const s = alwaysEndsWith('auth_mismatch');
  const c = coordinator(f, s.runner);
  await c.tick();
  await c.idle();
  const b = f.log.read(0, ['issue.blocked']).at(-1)!.payload as EventPayload<'issue.blocked'>;
  assert.equal(b.retry_after, undefined);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * DAY });
  try {
    await c.tick();
    await c.idle();
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(s.workers(), 1);
  assert.ok((await f.backlog.get(n)).labels.includes('blocked'));
  assert.equal(f.log.read(0, ['issue.retry']).length, 0);
});

test('a budget block retries at the next UTC midnight', { skip }, async () => {
  const f = fixture();
  f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const c = coordinator(f, alwaysEndsWith('budget_exhausted').runner);
  const before = Date.now();
  await c.tick();
  await c.idle();
  const b = f.log.read(0, ['issue.blocked']).at(-1)!.payload as EventPayload<'issue.blocked'>;
  assert.equal(b.retry_kind, 'budget');
  const d = new Date(before);
  assert.equal(b.retry_after, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString());
});

test('a rate-limit block retries at most 3 times, then stays blocked with one give-up', { skip }, async (t) => {
  const f = fixture();
  const n = f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const s = alwaysEndsWith('rate_limited');
  const c = coordinator(f, s.runner);
  await c.tick();
  await c.idle();
  const start = Date.now();
  for (let k = 1; k <= 6; k++) {
    t.mock.timers.enable({ apis: ['Date'], now: start + k * DAY });
    try {
      for (let i = 0; i < 2; i++) {
        await c.tick();
        await c.idle();
      }
    } finally {
      t.mock.timers.reset();
    }
  }
  assert.equal(s.workers(), 4, `the first run and 3 retries (worker runs: ${s.workers()})`);
  const retries = f.log.read(0, ['issue.retry']).map((e) => e.payload as EventPayload<'issue.retry'>);
  assert.deepEqual(retries.map((r) => [r.attempt, r.gave_up]), [[1, false], [2, false], [3, false], [3, true]]);
  assert.ok((await f.backlog.get(n)).labels.includes('blocked'));
  assert.ok((await f.backlog.comments(n)).some((m) => m.body.includes('still blocked after 3 automatic retries')));
});
