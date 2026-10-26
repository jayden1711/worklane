// #1032: the operator inbox, one table of what waits on the operator, the first section of every digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
import type { StoredEvent } from '../src/events/types.js';
import { digestMarkdown, waitingOnYou } from '../src/digest.js';
import { buildInbox, inboxFold, inboxMarkdown, inboxStep, PR_SOURCE, WAITS_SOURCE } from '../src/inbox.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const h = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
let id = 0;
const ev = (type: string, payload: object, ts: string): StoredEvent => ({ id: ++id, ts, type, payload, instance: 'i', source: 'coordinator' }) as unknown as StoredEvent;
const sha = (c: string) => c.repeat(40);
const seen = (issue: number, labels: string[] = ['ready']) => ev('issue.seen', { issue, title: `Task ${issue}`, labels, author: 'o', owner: 'o', actionable: true, why: '' }, h(200));
const opened = (issue: number, n: number, head: string, draft: boolean, ts: string) => ev('pr.opened', { issue, number: n, url: 'u', head, draft }, ts);
const status = (issue: number, n: number, head: string, ready: boolean, checks: [string, string][], ts: string, reasons: string[] = []) =>
  ev('pr.status', { issue, number: n, head, ready, reasons, checks: checks.map(([name, outcome]) => ({ name, outcome })) }, ts);
const NONE = { updates: [] };

test('the operator\'s rows: an L3 head, the merge policy\'s verdict, red checks, stale drafts with why, decisions, blocks, stops', () => {
  const events = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => seen(n)),
    seen(10, ['ready', 'review:L3']),
    // L3 and left to the owner, ready and green: one row, with the merge command pinned to its head.
    opened(10, 100, sha('a'), true, h(30)),
    ev('review.level_set', { issue: 10, head: sha('a'), level: 'L3', reasons: ['touches the merge policy'] }, h(29)),
    status(10, 100, sha('a'), true, [['test', 'pass']], h(20)),
    ev('pr.ready', { issue: 10, number: 100, head: sha('a') }, h(20)),
    ev('merge.decided', { issue: 10, number: 100, head: sha('a'), auto: false, reasons: ['high-risk: self-modification'] }, h(19)),
    // Ready with red checks: listed, no merge command.
    opened(1, 11, sha('b'), false, h(10)),
    status(1, 11, sha('b'), false, [['test', 'fail'], ['e2e', 'cancelled'], ['lint', 'pass']], h(9)),
    // Drafts: open 5 h with its status's reasons; turned back into a draft with why; one with no status; one fresh.
    opened(2, 21, sha('c'), true, h(5)),
    status(2, 21, sha('c'), false, [['test', 'pass']], h(4), ['done_when never run']),
    opened(3, 31, sha('d'), false, h(8)),
    ev('pr.unready', { issue: 3, number: 31, head: sha('d'), why: 'the review asked for changes' }, h(6)),
    opened(4, 41, sha('e'), true, h(3)),
    opened(5, 51, sha('f'), true, h(1)),
    // Open, ready, green, merging on its own: not the operator's. A merged and a closed PR: gone.
    opened(6, 61, sha('1'), false, h(10)),
    status(6, 61, sha('1'), true, [['test', 'pass']], h(9)),
    opened(7, 71, sha('2'), true, h(50)),
    ev('merge.done', { issue: 7, number: 71, head: sha('2'), sha: sha('3'), url: 'u', title: 'Task 7' }, h(40)),
    opened(8, 81, sha('4'), true, h(50)),
    ev('pr.closed', { issue: 8, number: 81, merged: false }, h(40)),
    // A decision, a block, an emergency stop.
    ev('decision.asked', { id: 'd1', kind: 'question', issue: 9, owner: 'example-owner', question: 'Which rounding mode?', options: [], recommendation: '', receipts: [] }, h(12)),
    ev('issue.blocked', { issue: 6, owner: 'example-owner', why: 'needs the provider key' }, h(11)),
    ev('emergency.stop', { by: 'example-owner', reason: 'spend', running: 0 }, h(2)),
  ];
  const d = waitingOnYou(events, NOW, NONE);
  const rows = d.inbox.rows.map((r) => [r.pr, r.issue, r.classes.join('+'), r.command]);
  assert.deepEqual(rows, [
    [null, null, 'stopped', null],
    [null, 9, 'decision', `${BRAND.cli} decide d1 <option>`],
    [100, 10, 'level_l3+left_to_you', `gh pr merge 100 --merge --match-head-commit ${sha('a')}`],
    [11, 1, 'red_checks', null],
    [31, 3, 'stale_draft', null],
    [21, 2, 'stale_draft', null],
    [41, 4, 'stale_draft', null],
    [null, 6, 'blocked', null],
  ]);
  const why = (n: number) => d.inbox.rows.find((r) => r.pr === n)!.why;
  assert.deepEqual(why(100), ['review level L3: you approve it before it lands', 'PRs waiting for you to review and merge: high-risk: self-modification']);
  assert.deepEqual(why(11), ['red checks: test fail, e2e cancelled']);
  assert.deepEqual(why(21), ['a draft for 5 h: done_when never run']);
  assert.deepEqual(why(31), ['a draft for 6 h: the review asked for changes']);
  assert.deepEqual(why(41), ['a draft for 3 h: no status recorded']);
  assert.deepEqual(d.inbox.rows.find((r) => r.pr === 100)!.labels, ['ready', 'review:L3'], 'the issue\'s labels as last seen');
  assert.deepEqual(d.inbox.unreadable, []);
});

