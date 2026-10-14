import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContract } from '../src/backlog/types.js';

// Until the coordinator ran browser checks, a contract with one was refused, so a browser check could never be
// skipped and counted as passed. verify() runs them now (src/coordinator/browser.ts), so the contract takes one;
// this test changed on purpose with that wiring.
test('a done_when with a browser: check is accepted now that verify() runs browser checks; a bad flow name is refused', () => {
  const r = parseContract('```done_when\n- test: test/cart.test.js\n- browser: checkout\n```\n');
  assert.deepEqual(r, { ok: true, done_when: [{ test: 'test/cart.test.js' }, { browser: 'checkout' }] });
  for (const bad of ['- browser: Check Out', '- browser: ""', '- browser: checkout\n  shell: rm -rf /']) assert.equal(parseContract(`\`\`\`done_when\n${bad}\n\`\`\`\n`).ok, false, bad);
});
