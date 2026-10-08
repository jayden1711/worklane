import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, totalCents } from '../src/price.js';

test('totals integer cents', () => {
  assert.equal(totalCents([{ cents: 199, qty: 3 }, { cents: 1, qty: 1 }]), 598);
});

test('discount rounds to the nearest cent and rejects bad input', () => {
  assert.equal(applyDiscount(999, 10), 899);
  assert.throws(() => applyDiscount(100, 101), RangeError);
});
