// The coordinator's errors on the dashboard (src/projection.ts CoordinatorErrors): only the ones still current, each
// once with how many times and since when. A later tick that ends with no error from the same place, or a restart,
// makes an earlier one history; a viewer's count (src/viewer-events.ts errorCount) counts the current ones only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/projection.js';
import { DIRECT_LAND_REFUSED } from '../src/direct-land.js';
import { stateForViewer } from '../src/viewer-events.js';
import type { StoredEvent } from '../src/events/types.js';

let id = 0;
const at = (min: number) => new Date(Date.parse('2026-10-14T01:00:00.000Z') + min * 60_000).toISOString();
const ev = (min: number, type: string, payload: Record<string, unknown>) => ({ id: ++id, ts: at(min), type, actor: 'c@local', source: 'coordinator', payload }) as unknown as StoredEvent;
const started = (min: number) => ev(min, 'coordinator.started', { instance: 'c@local', pid: 1, version: 'test' });
const tick = (min: number) => ev(min, 'coordinator.tick', { instance: 'c@local', dispatched: 0, reconciled: 0 });
const error = (min: number, where: string, message: string, kind = 'error') => ev(min, 'coordinator.error', { instance: 'c@local', where, kind, message });

test('an error that a later tick no longer raises is history, not current; one that keeps happening is shown once with its count, first and last time', () => {
  const events = [
    started(0),
    // dispatch fails on three ticks running; reconcile fails once, then works.
    error(1, 'dispatch', 'fetch failed'),
    error(1, 'reconcile', 'GitHub 502'),
    tick(1),
    error(2, 'dispatch', 'fetch failed'),
    tick(2),
    error(3, 'dispatch', 'fetch failed'),
    tick(3),
  ];
  const p = project(events);
  assert.deepEqual(
    p.errors.map((e) => [e.where, e.message, e.count, e.first, e.last]),
    [['dispatch', 'fetch failed', 3, at(1), at(3)]],
    'dispatch: current, once, three times; reconcile cleared at the next tick without it',
  );
  assert.deepEqual(p.earlierErrors.map((e) => [e.where, e.count]), [['reconcile', 1]], 'the cleared one is history');

  // A tick that ends with no dispatch error clears it too: nothing is current.
  const clean = project([...events, tick(4)]);
  assert.deepEqual(clean.errors, [], 'a clean tick clears it');
  assert.deepEqual(clean.earlierErrors.map((e) => [e.where, e.count]), [['dispatch', 3], ['reconcile', 1]]);
  assert.equal(stateForViewer(clean as unknown as Record<string, unknown>).errorCount, 0, "a viewer's count: current ones only");
  assert.equal(stateForViewer(p as unknown as Record<string, unknown>).errorCount, 3, "a viewer's count: each time the current one happened");
  assert.ok(!('earlierErrors' in stateForViewer(p as unknown as Record<string, unknown>)), 'a viewer never gets the history');

  // The same error after it was cleared: current again, since then (the earlier run of it stays in the history).
  const later = project([...events, tick(4), error(5, 'dispatch', 'fetch failed')]);
  assert.deepEqual(later.errors.map((e) => [e.where, e.count, e.first]), [['dispatch', 1, at(5)]]);
  assert.deepEqual(later.earlierErrors.map((e) => [e.where, e.count]), [['dispatch', 3], ['reconcile', 1]]);
});

test('a restart after a tick makes the errors before it history', () => {
  const p = project([started(0), error(1, 'dispatch', 'fetch failed'), error(1, 'land', 'git exited 1'), tick(1), started(10)]);
  assert.deepEqual(p.errors, [], 'nothing current after the restart');
  assert.equal(p.earlierErrors.length, 2);
  assert.equal(stateForViewer(p as unknown as Record<string, unknown>).errorCount, 0);
});

test('a standing condition recorded once (a refused direct land, a config error) stays current across ticks, until a restart or a land that pushed', () => {
  // A config error at start-up, before coordinator.started: it stays through that start and its ticks.
  const config = [error(0, 'deploy gate', "deploy_gate.branch can't be the default branch", 'config'), started(0), tick(1), tick(2)];
  assert.deepEqual(project(config).errors.map((e) => e.where), ['deploy gate']);
  // The next restart clears it (that boot records it again before its start if it still holds).
  assert.deepEqual(project([...config, started(10), tick(11)]).errors, []);
  // A refused direct land: until a land pushes, or a restart.
  const refused = [started(0), error(1, 'direct land', 'nothing pushed: main is not protected', DIRECT_LAND_REFUSED), tick(1), tick(2), tick(3)];
  assert.deepEqual(project(refused).errors.map((e) => e.where), ['direct land']);
  assert.deepEqual(project([...refused, ev(4, 'land.batch', { id: 'b', issues: [1], tip: 'a'.repeat(40), outcome: 'landed', detail: '' })]).errors, []);
  assert.deepEqual(project([...refused, started(5)]).errors, []);
});
