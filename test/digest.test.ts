import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredEvent } from '../src/events/types.js';
import { digestMarkdown, waited, waitingOnYou, WAIT_KINDS } from '../src/digest.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const h = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
let id = 0;
const ev = (type: string, payload: object, ts: string): StoredEvent => ({ id: ++id, ts, type, payload, instance: 'i', source: 'coordinator' }) as unknown as StoredEvent;
const sha = (c: string) => c.repeat(40);
const seen = (issue: number, title: string, ts = h(200)) => ev('issue.seen', { issue, title, labels: ['ready'], author: 'o', owner: 'o', actionable: true, why: '' }, ts);
const ask = (did: string, kind: string, issue: number | null, ts: string, question = 'Which rounding mode?') => ev('decision.asked', { id: did, kind, issue, owner: 'example-owner', question, options: [], recommendation: '', receipts: [] }, ts);
const status = (issue: number, n: number, head: string, ready: boolean, checks: [string, string][], ts: string) => ev('pr.status', { issue, number: n, head, ready, reasons: [], checks: checks.map(([name, outcome]) => ({ name, outcome })), }, ts);

/** One of every owner-held state still open, and one of each that already ended. */
function log(): StoredEvent[] {
  return [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => seen(n, `Task ${n}`)),
    ev('pr.opened', { issue: 3, number: 31, url: 'u', head: sha('a'), draft: true }, h(100)),
    ev('pr.opened', { issue: 4, number: 41, url: 'u', head: sha('b'), draft: true }, h(100)),
    ev('pr.opened', { issue: 5, number: 51, url: 'u', head: sha('c'), draft: true }, h(100)),
    ev('pr.opened', { issue: 9, number: 91, url: 'u', head: sha('d'), draft: true }, h(100)),
    // Open: an emergency stop; auto-merge stopped.
    ev('emergency.stop', { by: 'example-owner', reason: 'spend', running: 1 }, h(80)),
    ev('merge.stopped', { reason: 'main went red after #31', number: 31, sha: sha('e'), revert: null }, h(70)),
    // An auto-merge whose checks on the merge commit never reported (still); one that did report green later.
    ev('merge.main_result', { issue: 12, number: 121, sha: sha('7'), outcome: 'timed_out', failed: ['ci'] }, h(15)),
    ev('merge.main_result', { issue: 11, number: 111, sha: sha('8'), outcome: 'timed_out', failed: ['ci'] }, h(14)),
    ev('merge.main_result', { issue: 11, number: 111, sha: sha('8'), outcome: 'green', failed: [] }, h(13)),
    // Decisions: one open question, one answered, a plan decision (listed as the held plan, not twice).
    ask('d1', 'question', 1, h(50)),
    ask('d2', 'land', 2, h(40)),
    ev('decision.answered', { id: 'd2', by: 'example-owner', answer: 'approve' }, h(39)),
    ask('d3', 'plan', 6, h(30)),
    ev('plan.posted', { issue: 6, plan: {}, held: true, reasons: ['touches migrations'], comments_at: 0, decision: 'd3' }, h(30)),
    ev('plan.posted', { issue: 7, plan: {}, held: true, reasons: [], comments_at: 0, decision: 'd4' }, h(29)),
    ev('plan.decided', { issue: 7, decision: 'd4', answer: 'approve', by: 'o', note: '' }, h(28)),
    // A PR left to the owner (still open); one that was, but merged.
    ev('merge.decided', { issue: 3, number: 31, head: sha('a'), auto: false, reasons: ['high-risk: migrations'] }, h(60)),
    ev('merge.decided', { issue: 9, number: 91, head: sha('d'), auto: false, reasons: ['big diff'] }, h(60)),
    ev('pr.closed', { issue: 9, number: 91, merged: true }, h(20)),
    // A CI fix that gave up (still), and one that gave up and then ran again.
    ev('ci_fix.gave_up', { issue: 4, number: 41, head: sha('b'), reason: 'no fixes left (2 of 2)' }, h(25)),
    ev('ci_fix.gave_up', { issue: 5, number: 51, head: sha('c'), reason: 'no fixes left' }, h(26)),
    ev('ci_fix.started', { issue: 5, number: 51, head: sha('c'), checks: ['test'], attempt: 3, lease: sha('c') }, h(24)),
    // Blocked on someone; a landing that failed.
    ev('issue.blocked', { issue: 8, owner: 'example-owner', why: 'needs the payment provider key' }, h(48)),
    ev('land.result', { issue: 10, outcome: 'conflict', landed: null, detail: 'conflicts in src/totals.js' }, h(12)),
    // A failed deploy on staging (still), one on production fixed by a later verified deploy.
    ev('deploy.failed', { env: 'staging', sha: sha('f'), why: 'health check 503' }, h(6)),
    ev('deploy.failed', { env: 'production', sha: sha('1'), why: 'timeout' }, h(9)),
    ev('deploy.verified', { env: 'production', sha: sha('2') }, h(8)),
    // A PR held back by a required check that's missing (since its first such status at this head), one that went ready.
    status(5, 51, sha('c'), false, [['test', 'pass'], ['e2e', 'missing']], h(10)),
    status(5, 51, sha('c'), false, [['test', 'pass'], ['e2e', 'missing']], h(5)),
    status(9, 91, sha('d'), false, [['e2e', 'pending']], h(30)),
    ev('pr.ready', { issue: 9, number: 91, head: sha('d') }, h(29)),
    // A hotspot hold (still), and one released.
    ev('hotspot.held', { issue: 11, by: 12, files: ['src/totals.js'], reason: 'r' }, h(3)),
    ev('hotspot.held', { issue: 12, by: 11, files: ['src/cart.js'], reason: 'r' }, h(4)),
    ev('hotspot.released', { issue: 12, waited_ms: 3_600_000, files: ['src/cart.js'], started: true }, h(2)),
  ];
}

