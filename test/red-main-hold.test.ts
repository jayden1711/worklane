// #907 (as #731 round 2 for timed_out): a red main verdict counts as judged only after what holds the next merge is in
// place: fix-forward's episode, or the auto-merge stop. A pass cut off between the verdict and the hold (a restart, a
// throw) must never leave a judged red with nothing holding merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture } from './repro-state-graph/harness.js';

const SHA = 'c'.repeat(40);

type Watching = { watchMerges(): Promise<void>; autoMergeStopped(): string | null; fixForward: { start(o: unknown): Promise<void>; holds(issue: number): string | null } };

/** A merge of PR #7 whose required check `ci` is red on its merge commit; `cut`: fix-forward's start throws (the cut). */
function world() {
  const f = fixture();
  mkdirSync(f.stateDir, { recursive: true });
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.ci = 'github';
  f.cfg.project.required_checks = ['ci'];
  f.cfg.project.flaky.rerun = false;
  f.log.append('merge.done', { issue: 1, number: 7, head: 'd'.repeat(40), sha: SHA, url: 'https://github.com/example-org/example-shop/pull/7', title: 'a change' }, 'alice');
  f.backlog.setChecks(SHA, [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'failure', id: 11 }]);
  const make = (cut: boolean) => {
    const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0 }) as unknown as Watching;
    if (cut) c.fixForward.start = async () => {
      throw new Error('cut off between the verdict and the hold');
    };
    return c;
  };
  const red = () => f.log.read(0, ['merge.main_result']).map((e) => e.payload as EventPayload<'merge.main_result'>).filter((r) => r.outcome === 'red');
  /** What holds the next merge (of any issue but the fix's): the stop, or fix-forward's open episode. */
  const holding = (c: Watching) => c.autoMergeStopped() ?? c.fixForward.holds(999);
  return { f, make, red, holding };
}

test('#907: a pass cut off between a red verdict and its hold never leaves a judged red with nothing holding merges, across a restart', async () => {
  const w = world();
  const first = w.make(true);
  // The cut: fix-forward can't take the red on in this pass.
  await first.watchMerges().catch(() => {});
  // Whatever this pass recorded, a red verdict is never there without a hold.
  if (w.red().length) assert.ok(w.holding(first), 'a red verdict is recorded only with something holding merges');
  // A restart: a new coordinator over the same log and state, its fix-forward whole again.
  const again = w.make(false);
  await again.watchMerges().catch(() => {});
  assert.equal(w.red().length, 1, 'judged red once');
  assert.ok(w.holding(again), 'after the restart, something holds the next merge (the stop, or fix-forward)');
});

test('#907: fix-forward unable to take a red on stops auto-merge, and only then is the red recorded', async () => {
  const w = world();
  const c = w.make(true);
  await c.watchMerges();
  assert.equal(w.red().length, 1, 'judged red');
  assert.match(c.autoMergeStopped() ?? '', /went red after auto-merging #7 .*fix-forward couldn't take it on \(cut off between the verdict and the hold\)/);
  const stopped = w.f.log.read(0, ['merge.stopped', 'merge.main_result']).map((e) => e.type);
  assert.deepEqual(stopped, ['merge.stopped', 'merge.main_result'], 'the stop first, then the verdict');
});
