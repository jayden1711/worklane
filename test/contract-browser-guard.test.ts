import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContract } from '../src/backlog/types.js';

// The coordinator's verify() runs command, suite and test checks and passes over any other kind. Until the
// browser check is wired into it (Track B's coordinator turn), a contract with one must be refused, so a
// browser check can never be skipped and counted as passed. The wiring PR changes this test on purpose.
test('a done_when with a browser: check is refused until the coordinator runs browser checks', () => {
  const r = parseContract('```done_when\n- test: test/cart.test.js\n- browser: checkout\n```\n');
  assert.equal(r.ok, false);
  assert.ok(parseContract('```done_when\n- test: test/cart.test.js\n```\n').ok, 'a contract without one is unchanged');
});
