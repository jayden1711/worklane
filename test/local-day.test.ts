// "Today" on the dashboard is this machine's local day, not UTC's (src/local-day.ts): runs today (src/usage-limit.ts
// usageView), spend today and landed today (src/projection.ts). In a US evening the UTC day has already turned over.
// A fixed time zone and a mocked clock: each test file runs in its own process, so this one's TZ stays its own.
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay } from '../src/local-day.js';
import { project } from '../src/projection.js';
import { usageView } from '../src/usage-limit.js';
import type { StoredEvent } from '../src/events/types.js';

let id = 0;
const ev = (ts: string, type: string, payload: Record<string, unknown>) => ({ id: ++id, ts, type, actor: 'c@local', source: 'coordinator', payload }) as unknown as StoredEvent;
const day = (ts: string, issue: number) => [
  ev(ts, 'run.started', { issue, role: 'worker', model: 'm', pid: 1, attempt: 1 }),
  ev(ts, 'run.cost', { issue, role: 'worker', model: 'm', usd: 1, turns: 1 }),
  ev(ts, 'land.result', { issue, outcome: 'landed', landed: String(issue).repeat(40).slice(0, 40), detail: '' }),
];

test('the local day of a UTC timestamp, in this machine\'s time zone', () => {
  assert.equal(localDay('2026-10-15T02:00:00.000Z'), '2026-10-14', 'a US evening: still the 14th here, the 15th in UTC');
  assert.equal(localDay(Date.parse('2026-10-14T08:00:00.000Z')), '2026-10-14');
  assert.equal(localDay(new Date('2026-10-14T06:59:00.000Z')), '2026-10-13');
});

test('in a US evening, runs, spend and landed "today" count the local day (the UTC day has already turned over)', (t) => {
  // 21:00 on the 14th in Los Angeles is 04:00 on the 15th in UTC.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T04:00:00.000Z') });
  const events = [...day('2026-10-14T20:00:00.000Z', 1), ...day('2026-10-15T02:00:00.000Z', 2)];
  assert.equal(usageView(events).today.runs, 2, 'both runs were today here (13:00 and 19:00)');
  const p = project(events);
  assert.equal(p.spendToday, 2);
  assert.equal(p.landedToday, 2);
});

test('in a US morning, last evening is yesterday even though UTC calls it today', (t) => {
  // 11:00 on the 14th in Los Angeles is 18:00 on the 14th in UTC; 03:00 UTC on the 14th was 20:00 on the 13th here.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T18:00:00.000Z') });
  const events = [...day('2026-10-14T03:00:00.000Z', 1), ...day('2026-10-14T08:00:00.000Z', 2)];
  assert.equal(usageView(events).today.runs, 1, 'only the 01:00 run is today here');
  const p = project(events);
  assert.equal(p.spendToday, 1);
  assert.equal(p.landedToday, 1);
});