test('every owner-held state still open, from the event that opened it; none that already ended', () => {
  // The machine's update log: an engine update rolled back and held (a failed migration).
  const updates = [{ at: h(7), event: 'rolled_back' as const, from: sha('b'), to: sha('a'), reason: 'rollback: migration failed: alice: disk full', held: true }];
  const d = waitingOnYou(log(), NOW, { updates });
  assert.equal(d.items.find((i) => i.kind === 'update_held')!.detail, 'rollback: migration failed: alice: disk full; the commit is held until a newer one, or until an admin releases it at a root shell: sudo bash /opt/worklane/current/scripts/setup/updates.sh --release-hold');
  assert.deepEqual(d.items.map((i) => [i.kind, i.issue, i.pr]), [
    ['emergency_halt', null, null],
    ['merge_stopped', 3, 31],
    ['main_checks_timed_out', 12, 121],
    ['awaiting_decision', 1, null],
    ['plan_held', 6, null],
    ['needs_owner', 3, 31],
    ['ci_fix_gave_up', 4, 41],
    ['blocked', 8, null],
    ['landing_failed', 10, null],
    ['deploy_failed', null, null],
    ['check_held', 5, 51],
    ['hotspot_held', 11, null],
    ['update_held', null, null],
  ]);
  const by = Object.fromEntries(d.items.map((i) => [i.kind, i]));
  assert.equal(by.awaiting_decision!.detail, '@example-owner: Which rounding mode?');
  assert.equal(by.plan_held!.detail, 'touches migrations');
  assert.equal(by.needs_owner!.detail, 'high-risk: migrations');
  assert.equal(by.blocked!.detail, 'needs the payment provider key');
  assert.match(by.landing_failed!.detail, /^landing conflict: conflicts in src\/totals\.js/);
  assert.equal(by.deploy_failed!.detail, 'staging: health check 503');
  assert.equal(by.deploy_failed!.sha, sha('f'));
  assert.equal(by.check_held!.detail, 'e2e missing', 'the check, named');
  assert.equal(by.check_held!.since, h(10), 'since the first status at this head that held it back');
  assert.equal(by.hotspot_held!.detail, 'behind #12, on src/totals.js');
  assert.equal(by.main_checks_timed_out!.detail, 'ci never reported on the merge commit 777777777777; check them yourself');
  assert.equal(by.main_checks_timed_out!.since, h(15));
  assert.equal(by.awaiting_decision!.title, 'Task 1');
  assert.deepEqual([...new Set(d.items.map((i) => i.kind))], [...WAIT_KINDS], 'every kind the issue names');
});

test('nothing times out: a hold from weeks ago is still listed, with how long it has waited', () => {
  const d = waitingOnYou([seen(1, 'Old'), ask('d1', 'question', 1, h(24 * 30))], NOW);
  assert.equal(d.items.length, 1);
  assert.equal(waited(d.items[0]!.since, NOW), '30 days');
  assert.equal(waited(h(0.5), NOW), '30 min');
  assert.equal(waited(h(5), NOW), '5 h');
});

