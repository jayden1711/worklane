import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { lessonsMarkdown, pendingLessons, skillCandidates } from '../src/lessons.js';
import { buildReport, dueSlot } from '../src/reports.js';
import { repoRoot } from './helpers.js';

let id = 0;
const T0 = Date.parse('2026-10-01T06:00:00Z');
const ev = (hours: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: new Date(T0 + hours * 3_600_000).toISOString(), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });
const seen = (h: number, n: number, title: string) => ev(h, 'issue.seen', { issue: n, title, labels: [], author: 'a', owner: 'ada', actionable: true, why: '' });

test('report: landed, in review, decisions with owner and wait, blocked with reason, spend, scorecard deltas', () => {
  const cfg = loadConfig(join(repoRoot, 'examples', 'basic'));
  const events = [
    seen(0, 1, 'Fix totals'),
    ev(1, 'run.cost', { issue: 1, role: 'worker', model: 'm', usd: 1.5, turns: 3 }),
    ev(2, 'land.result', { issue: 1, outcome: 'landed', landed: 'a'.repeat(40), detail: '' }),
    ev(2, 'issue.released', { issue: 1, instance: 'i', why: 'landed' }),
    seen(0, 2, 'Ask about pricing'),
    ev(3, 'decision.asked', { id: 'd-2', kind: 'question', issue: 2, owner: 'ada', question: 'Round up or down?', options: ['up', 'down'], recommendation: 'down', receipts: [] }),
    seen(0, 3, 'Flaky import'),
    ev(4, 'issue.blocked', { issue: 3, owner: 'ada', why: 'needs a staging token\nmore detail' }),
    ev(4.5, 'decision.asked', { id: 'd-stage', kind: 'stage', issue: null, owner: 'ada', question: 'Promote to trust stage 2?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }),
  ];
  const now = new Date(T0 + 5 * 3_600_000);
  const prev = { tasksDone: 0, evaluatorPassRate: null, unverifiedClaimRate: null, reverts: 0, redCaught: 0, baselineGrowth: 0, costPerDoneUsd: null, readyToDoneHours: null, interventionsPerTask: null, idleHours: 1, decisionWaitHours: 0, blockedHours: 0, spendUsd: 0, from: '', to: '' };
  const { markdown, card } = buildReport(events, cfg, { since: new Date(T0), now, previous: prev, slot: '08:00' });
  assert.match(markdown, /\*\*Landed\*\* \(1\)\n- #1 Fix totals \(@ada\) `aaaaaaaa`/);
  assert.match(markdown, /- @ada: #2 Round up or down\? \(waiting 2\.0h; recommended: down\)/);
  assert.match(markdown, /- @ada: Promote to trust stage 2\?/, 'decisions not tied to an issue are listed too');
  assert.match(markdown, /- #3 Flaky import \(@ada\): needs a staging token$/m, 'first line of the reason only');
  assert.match(markdown, /\*\*Spend\*\*: \$1\.50 since the last report/);
  assert.match(markdown, /\| tasks done \(7d\) \| 1 \| \+1 \(better\) \|/);
  assert.match(markdown, /\| idle hours [^|]+\| 0 \| -1 \(better\) \|/);
  assert.equal(card.tasksDone, 1);
});

test('report slots: the latest configured time already passed today', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 8, h, m);
  assert.equal(dueSlot(['08:00', '18:00'], at(7, 59)), null);
  assert.equal(dueSlot(['08:00', '18:00'], at(8, 0)), '08:00');
  assert.equal(dueSlot(['18:00', '08:00'], at(23, 0)), '18:00');
});

test('lessons: only new, non-empty ones since the last lessons PR; recurring fixes become skill candidates', () => {
  const events = [
    seen(0, 1, 'One'),
    ev(1, 'lesson.proposed', { issue: 1, worked: 'ran the single test first', failed: '', fix: '' }),
    ev(2, 'lessons.pr', { day: 'd1', branch: 'b', count: 1, url: 'u' }),
    seen(2, 2, 'Two'),
    ev(3, 'lesson.proposed', { issue: 2, worked: '', failed: '', fix: '' }),
    ev(4, 'lesson.proposed', { issue: 3, worked: '', failed: 'timed out', fix: 'Run the single test first.' }),
    ev(5, 'lesson.proposed', { issue: 4, worked: 'Run the single test first!', failed: '', fix: '' }),
  ];
  const pending = pendingLessons(events);
  assert.deepEqual(pending.map((l) => l.issue), [3, 4], 'issue 1 already went out; issue 2 is empty');
  const cands = skillCandidates(events, 2);
  assert.equal(cands.length, 1);
  assert.equal(cands[0]!.count, 2, 'same advice, different punctuation, counted once per task');
  const md = lessonsMarkdown('2026-10-08', pending, cands);
  assert.match(md, /## #3\n\n- \*\*Failed:\*\* timed out\n- \*\*Fix:\*\* Run the single test first\./);
  assert.match(md, /## Skill candidates/);
});
