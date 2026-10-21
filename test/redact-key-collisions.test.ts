// Redacting an object's keys (#972) keeps every entry: two keys redacted alike, or a redacted key that would take the
// name of a key that already reads like the redacted text, never collapse into one field.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/events/redact.js';

// Built from parts, so no token-shaped string sits in the source.
const token = (unit: string) => ['gh', 'p_', unit.repeat(12)].join('');

test('redaction: keys that redact alike keep every entry, numbered in order, and keys with no secret stay as they are', () => {
  const a = token('Ab1');
  const b = token('Cd2');
  const out = redact({ [a]: 1, [b]: 2, 'gh*_[REDACTED]': 3, 'gh*_[REDACTED] (2)': 4, plain: 5 });
  assert.deepEqual(out, { 'gh*_[REDACTED] (3)': 1, 'gh*_[REDACTED] (4)': 2, 'gh*_[REDACTED]': 3, 'gh*_[REDACTED] (2)': 4, plain: 5 });
  assert.equal(Object.keys(out).length, 5, 'no entry dropped');
  // The same input, the same keys: the numbering follows the entries' order.
  assert.deepEqual(Object.keys(redact({ [a]: 1, [b]: 2 })), ['gh*_[REDACTED]', 'gh*_[REDACTED] (2)']);
  // A key named like an object's own prototype stays an ordinary field.
  const proto = redact(JSON.parse(`{"__proto__": {"x": 1}, "${a}": 2}`) as Record<string, unknown>);
  assert.deepEqual(Object.keys(proto).sort(), ['__proto__', 'gh*_[REDACTED]'].sort());
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});
