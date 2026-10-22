// #889 round 7 (the round-6 delta, Q3): the passes fail closed. Each mode passes over its own output until nothing
// changes; a text still changing after the bound becomes the placeholder, never the last pass's output (which one more
// pass would have redacted further). Before, each mode stopped after 3 passes whatever a 4th would have found.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as redactModule from '../src/events/redact.js';
import { redactString, UNSCANNABLE } from '../src/events/redact.js';

type FixedPoint = (s: string, pass: (t: string) => string, keepLines?: boolean) => string;
const fixedPoint = (redactModule as unknown as { fixedPoint?: FixedPoint }).fixedPoint;
const MAX_PASSES = (redactModule as unknown as { MAX_PASSES?: number }).MAX_PASSES;

test('a pass that keeps changing the text past the bound gives the placeholder, line breaks kept when asked', () => {
  assert.equal(typeof fixedPoint, 'function');
  assert.ok(typeof MAX_PASSES === 'number' && MAX_PASSES > 3);
  const shrink = (t: string) => t.slice(1);
  assert.equal(fixedPoint!('a'.repeat(100), shrink), UNSCANNABLE);
  assert.equal(fixedPoint!(`a\nb\n${'c'.repeat(100)}`, shrink, true), `${UNSCANNABLE}\n\n`);
});

test('a text that needs more than 3 passes, within the bound, gets them all', () => {
  let passes = 0;
  const strip = (t: string) => {
    passes++;
    return t.replace(/^x/, '');
  };
  // Four x's: four passes change it, a fifth confirms nothing changes.
  assert.equal(fixedPoint!('xxxxdone', strip), 'done');
  assert.equal(passes, 5);
});

test('both modes reach a fixed point: redacting the output again changes nothing (generated, glued pieces)', () => {
  const T = 'pL0oK9iJ8uH7yG6tF5rD4eS3Mn3Bv4Cx5Zl6Kj7H';
  const PIECES = [`${'ghp'}_`, `${'github'}_pat_`, `${'sk'}-ant-`, `${'sk'}-`, `${'xoxb'}-`, `${'eyJ'}`, 'AKIA', `${'wld'}_`, `${'tskey'}-`, 'Bearer ', 'basic ', 'https://', 'u:', '@', '.', '-', '_', ' ', '"', ':', '=', '\n', '\u001b[1m', '\\n', '[REDACTED]', ']', '[', 'token=', '"api_key":"', T, T.slice(0, 16), T.slice(0, 8)];
  let seed = 777;
  const rnd = (k: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % k;
  };
  const moved: string[] = [];
  for (let i = 0; i < 20_000; i++) {
    let s = '';
    for (let j = 2 + rnd(9); j > 0; j--) s += PIECES[rnd(PIECES.length)];
    for (const o of [{}, { broad: true }]) {
      const once = redactString(s, o);
      if (redactString(once, o) !== once && moved.length < 10) moved.push(JSON.stringify(s));
    }
  }
  assert.deepEqual(moved, []);
});
