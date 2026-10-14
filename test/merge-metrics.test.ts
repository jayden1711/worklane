import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_MINUTES, mergeMetrics, type MetricEvent } from '../src/merge-metrics.js';

const at = (min: number) => new Date(Date.UTC(2026, 9, 5, 12, 0) + min * 60_000).toISOString();
const ev = (min: number, type: string, payload: object): MetricEvent => ({ ts: at(min), type, payload });
const since = new Date(at(0));

test('conflict fixes: count, minutes from conflict to merged, and how many needed the owner', () => {
  const m = mergeMetrics(
    [
      ev(1, 'conflict_fix.detected', { number: 10 }),
      ev(2, 'conflict_fix.started', { number: 10 }),
      ev(3, 'conflict_fix.detected', { number: 10 }), // seen again: still one conflict
      ev(9, 'conflict_fix.finished', { number: 10, outcome: 'pushed', waits_owner: false }),
      ev(21, 'pr.closed', { number: 10, merged: true }),
      ev(30, 'conflict_fix.detected', { number: 11 }),
      ev(35, 'conflict_fix.finished', { number: 11, outcome: 'pushed', waits_owner: true }),
      ev(50, 'conflict_fix.detected', { number: 12 }),
      ev(51, 'conflict_fix.finished', { number: 12, outcome: 'gave_up', waits_owner: false }),
      ev(60, 'pr.closed', { number: 13, merged: true }),
      ev(61, 'pr.closed', { number: 14, merged: false }),
    ],
    { since },
  );
  assert.equal(m.mergedPrs, 2);
  assert.equal(m.conflicts.count, 3);
  assert.deepEqual(m.conflicts.minutesToMerged, [20]);
  assert.equal(m.conflicts.medianMinutes, 20);
  assert.equal(m.conflicts.needOwner, 2, 'one waited for the owner, one gave up');
  assert.equal(m.conflicts.perMergedPr, 10);
});

test('light checks and hotspot holds: counts and minutes added, holds by file', () => {
  const m = mergeMetrics(
    [
      ev(1, 'light_check.finished', { number: 1, outcome: 'merge', wait_ms: 90_000 }),
      ev(2, 'light_check.finished', { number: 2, outcome: 'hold', wait_ms: 30_000 }),
      ev(3, 'hotspot.held', { issue: 5, by: 4, files: ['package-lock.json'] }),
      ev(9, 'hotspot.released', { issue: 5, waited_ms: 360_000, files: ['package-lock.json'] }),
      ev(10, 'pr.closed', { number: 1, merged: true }),
      ev(11, 'pr.closed', { number: 3, merged: true }),
    ],
    { since },
  );
  assert.deepEqual(m.lightChecks, { count: 2, minutesAdded: 2, perMergedPr: 1, outcomes: { merge: 1, hold: 1 } });
  assert.deepEqual(m.holds, { count: 1, minutesWaited: 6, perMergedPr: 3, byFile: [{ file: 'package-lock.json', minutes: 6, count: 1 }] });
  assert.deepEqual(m.flags, [], `${FLAG_MINUTES} min per merged PR is not more than a few`);
});

test('more than a few minutes per merged PR is flagged with a suggested tuning for that measure', () => {
  const m = mergeMetrics(
    [
      ev(0, 'conflict_fix.detected', { number: 1 }),
      ev(5, 'conflict_fix.finished', { number: 1, outcome: 'pushed', waits_owner: false, files: ['src/registry.ts'] }),
      ev(40, 'pr.closed', { number: 1, merged: true }),
      ev(41, 'light_check.finished', { number: 1, outcome: 'merge', wait_ms: 600_000 }),
      ev(42, 'hotspot.released', { issue: 2, waited_ms: 900_000, files: ['test/helpers.ts'] }),
    ],
    { since },
  );
  assert.equal(m.flags.length, 3);
  assert.match(m.flags[0]!, /^Conflict fixes add 40 min per merged PR: consider listing src\/registry\.ts as hotspots/);
  assert.match(m.flags[1]!, /^Combined-state checks add 10 min per merged PR: consider a faster tests\.yaml runner\.changed/);
  assert.match(m.flags[2]!, /^Hotspot holds add 15 min per merged PR, most on test\/helpers\.ts/);
});

test('only the window counts, and no merged PRs means nothing per PR (no division by zero)', () => {
  const m = mergeMetrics([ev(-10, 'pr.closed', { number: 1, merged: true }), ev(-5, 'light_check.finished', { number: 1, outcome: 'merge', wait_ms: 60_000 })], { since });
  assert.equal(m.mergedPrs, 0);
  assert.equal(m.lightChecks.count, 0);
  assert.equal(m.conflicts.perMergedPr, 0);
  assert.equal(m.conflicts.medianMinutes, null);
});
