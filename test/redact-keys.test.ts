// The shared redactor redacts an object's keys as well as its values (#972), and keeps the shape: the same nesting,
// arrays as arrays, keys and values that hold no secret as they were.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, TRACKER } from '../src/events/redact.js';

// Built from parts, so no token-shaped string sits in the source.
const TOKEN = ['gh', 'p_', 'Ab1'.repeat(12)].join('');
const KEY_ID = ['AK', 'IA', 'ABCDEFGH12345678'].join('');

test('redaction: a secret in an object key is redacted like one in a value, and the shape is kept', () => {
  const v = { [TOKEN]: 1, plain: { [`token ${KEY_ID}`]: [TOKEN, 2], ok: true }, list: [{ [KEY_ID]: null }] };
  const out = redact(v);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(TOKEN) && !text.includes(KEY_ID), text);
  assert.deepEqual(out, { 'gh*_[REDACTED]': 1, plain: { 'token AKIA[REDACTED]': ['gh*_[REDACTED]', 2], ok: true }, list: [{ 'AKIA[REDACTED]': null }] });
  // Keys with nothing secret in them stay, identifiers mode included.
  assert.deepEqual(redact({ id: 3, nested: { name: 'x' } }, TRACKER), { id: 3, nested: { name: 'x' } });
  assert.deepEqual(Object.keys(redact({ 'a@example.com': 1 }, TRACKER)), ['[email]']);
});
