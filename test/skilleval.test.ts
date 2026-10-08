import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCases, skillStatus } from '../src/skilleval.js';
import { createHash } from 'node:crypto';

const MD = `# Evals: x

intro text

## 1. First case
**Situation**
- An alert fires.
- The row shows X.

**Correct**
- Reads the row with the
  sanctioned read path.
- Names the owner.

**Wrong**
- Edits the ledger.

## 2. No correct section
**Situation**
- Nothing.
`;

test('cases parse from markdown: situation, correct and wrong bullets (wrapped lines joined)', () => {
  const cases = parseCases(MD);
  assert.equal(cases.length, 1, 'a case without a Correct list is not a case');
  assert.equal(cases[0]!.title, 'First case');
  assert.match(cases[0]!.situation, /alert fires[\s\S]*row shows X/);
  assert.deepEqual(cases[0]!.correct, ['Reads the row with the sanctioned read path.', 'Names the owner.']);
  assert.deepEqual(cases[0]!.wrong, ['Edits the ledger.']);
});

test('a skill is a draft until its evals pass for its exact text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'));
  mkdirSync(join(dir, 'evals'));
  writeFileSync(join(dir, 'SKILL.md'), 'v1');
  assert.equal(skillStatus(dir), 'draft');
  const hash = createHash('sha256').update('v1').digest('hex');
  const results = (passed: number) => JSON.stringify({ skill_sha256: hash, model: 'm', judge: 'j', at: '', passed, total: 2, cases: [] });
  writeFileSync(join(dir, 'evals', 'results.json'), results(1));
  assert.equal(skillStatus(dir), 'failing');
  writeFileSync(join(dir, 'evals', 'results.json'), results(2));
  assert.equal(skillStatus(dir), 'evaluated');
  writeFileSync(join(dir, 'SKILL.md'), 'v2: edited');
  assert.equal(skillStatus(dir), 'stale', 'editing the skill invalidates its eval');
});
