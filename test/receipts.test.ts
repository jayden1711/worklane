import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsOf, lowerConfidence, receiptLines, unbackedClaims, type CheckRecord } from '../src/receipts.js';

const passed: CheckRecord[] = [{ check: 'node --test test/price.test.js', status: 'pass', exitCode: 0, duration_ms: 1200 }];

test('claims are the summary sentences that say something was verified', () => {
  assert.deepEqual(claimsOf('Guarded the totals reducer. The price tests pass. Tested on mobile Safari.'), ['The price tests pass.', 'Tested on mobile Safari.']);
  assert.deepEqual(claimsOf('Renamed a variable.'), []);
});

test('a claim about a place or way the coordinator never checks is not backed, whatever passed', () => {
  assert.deepEqual(unbackedClaims(['Tested on mobile Safari.', 'Verified manually in the UI.', 'Checked it on staging.'], { checks: passed, commands: [] }).length, 3);
});

test('a claim naming a command or file is backed only by a passing check or a successful worker command that contains it', () => {
  const claims = ['Ran `npm run e2e` and it passed.', 'Ran `node --test test/price.test.js`: passes.', 'test/price.test.js passes.', 'Ran `npm run lint`, clean.'];
  assert.deepEqual(unbackedClaims(claims, { checks: passed, commands: ['npm run lint'] }), ['Ran `npm run e2e` and it passed.']);
  assert.deepEqual(unbackedClaims(['Ran `npm run e2e` on mobile, passes.'], { checks: passed, commands: ['npm run e2e'] }), [], 'a recorded command backs even an environment claim it names');
});

test('a generic claim is backed only when at least one of the coordinator\'s checks passed', () => {
  assert.deepEqual(unbackedClaims(['The tests pass.'], { checks: passed, commands: [] }), []);
  assert.deepEqual(unbackedClaims(['The tests pass.'], { checks: [{ check: 'x', status: 'fail' }], commands: [] }), ['The tests pass.']);
});

test('confidence drops one step for any unbacked claim, never below low', () => {
  assert.deepEqual([lowerConfidence('high', 0), lowerConfidence('high', 2), lowerConfidence('medium', 1), lowerConfidence('low', 1)], ['high', 'medium', 'low', 'low']);
});

test('receipts: VERIFIED is each check that ran with its result; NOT CHECKED is manual items and skipped or unavailable checks', () => {
  const lines = receiptLines({
    checks: [...passed, { check: 'npm run `full`', status: 'fail', exitCode: 2, duration_ms: 400 }, { check: 'npm run long', status: 'skipped' }, { check: 'db check', status: 'unavailable' }],
    doneWhen: [{ test: 'test/price.test.js' }, { manual: 'the receipt prints on the shop printer' }],
    unverified: ['Tested on mobile Safari.'],
  }).join('\n');
  assert.equal(
    lines,
    [
      '### VERIFIED',
      '- `node --test test/price.test.js`: pass, 1s',
      "- `npm run 'full'`: fail, exit 2, 0s",
      '',
      '### NOT VERIFIED',
      '- "Tested on mobile Safari." (claimed by the worker; no recorded command or check backs it, so it is not evidence)',
      '',
      '### NOT CHECKED',
      '- manual: the receipt prints on the shop printer',
      '- `npm run long`: skipped (an earlier check failed)',
      '- `db check`: unavailable',
    ].join('\n'),
  );
  assert.match(receiptLines({ checks: [], doneWhen: [], unverified: [] }).join('\n'), /### VERIFIED\n- nothing: the coordinator ran no checks[\s\S]*### NOT VERIFIED\n- nothing[\s\S]*### NOT CHECKED\n- nothing/);
});
