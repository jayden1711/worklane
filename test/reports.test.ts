import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { buildReport, dueSlot } from '../src/reports.js';
import { repoRoot } from './helpers.js';

let id = 0;
const T0 = Date.parse('2026-10-01T06:00:00Z');
const ev = (hours: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: new Date(T0 + hours * 3_600_000).toISOString(), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });
const seen = (h: number, n: number, title: string) => ev(h, 'issue.seen', { issue: n, title, labels: [], author: 'a', owner: 'ada', actionable: true, why: '' });

test('report: landed, in review, decisions with owner and wait, blocked with reason, spend', () => {
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
    ev(4.5, 'decision.asked', { id: 'd-stage', kind: 'question', issue: null, owner: 'ada', question: 'Ship the beta?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }),
  ];
  const now = new Date(T0 + 5 * 3_600_000);
  const { markdown } = buildReport(events, cfg, { since: new Date(T0), now, slot: '08:00' });
  assert.match(markdown, /\*\*Landed\*\* \(1\)\n- #1 Fix totals \(@ada\) `aaaaaaaa`/);
  assert.match(markdown, /- @ada: #2 Round up or down\? \(waiting 2\.0h; recommended: down\)/);
  assert.match(markdown, /- @ada: Ship the beta\?/, 'decisions not tied to an issue are listed too');
  assert.match(markdown, /- #3 Flaky import \(@ada\): needs a staging token$/m, 'first line of the reason only');
  assert.match(markdown, /\*\*Spend\*\*: \$1\.50 since the last report/);
});

test('report slots: the latest configured time already passed today', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 8, h, m);
  assert.equal(dueSlot(['08:00', '18:00'], at(7, 59)), null);
  assert.equal(dueSlot(['08:00', '18:00'], at(8, 0)), '08:00');
  assert.equal(dueSlot(['18:00', '08:00'], at(23, 0)), '18:00');
});

