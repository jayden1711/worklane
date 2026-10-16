// P0 item 4: blocks for the budget or auth keep the claim (block(..., release_=false)). They must retry on their own
// once the window resets, and relabelling the issue `ready` must requeue them (isTerminal is false for them). A rate
// limit is no longer a block at all: the instance pauses until its reset and the task is requeued (src/usage-limit.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRunner, type RunRequest } from '../../src/runner.js';
import { coordinator, easyIssue, fixture, readAll, realFix, skip } from './harness.js';

/** The first worker run ends with `reason`; later ones do the work. */
function endsFirstWith(reason: string, transient = false) {
  let workers = 0;
  const runner = new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      workers++;
      if (workers === 1) return { reason: reason as never, detail: `${reason}: resets in 5 hours`, ...(transient ? { transient: true } : {}) };
      return { structured: realFix(req) };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: readAll(req) } };
  });
  return { runner, workers: () => workers };
}

for (const reason of ['budget_exhausted', 'auth_mismatch']) {
  test(`${reason} block: relabelling the issue ready requeues it`, { skip }, async () => {
    const f = fixture();
    const n = f.backlog.open(easyIssue('Add a.js', 'a.js'));
    const s = endsFirstWith(reason);
    const c = coordinator(f, s.runner);
    await c.tick();
    await c.idle();
    assert.ok(f.log.read(0, ['issue.blocked']).some((e) => (e.payload as { issue: number }).issue === n), 'blocked');
    // The owner fixed the login / waited for the window, and labels it ready again, as the block comment says.
    await f.backlog.removeLabel(n, 'blocked');
    await f.backlog.addLabels(n, ['ready']);
    await c.tick();
    await c.idle();
    assert.equal(s.workers(), 2, `relabelled ready, the task runs again (worker runs: ${s.workers()}; last event for #${n}: ${f.log.read().filter((e) => (e.payload as { issue?: number }).issue === n).at(-1)?.type})`);
  });
}

test("rate_limited: never blocked; once the pause's reset has passed (a day later), the task runs again on its own", { skip }, async (t) => {
  const f = fixture();
  const n = f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const s = endsFirstWith('rate_limited');
  const c = coordinator(f, s.runner);
  await c.tick();
  await c.idle();
  assert.ok(!f.log.read(0, ['issue.blocked']).some((e) => (e.payload as { issue: number }).issue === n), 'not blocked');
  assert.ok((await f.backlog.get(n)).labels.includes('ready'), 'requeued');
  // A day later (only Date moves; timers are real).
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 3600_000 });
  try {
    for (let i = 0; i < 3; i++) {
      await c.tick();
      await c.idle();
    }
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(s.workers(), 2, `a day after the usage-limit pause, the task has run again by itself (worker runs: ${s.workers()})`);
});
