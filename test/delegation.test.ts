import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDraftedIssue } from '../src/backlog/types.js';
import { ReviewConfig } from '../src/config/schema.js';
import { categoryRecords, delegationIssue, delegationView, loosenedProblems, reviewListCheck, suggestions } from '../src/delegation.js';

const review = (o: { wait?: string[]; loosened?: string[]; l3?: string[] } = {}) => ({ levels: { L3_human: { when: o.l3 ?? ['migration'] } }, merge: { wait_categories: o.wait ?? ['copy'], loosened: o.loosened ?? [] } });
const ev = (type: string, payload: object) => ({ ts: '2026-10-12T10:00:00.000Z', type, payload });
const obs = (pr: number, categories: string[], unchanged = true) => ev('delegation.observed', { pr, issue: pr + 100, categories, unchanged });

test('high-risk and safety-floor categories can never be loosened: review.yaml listing one as loosened is rejected', () => {
  assert.deepEqual(loosenedProblems({ ...review({ loosened: ['copy', 'auth', 'ci-config', 'billing'], l3: ['billing'] }) }), [
    'merge.loosened: auth is high-risk or a safety floor and can never be loosened',
    'merge.loosened: ci-config is high-risk or a safety floor and can never be loosened',
    'merge.loosened: billing is high-risk or a safety floor and can never be loosened',
  ]);
  const yaml = { version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: ['migration'] } } };
  assert.equal(ReviewConfig.safeParse({ ...yaml, merge: { loosened: ['copy'] } }).success, true);
  const bad = ReviewConfig.safeParse({ ...yaml, merge: { loosened: ['migration'] } });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /migration is high-risk or a safety floor/);
  assert.deepEqual(ReviewConfig.parse(yaml).delegation, { enabled: false, min_clean: 10 }, 'off by default');
});

test("each category's record since the last decision on it: clean, changed, reverted, main red, a later fix", () => {
  const r = categoryRecords(
    [
      obs(1, ['copy']),
      ev('delegation.decided', { category: 'copy', decision: 'd', answer: 'keep', by: 'o', issue: null }),
      obs(2, ['copy', 'docs']),
      obs(3, ['copy'], false),
      obs(4, ['copy']),
      ev('merge.stopped', { reason: 'main red', number: 4, sha: null, revert: 'url' }),
      obs(5, ['copy']),
      ev('merge.main_result', { issue: 105, number: 5, sha: 'a', outcome: 'red', failed: ['t'] }),
      obs(6, ['copy']),
      ev('issue.seen', { issue: 200, title: 'Fix the regression from #106', labels: [], author: 'o', owner: null, actionable: true, why: '' }),
    ],
    review(),
  );
  const copy = r.find((x) => x.category === 'copy')!;
  assert.deepEqual([copy.waits, copy.protected, copy.prs, copy.clean, copy.changed, copy.reverted, copy.mainRed, copy.laterFix], [true, false, [2, 3, 4, 5, 6], 1, 1, 1, 1, 1]);
  assert.deepEqual(copy.evidence, ['PR #2 (#102): clean', 'PR #3 (#103): changed', 'PR #4 (#104): reverted', 'PR #5 (#105): main red', 'PR #6 (#106): later fix']);
});

test('a waiting category with min_clean PRs approved unchanged is proposed for loosening; never a protected one, never twice', () => {
  const clean = (cat: string) => [1, 2, 3].map((n) => obs(n, [cat]));
  const s = suggestions(categoryRecords(clean('copy'), review()), { minClean: 3, open: new Set() });
  assert.deepEqual(s.map((x) => [x.category, x.direction, x.options, x.recommendation]), [['copy', 'loosen', ['loosen', 'keep'], 'loosen']]);
  assert.match(s[0]!.receipts[0]!, /3 PRs in copy merged as proposed/);
  assert.deepEqual(suggestions(categoryRecords(clean('copy').slice(0, 2), review()), { minClean: 3, open: new Set() }), [], 'not yet');
  assert.deepEqual(suggestions(categoryRecords([...clean('copy'), obs(4, ['copy'], false)], review()), { minClean: 3, open: new Set() }), [], 'a changed PR is not a clean record');
  assert.deepEqual(suggestions(categoryRecords(clean('migration'), review({ wait: ['migration'] })), { minClean: 3, open: new Set() }), [], 'protected');
  assert.deepEqual(suggestions(categoryRecords(clean('copy'), review()), { minClean: 3, open: new Set(['copy']) }), [], 'already asked');
});