test('a task that waits only on another folds into one line, followed down to its root, with the root\'s reason', () => {
  const events = [
    ...[1, 2, 3, 4, 5, 6].map((n) => seen(n)),
    // #4 depends on #3, which waits behind #2's files; #2's PR is left to the owner.
    opened(2, 20, sha('a'), false, h(10)),
    ev('merge.decided', { issue: 2, number: 20, head: sha('a'), auto: false, reasons: ['big: 900 changed lines'] }, h(9)),
    ev('hotspot.held', { issue: 3, by: 2, files: ['src/a.ts'], reason: 'r' }, h(8)),
    ev('dependency.held', { issue: 4, on: [3], reason: 'Depends on #3' }, h(7)),
    // #5 and #6 hold each other: a cycle, said so, never followed for ever.
    ev('hotspot.held', { issue: 5, by: 6, files: ['src/b.ts'], reason: 'r' }, h(6)),
    ev('dependency.held', { issue: 6, on: [5], reason: 'Depends on #5' }, h(5)),
  ];
  const d = waitingOnYou(events, NOW, NONE);
  assert.deepEqual(d.inbox.rows.map((r) => r.pr), [20], 'the held tasks are no rows of their own');
  assert.deepEqual(d.inbox.folded, [
    { issue: 3, chain: [3, 2], root: 'root #2: PRs waiting for you to review and merge: big: 900 changed lines' },
    { issue: 4, chain: [4, 3, 2], root: 'root #2: PRs waiting for you to review and merge: big: 900 changed lines' },
    { issue: 5, chain: [5, 6, 5], root: 'a cycle at #5' },
    { issue: 6, chain: [6, 5, 6], root: 'a cycle at #6' },
  ]);
  const md = inboxMarkdown(d.inbox).join('\n');
  assert.match(md, /\n- Waiting only on another task \(4\): #3 -> #2: root #2: PRs waiting for you to review and merge: big: 900 changed lines; #4 -> #3 -> #2: root #2: [^;]+; #5 -> #6 -> #5: a cycle at #5; #6 -> #5 -> #6: a cycle at #6$/);
  // Once the root merges and the holds end, nothing folds.
  const after = waitingOnYou([...events, ev('pr.closed', { issue: 2, number: 20, merged: true }, h(1)), ev('hotspot.released', { issue: 3, waited_ms: 1, files: ['src/a.ts'], started: true }, h(1)), ev('dependency.unblocked', { issue: 4, on: [3], why: 'closed' }, h(1))], NOW, NONE);
  assert.deepEqual(after.inbox.folded.map((x) => x.issue), [5, 6]);
});

test('the digest starts with the inbox: a table, one row per PR or hold, with its merge command', () => {
  const events = [
    seen(10, ['ready', 'review:L3']),
    opened(10, 100, sha('a'), false, h(30)),
    status(10, 100, sha('a'), true, [['test', 'pass']], h(20)),
    ev('merge.decided', { issue: 10, number: 100, head: sha('a'), auto: false, reasons: ['a | pipe'] }, h(19)),
  ];
  const md = digestMarkdown(waitingOnYou(events, NOW, NONE), { project: 'example-shop' });
  assert.equal(md.split('\n').slice(0, 8).join('\n'), [
    '## Waiting on you: example-shop, 2026-10-15 (1)',
    '',
    '**Inbox: what waits on you** (1)',
    '',
    "| PR | why it's yours | labels | merge command |",
    '|---|---|---|---|',
    `| #100 for #10 | PRs waiting for you to review and merge: a \\| pipe | ready, review:L3 | \`gh pr merge 100 --merge --match-head-commit ${sha('a')}\` |`,
    '',
  ].join('\n'));
  assert.match(md, /\n\nNothing here times out/, 'the holds by kind follow');
});

test('empty, read: says nothing waits; a source that can\'t be read says UNREADABLE, never empty', () => {
  const empty = waitingOnYou([], NOW, NONE);
  assert.deepEqual(inboxMarkdown(empty.inbox), ['**Inbox: what waits on you** (0)', '- nothing in the event log waits on you']);

  for (const src of [
    { prs: { ok: false as const, why: 'the event log: disk I/O error' }, waits: { ok: true as const, value: [] } },
    { prs: { ok: true as const, value: inboxFold() }, waits: { ok: false as const, why: 'the update log: EACCES' } },
  ]) {
    const md = inboxMarkdown(buildInbox(src, NOW));
    assert.equal(md[0], '**Inbox: what waits on you** (UNREADABLE)');
    assert.match(md[1]!, /^- \*\*UNREADABLE\*\*: (open PRs|holds) \(event log\): the (event|update) log: /);
    assert.ok(!md.some((l) => /nothing .*waits on you/.test(l)), 'never says nothing waits');
  }

  // An event the fold can't read: the PRs after it aren't known to be whole, so the source is UNREADABLE.
  const f = inboxFold();
  inboxStep(f, ev('pr.status', { issue: 1, number: 11, head: sha('a'), ready: false, reasons: [] }, h(2)));
  inboxStep(f, ev('pr.opened', { issue: 2, number: 21, url: 'u', head: sha('b'), draft: true }, h(1)));
  const i = buildInbox({ prs: { ok: true, value: f }, waits: { ok: true, value: [] } }, NOW);
  assert.deepEqual(i.unreadable.map((u) => u.source), [PR_SOURCE]);
  assert.match(i.unreadable[0]!.why, /^the pr\.status event at 2026-10-15T10:00:00\.000Z: /);
  assert.equal(inboxMarkdown(i)[0], '**Inbox: what waits on you** (UNREADABLE)');
  assert.equal(WAITS_SOURCE, 'holds (event log)');
});

test('pure: the same input gives the same table, and the fold is left as it was', () => {
  const f = inboxFold();
  for (const e of [seen(1), opened(1, 11, sha('a'), true, h(5)), status(1, 11, sha('a'), false, [['t', 'fail']], h(4))]) inboxStep(f, e);
  const before = JSON.stringify([...f.prs.entries()]);
  const a = buildInbox({ prs: { ok: true, value: f }, waits: { ok: true, value: [] } }, NOW);
  const b = buildInbox({ prs: { ok: true, value: f }, waits: { ok: true, value: [] } }, NOW);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify([...f.prs.entries()]), before);
});
