// An owner-held issue closed by hand on GitHub (no event of the loop's own) drops out of "Waiting on you", the
// projection's blocked list and the board: the coordinator records the close when its reconcile step sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { waitingOnYou } from '../src/digest.js';
import { project } from '../src/projection.js';
import type { StoredEvent } from '../src/events/types.js';
import type { Backlog } from '../src/backlog/types.js';
import { ClosedIssueWatch } from '../src/coordinator/closed-issues.js';
import { coordinator, easyIssue, fixture, readAll, skip } from './repro-state-graph/harness.js';

/** Every worker run ends blocked on the owner (an auth mismatch never retries on its own). */
const blocksOnOwner = () =>
  new FakeRunner((req: RunRequest) =>
    req.role === 'worker' ? { reason: 'auth_mismatch' as never, detail: 'wrong login' } : { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } },
  );

test('regression: a blocked issue the owner then closes on GitHub is no longer waiting on them', { skip }, async () => {
  const f = fixture();
  const n = f.backlog.open(easyIssue('Add a.js', 'a.js'));
  const c = coordinator(f, blocksOnOwner());
  await c.tick();
  await c.idle();
  assert.ok(waitingOnYou(f.log.read()).items.some((i) => i.kind === 'blocked' && i.issue === n), 'blocked first');

  await f.backlog.close(n); // by hand, outside the loop
  await c.tick();
  await c.idle();

  const events = f.log.read();
  assert.deepEqual(waitingOnYou(events).items.filter((i) => i.issue === n), []);
  assert.equal(events.filter((e) => e.type === ('issue.closed' as never)).length, 1, 'the close is recorded once');
  const t = project(events).tasks.find((x) => x.issue === n)!;
  assert.notEqual(t.status, 'blocked');
  assert.equal(t.status, 'done');

  // Later ticks don't record it again.
  await c.tick();
  await c.idle();
  assert.equal(f.log.read().filter((e) => e.type === ('issue.closed' as never)).length, 1);
});

test('a held issue recorded as closed is never listed as waiting, whatever held it', () => {
  let id = 0;
  const ts = (h: number) => new Date(Date.UTC(2026, 9, 10, h)).toISOString();
  const ev = (type: string, payload: object, h: number) => ({ id: ++id, ts: ts(h), type, payload, instance: 'i', source: 'coordinator' }) as unknown as StoredEvent;
  const events = [
    ev('issue.seen', { issue: 11, title: 'Eleven', labels: ['ready'], author: 'o', owner: 'o', actionable: true, why: '' }, 1),
    ev('issue.blocked', { issue: 11, owner: 'o', why: 'needs a key' }, 2),
    ev('decision.asked', { id: 'd1', kind: 'question', issue: 11, owner: 'o', question: 'Which?', options: [], recommendation: '', receipts: [] }, 3),
    ev('hotspot.held', { issue: 11, by: 12, files: ['a.ts'] }, 4),
    ev('plan.posted', { issue: 11, plan: {}, held: true, reasons: [], comments_at: 0, decision: 'd2' }, 5),
    ev('issue.closed', { issue: 11 }, 6),
  ];
  const now = new Date(Date.UTC(2026, 9, 13));
  assert.deepEqual(waitingOnYou(events, now).items, []);
  // Reopened and claimed again: it can wait on the owner once more.
  events.push(ev('issue.claimed', { issue: 11, instance: 'i', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'o' }, 7), ev('issue.blocked', { issue: 11, owner: 'o', why: 'again' }, 8));
  assert.deepEqual(waitingOnYou(events, now).items.map((i) => [i.kind, i.issue]), [['blocked', 11]]);
});

test('the closed-issue watch: one listing per tick for every held issue, none when nothing is held', async () => {
  let id = 0;
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h)).toISOString();
  const ev = (type: string, payload: object, h: number) => ({ id: ++id, ts: at(h), type, payload, instance: 'i', source: 'coordinator' }) as unknown as StoredEvent;
  const calls: string[] = [];
  let closedOnGitHub: number[] = [];
  const backlog = { closedSince: async (since: string) => (calls.push(since), closedOnGitHub) } as unknown as Backlog;
  const w = new ClosedIssueWatch();
  const now = (h: number) => new Date(Date.UTC(2026, 9, 10, h));

  assert.deepEqual(await w.check([], backlog, now(1)), []);
  assert.equal(calls.length, 0, 'nothing held: no call');

  const events = [ev('issue.blocked', { issue: 3, owner: 'o', why: 'x' }, 2), ev('issue.blocked', { issue: 4, owner: 'o', why: 'y' }, 3), ev('issue.blocked', { issue: 5, owner: 'o', why: 'z' }, 4)];
  closedOnGitHub = [4, 9];
  assert.deepEqual(await w.check(events, backlog, now(6)), [4], 'only held issues that are closed');
  assert.equal(calls.length, 1, 'one listing for three held issues');
  assert.ok(Date.parse(calls[0]!) <= Date.parse(at(2)), 'it reaches back to the oldest hold');

  closedOnGitHub = [];
  await w.check(events, backlog, now(7));
  assert.equal(calls.length, 2);
  assert.ok(Date.parse(calls[1]!) > Date.parse(at(5)), 'later listings start near the last one, not at the oldest hold');
});
