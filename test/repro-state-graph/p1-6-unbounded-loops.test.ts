// P1 item 6: four retry loops with no cap or timeout. Each test drives the loop many times and asserts the correct
// behaviour: at some point it gives up (or decides) and records it, instead of retrying silently for ever.
import '../isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fullRunLock } from '../../src/slots.js';
import { FakeRunner } from '../../src/runner.js';
import { approve, commitAll, conflictOnMain, coordinator, easyIssue, fixture, green, openPr, readAll, realMerges, skip, waitForCount, type OpenPr } from './harness.js';

/** Treat every PR as due on the next pass (time passing between polls). */
const pollNow = (t: OpenPr) => (t.c as unknown as { prPolled: Map<number, number> }).prPolled.clear();

test('deferred landing: a land deferred on every pass (the full-run slot is held) gives up once the wait passes the timeout, not after a number of passes', { skip }, async (tt) => {
  const f = fixture();
  f.cfg.tests.gates.land = ['full'];
  f.cfg.tests.runner.full = 'node --test --test-reporter=spec';
  const n = f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const runner = new FakeRunner((req) => {
    if (req.role !== 'worker') return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
    writeFileSync(join(req.cwd, 'src', 'a.js'), "export const x = 'a';\n");
    commitAll(req.cwd, 'add a.js');
    return { structured: { summary: 's' } };
  });
  const c = coordinator(f, runner);
  (c as unknown as { landing: boolean }).landing = true;
  await c.tick();
  await c.idle();
  (c as unknown as { landing: boolean }).landing = false;
  // Another session holds the machine-wide full-run slot for good (a wedged run, a leaked lock).
  const held = await fullRunLock('a wedged session', 1000, f.slotsDir);
  assert.ok('lock' in held);
  const outcomes = () => f.log.read(0, ['land.result']).map((e) => (e.payload as { outcome: string }).outcome);
  const gaveUp = () => f.log.read(0, ['issue.blocked']).some((e) => (e.payload as { issue: number }).issue === n) || outcomes().some((o) => o !== 'deferred');
  try {
    // Passes within the timeout (a long full run in progress): deferred, however many.
    for (let i = 0; i < 4; i++) await c.tick(); // each waits 5 s for the slot
    assert.ok(!gaveUp(), `within the timeout the land only waits; got ${JSON.stringify(outcomes())}`);
    // Past the default timeout (3 h) since the first deferral. Only Date is mocked (timers are real), and it keeps
    // moving, so the slot wait's own deadline still comes.
    tt.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3 * 3600_000 + 60_000 });
    const clock = setInterval(() => tt.mock.timers.tick(250), 50);
    try {
      await c.tick();
    } finally {
      clearInterval(clock);
      tt.mock.timers.reset();
    }
  } finally {
    held.lock.release();
  }
  assert.ok(gaveUp(), `a land deferred past the timeout is given up and recorded; land.result outcomes ${JSON.stringify(outcomes())}, no issue.blocked`);
});

test('mergeable recheck: a PR GitHub reports as still computing on every poll is decided at some point', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  t.f.backlog.setPr(t.opened.number, { mergeableState: 'unknown' });
  t.f.backlog.setChecks(t.opened.head, [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'success', id: 1 }]);
  let polls = 0;
  const pullRequest = t.f.backlog.pullRequest.bind(t.f.backlog);
  t.f.backlog.pullRequest = async (n: number) => {
    polls++;
    return pullRequest(n);
  };
  for (let i = 0; i < 20; i++) {
    pollNow(t);
    await t.c.tick();
  }
  const decided = t.f.log.read(0, ['merge.decided']).length;
  assert.ok(decided > 0, `after ${polls} polls of a mergeable state that stays "unknown", the PR waits for the owner (merge.decided); got none, and no other event naming it: ${[...new Set(t.f.log.read().filter((e) => (e.payload as { number?: number }).number === t.opened.number).map((e) => e.type))].join(', ')}`);
});

test('combined check pending: a light check that found a conflict GitHub never reports is decided at some point', { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  conflictOnMain(t, false); // a real conflict on main, but GitHub still says "clean"
  await green(t);
  assert.equal(await waitForCount(t.f.log, 'light_check.finished', 1), 1);
  const outcome = (t.f.log.read(0, ['light_check.finished']).at(-1)!.payload as { outcome: string }).outcome;
  assert.equal(outcome, 'conflict');
  for (let i = 0; i < 20; i++) {
    pollNow(t);
    await t.c.tick();
  }
  const decided = t.f.log.read(0, ['merge.decided']).length;
  const asked = t.pr().comments.length;
  assert.ok(decided > 0 || asked > 0, `after 20 polls whose combined check says "conflict" while GitHub says clean, the PR is decided or the owner told; got merge.decided=${decided}, PR comments=${asked}, light checks=${t.f.log.read(0, ['light_check.started']).length}`);
});

test("main checks after an auto-merge: checks that never report on the merge commit are given up on at some point", { skip }, async () => {
  const t = await openPr({ 'evaluator-verdict': approve() }, { autoMerge: () => true });
  realMerges(t);
  await green(t);
  assert.equal(t.f.log.read(0, ['merge.done']).length, 1, 'auto-merged');
  for (let i = 0; i < 20; i++) await t.c.tick(); // prPollMs 0: each tick polls the merge commit's checks
  const judged = t.f.log.read(0, ['merge.main_result']).length;
  assert.ok(judged > 0, `after 20 polls with no required check on the merge commit, the wait is ended and recorded (merge.main_result or a timeout); got none (types: ${[...new Set(t.f.log.read().map((e) => e.type))].filter((x) => x.startsWith('merge')).join(', ')})`);
});
