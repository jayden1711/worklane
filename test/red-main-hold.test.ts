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

test("#907 (R1186a): a throw after fix-forward's episode opened leaves the episode holding, and no stop that would hold its own fix PR", async () => {
  const w = world();
  const c = w.make(false);
  // The episode opens (fix_forward.started), then a later step throws: a transient read in the first bisect step.
  c.fixForward.start = async (o) => {
    const r = o as { sha: string; number: number | null; failed: string[] };
    w.f.log.append('fix_forward.started', { sha: r.sha, number: r.number, failed: r.failed, last_green: 'b'.repeat(40), candidates: [{ sha: r.sha, number: 7, title: 'a change' }] }, 'coordinator');
    throw new Error('transient GitHub read in the first bisect step');
  };
  await c.watchMerges();
  assert.equal(w.red().length, 1, 'judged red');
  assert.match(c.fixForward.holds(999) ?? '', /is red \(since cccccccc\): only its fix PR merges/, "fix-forward's open episode holds every other merge");
  assert.equal(c.autoMergeStopped(), null, "no stop: it would hold fix-forward's own fix PR too, and only an admin clears it");
  assert.equal(w.f.log.read(0, ['merge.stopped']).length, 0);
  const errors = w.f.log.read(0, ['coordinator.error']).map((e) => (e.payload as { message: string }).message);
  assert.ok(errors.some((m) => /transient GitHub read in the first bisect step/.test(m)), 'the throw is still recorded');
});

test("#907 (the owner's addition): a later merge whose handling throws on every pass doesn't hold back an earlier merge's timed-out stop", async () => {
  // An earlier merge, #5, whose required check never reports; the red #7 (SHA) after it, whose handling always throws.
  const EARLY = 'a'.repeat(40);
  const f2 = fixture();
  mkdirSync(f2.stateDir, { recursive: true });
  f2.cfg.project.land_mode = 'pr';
  f2.cfg.project.ci = 'github';
  f2.cfg.project.required_checks = ['ci'];
  f2.cfg.project.flaky.rerun = false;
  f2.log.append('merge.done', { issue: 2, number: 5, head: 'e'.repeat(40), sha: EARLY, url: 'https://github.com/example-org/example-shop/pull/5', title: 'an earlier change' }, 'alice');
  f2.log.append('merge.done', { issue: 1, number: 7, head: 'd'.repeat(40), sha: SHA, url: 'https://github.com/example-org/example-shop/pull/7', title: 'a change' }, 'alice');
  f2.backlog.setChecks(SHA, [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'failure', id: 11 }]);
  type Gate = { judge(o: { sha: string }): Promise<unknown> };
  const c = coordinator(f2, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0 }) as unknown as Watching & { flakyGate: Gate };
  const gate = c.flakyGate;
  const judge = gate.judge.bind(gate);
  gate.judge = async (o) => {
    if (o.sha === SHA) throw new Error('the flaky gate fails on #7 every pass');
    return judge(o);
  };
  // Enough passes for #5's checks to time out in polls (MAIN_CHECKS_MIN_POLLS, at a poll interval of 0).
  let threw = 0;
  for (let i = 0; i < 25; i++) await c.watchMerges().catch(() => threw++);
  assert.equal(threw, 25, "#7's handling throws on every pass");
  assert.match(c.autoMergeStopped() ?? '', /isn't known green after auto-merging: ci never reported on `aaaaaaaa` \(#5\)/, "#5's stop is in force though #7 throws after it");
  const results = f2.log.read(0, ['merge.main_result']).map((e) => e.payload as EventPayload<'merge.main_result'>);
  assert.deepEqual(results.map((r) => [r.number, r.outcome]), [[5, 'timed_out']], '#5 judged timed out once; #7 left unjudged, so a later pass takes it on');
});

test('#907 (R1186c): with another gated stop in force, fix-forward unable to take a red on still writes a stop of its own, so resuming the old one releases nothing', async () => {
  const w = world();
  const c = w.make(true) as Watching & { stopFor(reason: string, number: number | null, sha: string | null, revert: null, by?: string): void };
  // An earlier merge's stop (main_unknown for #5) in force when #7 goes red.
  c.stopFor("main isn't known green after auto-merging: ci never reported on `aaaaaaaa` (#5)", 5, 'a'.repeat(40), null, 'main_unknown');
  const old = w.f.log.read(0, ['merge.stopped']).at(-1)!.id;
  await c.watchMerges();
  assert.equal(w.red().length, 1, 'judged red');
  const stops = w.f.log.read(0, ['merge.stopped']);
  assert.equal(stops.length, 2, 'a second stop, for #7');
  assert.notEqual(stops.at(-1)!.id, old);
  assert.match((stops.at(-1)!.payload as { reason: string }).reason, /went red after auto-merging #7/);
  assert.match(c.autoMergeStopped() ?? '', /#7/, "the stop in force is #7's: a resume of #5's (its own id) can't release it");
});

