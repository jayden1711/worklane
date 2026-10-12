import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PollCounter, pollsFor, slotDeferrals } from '../src/coordinator/wait-caps.js';

test('pollsFor: a timeout as polls at the poll interval, never fewer than the minimum (an interval of 0 gives the minimum)', () => {
  assert.equal(pollsFor(2 * 3600_000, 60_000, 20), 120);
  assert.equal(pollsFor(60_000, 60_000, 20), 20);
  assert.equal(pollsFor(2 * 3600_000, 0, 20), 20);
});

test('slotDeferrals: the trailing run of deferrals for a held full-run slot; an emergency stop or a moved tip neither counts nor resets', () => {
  const slot = { outcome: 'deferred', detail: 'tier full needs the machine-wide full-run slot (held by x); deferred' };
  const stop = { outcome: 'deferred', detail: 'emergency stop in force; lands once it is lifted' };
  const tip = { outcome: 'deferred', detail: 'push rejected (tip moved): x' };
  assert.equal(slotDeferrals([slot, stop, slot, tip, slot]), 3);
  assert.equal(slotDeferrals([slot, slot, { outcome: 'red', detail: '' }, slot]), 1, 'a final result resets the run');
  assert.equal(slotDeferrals([stop, stop, tip]), 0);
});

test('PollCounter: counts polls per key until cleared', () => {
  const c = new PollCounter();
  assert.deepEqual([c.bump('a'), c.bump('a'), c.bump('b')], [1, 2, 1]);
  c.clear('a');
  assert.equal(c.bump('a'), 1);
});
