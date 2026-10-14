import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PollCounter, pollsFor, slotDeferringSince } from '../src/coordinator/wait-caps.js';

test('pollsFor: a timeout as polls at the poll interval, never fewer than the minimum (an interval of 0 gives the minimum)', () => {
  assert.equal(pollsFor(2 * 3600_000, 60_000, 20), 120);
  assert.equal(pollsFor(60_000, 60_000, 20), 20);
  assert.equal(pollsFor(2 * 3600_000, 0, 20), 20);
});

test('slotDeferringSince: when the trailing run of deferrals for a held full-run slot began; an emergency stop or a moved tip neither starts nor breaks it', () => {
  const slot = (at: number) => ({ outcome: 'deferred', detail: 'tier full needs the machine-wide full-run slot (held by x); deferred', at });
  const stop = (at: number) => ({ outcome: 'deferred', detail: 'emergency stop in force; lands once it is lifted', at });
  const tip = (at: number) => ({ outcome: 'deferred', detail: 'push rejected (tip moved): x', at });
  assert.equal(slotDeferringSince([stop(1), slot(2), tip(3), slot(4)]), 2);
  assert.equal(slotDeferringSince([slot(1), slot(2), { outcome: 'red', detail: '', at: 3 }, slot(4)]), 4, 'a final result ends the run');
  assert.equal(slotDeferringSince([stop(1), tip(2)]), null);
});

test('PollCounter: counts polls per key until cleared', () => {
  const c = new PollCounter();
  assert.deepEqual([c.bump('a'), c.bump('a'), c.bump('b')], [1, 2, 1]);
  c.clear('a');
  assert.equal(c.bump('a'), 1);
});
