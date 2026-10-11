import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendWorkers, tuningProposals, type TuneProfile } from '../src/tuning.js';

const profile = (runs: TuneProfile['runs'], extra: Partial<TuneProfile> = {}): TuneProfile => ({ at: '2026-10-11T08:00:00Z', command: 'make test-fast', cores: 16, memAvailableMb: 32000, runs, ...extra });

test('the recommended worker count is the fewest within 10% of the fastest', () => {
  const r = recommendWorkers(
    [
      { workers: 1, seconds: 400, ok: true, peakWorkerMb: 500 },
      { workers: 2, seconds: 210, ok: true, peakWorkerMb: 500 },
      { workers: 4, seconds: 130, ok: true, peakWorkerMb: 500 },
      { workers: 8, seconds: 112, ok: true, peakWorkerMb: 500 },
      { workers: 16, seconds: 110, ok: true, peakWorkerMb: 500 },
    ],
    32000,
  );
  assert.equal(r?.workers, 8, '8 is within 10% of 16 workers: the rest only take cores from other tasks');
  assert.match(r!.why, /8 worker\(s\) ran in 112 s, within 10% of the fastest \(110 s\)/);
});

test('memory caps the worker count, and failed runs never count', () => {
  const r = recommendWorkers(
    [
      { workers: 4, seconds: 100, ok: true, peakWorkerMb: 3000 },
      { workers: 8, seconds: 60, ok: true, peakWorkerMb: 3000 },
      { workers: 16, seconds: 20, ok: false, peakWorkerMb: 3000 },
    ],
    16000,
  );
  assert.equal(r?.workers, 4, '16 GB × 0.8 / 3 GB per worker = 4');
  assert.match(r!.why, /memory holds only 4/);
  assert.equal(recommendWorkers([{ workers: 2, seconds: 5, ok: false, peakWorkerMb: null }], 1000), null);
});

test('a worker-count proposal carries the numbers, and only when it would change something', () => {
  const p = profile([
    { workers: 1, seconds: 300, ok: true, peakWorkerMb: 400 },
    { workers: 4, seconds: 90, ok: true, peakWorkerMb: 400 },
    { workers: 8, seconds: 88, ok: true, peakWorkerMb: 400 },
  ]);
  const [w] = tuningProposals({ checks: [], currentWorkers: 6, profile: p });
  assert.equal(w?.key, 'tune:workers:4');
  assert.equal(w?.question, 'Set the test worker cap to 4 (now 6)?');
  assert.deepEqual(w?.options, ['open a PR with this', 'leave it']);
  assert.ok(w?.receipts.includes('4 worker(s): 90 s, 400 MB per worker'));
  assert.deepEqual(tuningProposals({ checks: [], currentWorkers: 4, profile: p }), [], 'already 4: nothing to propose');
  assert.deepEqual(tuningProposals({ checks: [], currentWorkers: 6 }), [], 'no profile: no worker proposal');
});

test('a slow full suite gets a split proposal, naming its slowest tests when a profile listed them', () => {
  const runs = (min: number, n: number) => Array.from({ length: n }, () => ({ check: 'make test-full', durationMs: min * 60_000 }));
  const [s] = tuningProposals({ checks: runs(19, 6), fullCheck: 'make test-full', currentWorkers: null, profile: profile([], { slowTests: [{ id: 'tests/test_sim.py::test_long', seconds: 240 }, { id: 'tests/test_a.py::test_quick', seconds: 3 }] }) });
  assert.equal(s?.key, 'tune:split:make test-full');
  assert.match(s!.question, /takes 19 min \(median of the last 6\)/);
  assert.deepEqual(s?.options, ['open a PR moving these to nightly', 'leave it']);
  assert.ok(s?.receipts.includes('tests/test_sim.py::test_long: 240 s'));
  assert.ok(!s?.receipts.some((r) => r.includes('test_quick')), 'a fast test is never moved');
  // Without per-test times, it asks for a profile first.
  const [n] = tuningProposals({ checks: runs(19, 6), fullCheck: 'make test-full', currentWorkers: null });
  assert.deepEqual(n?.options, ['profile the suite (tune) to name them', 'leave it']);
  // Under the threshold, or too few runs to judge: nothing.
  assert.deepEqual(tuningProposals({ checks: runs(12, 6), fullCheck: 'make test-full', currentWorkers: null }), []);
  assert.deepEqual(tuningProposals({ checks: runs(30, 4), fullCheck: 'make test-full', currentWorkers: null }), []);
});