test('the digest\'s Markdown: a heading with the count, a section per kind, each line with its issue or PR and how long it has waited', () => {
  const md = digestMarkdown(waitingOnYou(log(), NOW), { project: 'example-shop' });
  assert.match(md, /^## Waiting on you: example-shop, 2026-10-15 \(12\)\n/);
  assert.match(md, /\*\*Auto-merges whose checks on the default branch never reported\*\* \(1\)\n- #121 for #12 Task 12: ci never reported on the merge commit 777777777777; check them yourself \(waiting 15 h\)/);
  assert.match(md, /Nothing here times out/);
  assert.match(md, /\*\*Decisions waiting for you\*\* \(1\)\n- #1 Task 1: @example-owner: Which rounding mode\? \(waiting 2 days\)/);
  assert.match(md, /\*\*PRs waiting for you to review and merge\*\* \(1\)\n- #31 for #3 Task 3: high-risk: migrations \(waiting 3 days\)/);
  assert.match(md, /\*\*PRs held back by a required check\*\* \(1\)\n- #51 for #5 Task 5: e2e missing \(waiting 10 h\)/);
  assert.match(md, /\*\*Deploys that failed\*\* \(1\)\n- ffffffffffff: staging: health check 503 \(waiting 6 h\)/, 'a plain SHA, which GitHub links');
  assert.match(md, /\*\*Emergency stop in force\*\* \(1\)\n- by @example-owner: spend \(waiting 3 days\)/);
  assert.equal(digestMarkdown(waitingOnYou(log(), NOW), { project: 'example-shop' }), md, 'pure: the same text each time');
  assert.equal(digestMarkdown(waitingOnYou([], NOW)), '## Waiting on you, 2026-10-15 (0)\n\n**Inbox: what waits on you** (0)\n- nothing in the event log waits on you\n\nNothing is waiting on you.\n\n**Merged since yesterday** (0)\n- nothing merged on its own\n');
});

test('merged since yesterday: each PR merged on its own since the last digest, with the merged head\'s review level and the evaluator\'s confidence', () => {
  const done = (issue: number, n: number, head: string, title: string, ts: string) => ev('merge.done', { issue, number: n, head, sha: sha('9'), url: `https://github.com/example-org/example-shop/pull/${n}`, title }, ts);
  const level = (issue: number, head: string, l: string, ts: string) => ev('review.level_set', { issue, head, level: l, reasons: [] }, ts);
  const verdict = (issue: number, head: string, confidence: string, ts: string) => ev('eval.verdict', { issue, head, patch_hash: 'p', patch_correct: true, test_correct: true, confidence, advice: '' }, ts);
  const events = [
    // Merged 30 hours ago: before yesterday's digest.
    level(1, sha('a'), 'L0', h(31)),
    verdict(1, sha('a'), 'high', h(31)),
    done(1, 11, sha('a'), 'Fix the footer link', h(30)),
    // Merged 5 hours ago: an earlier head was L1 with low confidence; the merged head is L0, high.
    level(2, sha('b'), 'L1', h(9)),
    verdict(2, sha('b'), 'low', h(9)),
    level(2, sha('c'), 'L0', h(7)),
    verdict(2, sha('c'), 'high', h(6)),
    done(2, 21, sha('c'), 'Round totals to the cent', h(5)),
    // Merged 2 hours ago, nothing recorded for its head: the issue's latest, else not recorded.
    level(3, sha('d'), 'L1', h(4)),
    done(3, 31, sha('e'), 'Document the rounding rule', h(2)),
    // A PR merged by a person, not on its own (no merge.done): not listed.
    ev('pr.closed', { issue: 4, number: 41, merged: true }, h(1)),
  ];
  const d = waitingOnYou(events, NOW);
  assert.equal(d.mergedSince, h(24), '24 hours back by default');
  assert.deepEqual(d.merged.map((m) => [m.pr, m.issue, m.title, m.level, m.confidence]), [
    [21, 2, 'Round totals to the cent', 'L0', 'high'],
    [31, 3, 'Document the rounding rule', 'L1', null],
  ]);
  assert.equal(d.merged[0]!.url, 'https://github.com/example-org/example-shop/pull/21');
  // Since the last digest, when the coordinator says when that was.
  assert.deepEqual(waitingOnYou(events, NOW, { since: new Date(h(3)) }).merged.map((m) => m.pr), [31]);
  assert.deepEqual(waitingOnYou(events, NOW, { since: new Date(h(48)) }).merged.map((m) => m.pr), [11, 21, 31]);
  const md = digestMarkdown(d);
  assert.match(md, /\*\*Merged since yesterday\*\* \(2\)\n- #21 for #2 Round totals to the cent: L0, evaluator confidence high\n- #31 for #3 Document the rounding rule: L1, evaluator confidence not recorded\n$/);
  assert.match(md, /^## Waiting on you, 2026-10-15 \(0\)\n\n\*\*Inbox: what waits on you\*\* \(0\)\n- nothing in the event log waits on you\n\nNothing is waiting on you\./, 'the count is still what waits');
});

test('a high-risk PR left to the owner carries why it waits, plainly (merge.decided why); older decisions without it still list', () => {
  const why = [{ category: 'self-modification', text: 'changes the merge policy: src/merge-policy.ts' }];
  const d = waitingOnYou([
    seen(3, 'Tighten the merge rule'),
    ev('pr.opened', { issue: 3, number: 31, url: 'u', head: sha('a'), draft: true }, h(10)),
    ev('merge.decided', { issue: 3, number: 31, head: sha('a'), auto: false, reasons: ['high-risk: self-modification (src/merge-policy.ts)'], why }, h(5)),
    seen(4, 'Old one'),
    ev('pr.opened', { issue: 4, number: 41, url: 'u', head: sha('b'), draft: true }, h(10)),
    ev('merge.decided', { issue: 4, number: 41, head: sha('b'), auto: false, reasons: ['big: 900 changed lines (over 800)'] }, h(5)),
  ], NOW, { updates: [] });
  const owner = d.items.filter((i) => i.kind === 'needs_owner');
  assert.deepEqual(owner.find((i) => i.pr === 31)?.why, why);
  assert.equal(owner.find((i) => i.pr === 41)?.why, undefined);
});
