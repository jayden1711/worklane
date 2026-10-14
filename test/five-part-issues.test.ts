// Issues the harness drafts itself have five parts, and the contract parser checks all five.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraftedIssue, DRAFT_FORMAT, ISSUE_PARTS, issueParts, parseContract } from '../src/backlog/types.js';
import { defaultRolePrompt } from '../src/roles.js';
import { INTAKE_PROMPT } from '../src/intake/run.js';

const GOOD = [
  '**Outcome:** Totals skip zero quantities.',
  '**Sources:** src/totals.js and its tests; nowhere else.',
  '**Constraints:** leave rounding and tax handling alone.',
  '**Deliverable:**',
  '```done_when',
  '- command: |',
  '    npm test -- --grep zero',
  '```',
  '**Review point:** L1; waits for the owner if it changes a public API.',
  '',
].join('\n');

test('a five-part draft passes and yields its done_when', () => {
  const c = checkDraftedIssue('Skip zero quantities', GOOD);
  assert.ok(c.ok);
  assert.deepEqual(c.done_when, [{ command: 'npm test -- --grep zero\n' }]);
});

test('every missing or empty part is named', () => {
  const c = checkDraftedIssue('t', GOOD.replace(/\*\*Sources:\*\*.*\n/, '').replace('**Constraints:** leave rounding and tax handling alone.', '**Constraints:**'));
  assert.deepEqual(c, { ok: false, why: 'the draft needs all five parts (Outcome, Sources, Constraints, Deliverable, Review point); missing or empty: Sources, Constraints' });
});

test('the Outcome is one line, the Deliverable holds a valid block-scalar done_when, the Review point names a level', () => {
  assert.match((checkDraftedIssue('t', GOOD.replace('zero quantities.', 'zero quantities.\nAnd more.')) as { why: string }).why, /one sentence on one line/);
  assert.match((checkDraftedIssue('t', GOOD.replace('command: |\n    npm test -- --grep zero', 'command: npm test')) as { why: string }).why, /block scalars/);
  assert.match((checkDraftedIssue('t', GOOD.replace('```done_when\n- command: |\n    npm test -- --grep zero\n```', 'the tests pass')) as { why: string }).why, /^Deliverable: no ```done_when block/);
  assert.match((checkDraftedIssue('t', GOOD.replace('L1; waits', 'Low; waits')) as { why: string }).why, /review level \(L0 to L3\)/);
  assert.match((checkDraftedIssue(' ', GOOD) as { why: string }).why, /no title/);
});

test('labels: bold with the colon inside or out, or headings; a label inside a code fence is not a part', () => {
  const headings = GOOD.replace('**Outcome:**', '## Outcome\n').replace('**Sources:** ', '## Sources:\n').replace('**Constraints:**', '**Constraints**:');
  assert.ok(checkDraftedIssue('t', headings).ok);
  const fenced = GOOD.replace('**Sources:** src/totals.js and its tests; nowhere else.\n', '```\n**Sources:** in a fence\n```\n');
  assert.equal(issueParts(fenced).Sources, null);
  assert.equal(issueParts(GOOD.replace(/\n/g, '\r\n')).Outcome, 'Totals skip zero quantities.');
});

test('issues people write still need only the done_when block', () => {
  assert.ok(parseContract('Fix it.\n\n```done_when\n- test: t.js\n```\n').ok);
});

test('the drafters are told the five parts', () => {
  for (const p of ISSUE_PARTS) {
    assert.ok(DRAFT_FORMAT.includes(`**${p}:**`), `DRAFT_FORMAT names ${p}`);
    assert.ok(defaultRolePrompt('chief_of_staff').includes(`**${p}:**`), `the chat role names ${p}`);
  }
  assert.ok(INTAKE_PROMPT.includes(DRAFT_FORMAT), 'the intake prompt carries the format');
});