test('a loosened category with a revert, a red main or a later fix is proposed for tightening (tighten recommended)', () => {
  const s = suggestions(categoryRecords([obs(1, ['copy']), obs(2, ['copy']), ev('merge.stopped', { reason: 'x', number: 2, sha: null, revert: 'u' })], review({ wait: [], loosened: ['copy'] })), { minClean: 3, open: new Set() });
  assert.deepEqual(s.map((x) => [x.direction, x.recommendation]), [['tighten', 'tighten']]);
  assert.match(s[0]!.question, /Since it was loosened: 1 reverted/);
  assert.deepEqual(suggestions(categoryRecords([obs(1, ['copy'])], review({ wait: [], loosened: ['copy'] })), { minClean: 3, open: new Set() }), []);
});

test("the issue for an answer is five parts, and its check fails on the unchanged review.yaml and passes once changed (flow and block lists)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'deleg-'));
  const run = (yaml: string, dir2: 'loosen' | 'tighten') => {
    writeFileSync(join(dir, 'review.yaml'), yaml);
    try {
      execSync(reviewListCheck('review.yaml', 'copy', dir2), { cwd: dir, stdio: 'ignore' });
      return 0;
    } catch {
      return 1;
    }
  };
  const flowBefore = 'version: 1\nmerge:\n  auto: true\n  wait_categories: [copy, ui]  # waits\n  loosened: []\n';
  const flowAfter = 'version: 1\nmerge:\n  auto: true\n  wait_categories: [ui]\n  loosened: [copy]\n';
  const blockBefore = 'version: 1\nmerge:\n  wait_categories:\n    - copy\n    - ui\n';
  const blockAfter = 'version: 1\nmerge:\n  wait_categories:\n    - ui\n  loosened:\n    - copy\n';
  assert.deepEqual([run(flowBefore, 'loosen'), run(flowAfter, 'loosen'), run(blockBefore, 'loosen'), run(blockAfter, 'loosen')], [1, 0, 1, 0]);
  assert.deepEqual([run(flowAfter, 'tighten'), run(flowBefore, 'tighten'), run(blockAfter, 'tighten'), run(blockBefore, 'tighten')], [1, 0, 1, 0]);
  assert.deepEqual([run(flowAfter.replace(/\n/g, '\r\n'), 'loosen')], [0], 'CRLF');
  const i = delegationIssue('copy', 'loosen', '.worklane', ['PR #2 (#102): clean']);
  assert.equal(checkDraftedIssue(i.title, i.body).ok, true, JSON.stringify(checkDraftedIssue(i.title, i.body)));
  assert.throws(() => reviewListCheck('review.yaml', 'co"py', 'loosen'));
});

test("the dashboard's read model: records, and each suggestion with its evidence and answer", () => {
  const v = delegationView(
    [obs(1, ['copy']), ev('delegation.suggested', { category: 'copy', direction: 'loosen', decision: 'd-1', receipts: ['r'] }), ev('delegation.decided', { category: 'copy', decision: 'd-1', answer: 'loosen', by: 'o', issue: 9 })],
    review(),
  );
  assert.deepEqual(v.suggestions, [{ category: 'copy', direction: 'loosen', at: '2026-10-12T10:00:00.000Z', decision: 'd-1', receipts: ['r'], answer: 'loosen', by: 'o', issue: 9 }]);
  assert.equal(v.categories.find((c) => c.category === 'copy')!.prs.length, 0, 'the answer starts a new record');
});
