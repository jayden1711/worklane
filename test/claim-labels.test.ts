// Every claim labeled measured / inferred / guess, and no check handed to the reader that the agent could run itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimLines, handoffDoubt, handoffs, readClaims } from '../src/claim-labels.js';
import { rolePrompt, VERDICT_SCHEMA, WORKER_SCHEMA } from '../src/roles.js';
import { calibrated, verdictRefusal } from '../src/verdict-confidence.js';

test('claim labels: the worker and the evaluator schemas require labeled claims, and the evaluator prompt says so (the worker prompt is unchanged)', () => {
  for (const schema of [WORKER_SCHEMA, VERDICT_SCHEMA]) {
    assert.ok((schema.required as readonly string[]).includes('claims'));
    assert.deepEqual(schema.properties.claims.items.properties.label.enum, ['measured', 'inferred', 'guess']);
    assert.deepEqual(schema.properties.claims.items.required, ['claim', 'label', 'basis']);
  }
  assert.match(rolePrompt('/nonexistent', 'evaluator-verdict'), /A verdict without labeled claims is refused and you're asked again/);
});

test('claim labels: readClaims keeps labeled claims and names each unlabeled one and each measured claim without its command', () => {
  assert.deepEqual(readClaims(undefined).problems, ['no labeled claims (each claim measured, inferred or guess)']);
  assert.deepEqual(readClaims([]).problems, ['no labeled claims (each claim measured, inferred or guess)']);
  const r = readClaims([
    { claim: 'the price tests pass', label: 'measured', basis: 'npm test: 12 pass' },
    { claim: 'other callers are unaffected', label: 'inferred', basis: 'read src/price.js' },
    { claim: 'it works on Safari', label: 'probably', basis: '' },
    { claim: 'the cache is warm', label: 'measured', basis: ' ' },
  ]);
  assert.deepEqual(r.claims.map((c) => c.label), ['measured', 'inferred', 'measured']);
  assert.deepEqual(r.problems, ['"it works on Safari" has no label (measured, inferred or guess)', '"the cache is warm" is labeled measured but names no command or check']);
});

test('claim labels: a handoff is flagged ("please run", "you can verify by running", "run `x` to confirm"); a report of what was run is not', () => {
  const handed = [
    'Please run the migration tests before merging.',
    'You can verify this by running `npm test -- test/export.test.js`.',
    'Run `npm run e2e` to confirm the flow still works.',
    'To verify, run the export script against a sample file.',
    'I left it for the reviewer to check the output by hand.',
    'This needs manual verification by the owner.',
  ];
  for (const s of handed) assert.deepEqual(handoffs(s), [s], s);
  const reports = [
    'I ran `npm test -- test/export.test.js`: 12 pass.',
    'Verified by running the export test; it passes.',
    'The test runs the export and checks the header row.',
    'Checked src/export.js: the JSON path is untouched.',
  ];
  for (const s of reports) assert.deepEqual(handoffs(s), [], s);
  assert.deepEqual(handoffs('Fixed the header. Please run the e2e suite.', undefined, 'You should test it on staging.'), ['Please run the e2e suite.', 'You should test it on staging.']);
});

test('claim labels: an unlabeled verdict is refused (asked once more); a handoff or unlabeled claims lower a high confidence with that reason', () => {
  assert.match(verdictRefusal({ confidence: 'high' })!, /claims must list each claim your verdict rests on, labeled measured .*no labeled claims/);
  assert.match(verdictRefusal({ confidence: 'medium', claims: [{ claim: 'x', label: 'sure', basis: '' }] })!, /confidence medium needs confidence_reason, .*; and claims must list .*"x" has no label/);
  assert.equal(verdictRefusal({ confidence: 'high', claims: [{ claim: 'read the diff', label: 'measured', basis: 'git diff' }] }), null);
  const doubt = handoffDoubt('the worker', ['Please run the e2e suite.']);
  assert.equal(doubt, 'the worker handed the reader a check it could run itself instead of running it: "Please run the e2e suite."');
  assert.deepEqual(calibrated({ confidence: 'high', unverified: 0, compromised: [], doubts: [doubt] }), { confidence: 'medium', confidence_reason: doubt });
});

test('claim labels: the PR body lists each claim with its label, and says when none were labeled', () => {
  assert.deepEqual(claimLines('Worker', [{ claim: 'the `price` tests pass', label: 'measured', basis: 'npm test' }, { claim: 'nothing else changes', label: 'guess', basis: '' }]), [
    '**Worker:**',
    "- measured: the 'price' tests pass (npm test)",
    '- guess: nothing else changes',
  ]);
  assert.deepEqual(claimLines('Evaluator', [], ['no labeled claims (each claim measured, inferred or guess)']), ['**Evaluator:**', '- none labeled', '- not labeled: no labeled claims (each claim measured, inferred or guess)']);
});
