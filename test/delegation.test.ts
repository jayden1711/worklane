import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDraftedIssue } from '../src/backlog/types.js';
import { ReviewConfig } from '../src/config/schema.js';
import { categoryRecords, delegationIssue, delegationView, loosenedProblems, reviewListCheck, suggestions } from '../src/delegation.js';
import { EventSchemas } from '../src/events/types.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

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

const HOUR = 3_600_000;
/** An observed PR that waited for a person: approved by `by` (`role`) `waitMs` after it started waiting. */
const held = (pr: number, categories: string[], by: string, role: 'owner' | 'writer' | null, waitMs: number | null, unchanged = true) => ev('delegation.observed', { pr, issue: pr + 100, categories, unchanged, held: true, approved_by: by, approver_role: role, wait_ms: waitMs });

test('a category approved unchanged N times with no reverts is suggested with the evidence: time to approve, approvals unchanged, who approved', () => {
  const events = [held(1, ['copy'], 'example-owner', 'owner', 1 * HOUR), held(2, ['copy'], 'example-collaborator', 'writer', 30 * 60_000), held(3, ['copy'], 'example-owner', 'owner', 3 * HOUR), obs(4, ['copy'])];
  const r = categoryRecords(events, review()).find((x) => x.category === 'copy')!;
  assert.deepEqual([r.clean, r.held, r.wait], [4, 3, { medianMs: 1 * HOUR, fastestMs: 30 * 60_000, slowestMs: 3 * HOUR, count: 3 }]);
  assert.deepEqual(r.approvers, [
    { by: 'example-collaborator', role: 'writer', approvals: 1, unchanged: 1, bad: 0, medianWaitMs: 30 * 60_000 },
    { by: 'example-owner', role: 'owner', approvals: 2, unchanged: 2, bad: 0, medianWaitMs: 2 * HOUR },
  ]);
  assert.equal(r.evidence[1], 'PR #2 (#102): clean, approved by @example-collaborator (writer) after 30m');
  assert.equal(r.evidence[3], 'PR #4 (#104): clean', 'a PR that never waited for a person says nothing about approval');
  const [s] = suggestions([r], { minClean: 4, open: new Set() });
  assert.match(s!.question, /^Stop waiting for you on copy changes\? 4 PRs in a row were approved unchanged \(median time to approve 1h 0m\)$/);
  assert.ok(s!.receipts.includes('Time to approve: median 1h 0m over the 3 PRs that waited for a person (fastest 30m, slowest 3h 0m)'), s!.receipts.join('\n'));
  assert.ok(s!.receipts.includes('Approved unchanged, by who approved: @example-owner (owner) 2 of 2, @example-collaborator (writer) 1 of 1'), s!.receipts.join('\n'));
  assert.ok(s!.receipts.includes('PR #3 (#103): clean, approved by @example-owner (owner) after 3h 0m'));
  const noTimes = suggestions(categoryRecords([obs(1, ['copy']), obs(2, ['copy'])], review()), { minClean: 2, open: new Set() })[0]!;
  assert.equal(noTimes.question, 'Stop waiting for you on copy changes? 2 PRs in a row were approved unchanged', 'no approvals recorded: no figures made up');
  assert.ok(!noTimes.receipts.some((x) => /Time to approve|by who approved/.test(x)));
});

test('locked, high-risk, safety-floor and agent-instructions categories are never suggested, whatever their record; nothing is ever loosened by a suggestion', () => {
  const cats = ['agent-instructions', 'self-modification', 'auth', 'ci-config', 'dependency', 'billing'];
  const events = [1, 2, 3, 4, 5].map((n) => held(n, cats, 'example-owner', 'owner', HOUR));
  const recs = categoryRecords(events, review({ wait: cats, l3: ['billing'] }));
  assert.deepEqual(recs.map((r) => [r.category, r.protected, r.clean]), cats.slice().sort().map((c) => [c, true, 5]));
  assert.deepEqual(suggestions(recs, { minClean: 1, open: new Set() }), []);
  const v = delegationView(events, review({ wait: cats, l3: ['billing'] }));
  assert.deepEqual(v.categories.map((c) => [c.category, c.waits, c.loosened]), cats.slice().sort().map((c) => [c, true, false]), 'the read model only reports');
});

test('per-person history where writers approve: every approval across categories, with its outcomes', () => {
  const v = delegationView(
    [
      held(1, ['copy'], 'example-collaborator', 'writer', 2 * HOUR),
      held(2, ['docs', 'copy'], 'example-collaborator', 'writer', 4 * HOUR),
      ev('merge.stopped', { reason: 'main red', number: 2, sha: null, revert: 'url' }),
      held(3, ['docs'], 'example-collaborator', 'writer', null, false),
      held(4, ['copy'], 'example-owner', 'owner', HOUR),
      obs(5, ['copy']),
    ],
    review({ wait: ['copy', 'docs'] }),
  );
  assert.deepEqual(v.approvers, [
    { by: 'example-collaborator', role: 'writer', approvals: 3, unchanged: 1, bad: 1, medianWaitMs: 3 * HOUR, categories: ['copy', 'docs'] },
    { by: 'example-owner', role: 'owner', approvals: 1, unchanged: 1, bad: 0, medianWaitMs: HOUR, categories: ['copy'] },
  ]);
});

test('an older delegation.observed event, logged before approvals were recorded, still parses and counts as not waiting for anyone', () => {
  const old = { pr: 7, issue: 107, categories: ['copy'], unchanged: true };
  assert.deepEqual(EventSchemas['delegation.observed'].parse(old), old);
  assert.equal(EventSchemas['delegation.observed'].safeParse({ ...old, held: true, approved_by: 'example-owner', approver_role: 'owner', wait_ms: 60_000 }).success, true);
  assert.equal(EventSchemas['delegation.observed'].safeParse({ ...old, held: true, approved_by: null, approver_role: null, wait_ms: null }).success, true);
  assert.equal(EventSchemas['delegation.observed'].safeParse({ ...old, approver_role: 'viewer' }).success, false, 'still strict');
  assert.equal(EventSchemas['delegation.observed'].safeParse({ ...old, wait_ms: -1 }).success, false);
  const r = categoryRecords([ev('delegation.observed', old)], review()).find((x) => x.category === 'copy')!;
  assert.deepEqual([r.clean, r.held, r.wait, r.approvers, r.evidence], [1, 0, null, [], ['PR #7 (#107): clean']]);
});

test('dashboard: owners and writers read the delegation summary (GET only); anyone else is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deleg-dash-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  log.append('delegation.observed', { pr: 3, issue: 103, categories: ['docs'], unchanged: true, held: true, approved_by: 'example-collaborator', approver_role: 'writer', wait_ms: 60_000 }, 'c');
  log.append('delegation.observed', { pr: 4, issue: 104, categories: ['docs'], unchanged: true }, 'c');
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), pollMs: 50 });
  const base = d.url.split('/?')[0]!;
  const req = (who: string, method = 'GET') => fetch(`${base}/api/delegation`, { method, headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(who) }, ...(method === 'POST' ? { body: '{}' } : {}) });
  try {
    assert.equal((await req('someone-else')).status, 403);
    assert.equal((await req('example-owner', 'POST')).status, 405);
    const w = (await (await req('example-collaborator')).json()) as { enabled: boolean; minClean: number; categories: { category: string; clean: number; held: number }[]; approvers: { by: string; categories: string[] }[] };
    assert.deepEqual([w.enabled, w.minClean], [false, 10]);
    assert.deepEqual(w.categories.filter((c) => c.category === 'docs').map((c) => [c.clean, c.held]), [[2, 1]]);
    assert.deepEqual(w.approvers.map((a) => [a.by, a.categories]), [['example-collaborator', ['docs']]]);
  } finally {
    await d.close();
    log.close();
  }
});

test("the dashboard's read model: records, and each suggestion with its evidence and answer", () => {
  const v = delegationView(
    [obs(1, ['copy']), ev('delegation.suggested', { category: 'copy', direction: 'loosen', decision: 'd-1', receipts: ['r'] }), ev('delegation.decided', { category: 'copy', decision: 'd-1', answer: 'loosen', by: 'o', issue: 9 })],
    review(),
  );
  assert.deepEqual(v.suggestions, [{ category: 'copy', direction: 'loosen', at: '2026-10-12T10:00:00.000Z', decision: 'd-1', receipts: ['r'], answer: 'loosen', by: 'o', issue: 9 }]);
  assert.equal(v.categories.find((c) => c.category === 'copy')!.prs.length, 0, 'the answer starts a new record');
});
