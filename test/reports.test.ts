import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { appKeyAge, appKeyWarning, buildReport, dueSlot, recentRunRecords, weeklyDue } from '../src/reports.js';
import { RUNS_DIR } from '../src/run-record.js';
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
  assert.match(markdown, /\*\*Spend\*\* \(the CLI's cost estimate, not billed money\): ~\$1\.50 since the last report/);
});

test('report slots: the latest configured time already passed today', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 8, h, m);
  assert.equal(dueSlot(['08:00', '18:00'], at(7, 59)), null);
  assert.equal(dueSlot(['08:00', '18:00'], at(8, 0)), '08:00');
  assert.equal(dueSlot(['18:00', '08:00'], at(23, 0)), '18:00');
});


test('an App key is watched by its age, not an expiry: reports ask for rotation after 90 days', () => {
  const key = join(mkdtempSync(join(tmpdir(), 'key-')), 'private-key.pem');
  writeFileSync(key, 'pem');
  const now = new Date('2026-10-09T12:00:00Z');
  const at = (days: number) => utimesSync(key, new Date(now.getTime() - days * 86_400_000), new Date(now.getTime() - days * 86_400_000));
  at(30);
  assert.equal(appKeyAge(key, now), 30);
  assert.equal(appKeyWarning(30), null);
  assert.equal(appKeyAge(join(tmpdir(), 'no-such-key.pem'), now), null);
  const cfg = loadConfig(join(repoRoot, 'examples', 'basic'));
  assert.doesNotMatch(buildReport([], cfg, { since: new Date(now.getTime() - 86_400_000), now, appKeyPath: key }).markdown, /App key/);
  at(120);
  assert.match(appKeyWarning(appKeyAge(key, now))!, /^\*\*GitHub App key installed 120 days ago\.\*\* Rotate it/);
  const { markdown } = buildReport([], cfg, { since: new Date(now.getTime() - 86_400_000), now, appKeyPath: key });
  assert.match(markdown, /GitHub App key installed 120 days ago/);
  assert.doesNotMatch(markdown, /no expiry/, 'an App never gets the token-expiry warning');
});

test('the weekly failure-mode section: first report on Mondays and every preview, with proposals for repeated causes', () => {
  const cfg = loadConfig(join(repoRoot, 'examples', 'basic'));
  const times = [...cfg.project.reports.times].sort();
  const first = times[0]!;
  const monday = new Date(2026, 9, 5, 9, 0);
  const tuesday = new Date(2026, 9, 6, 9, 0);
  assert.equal(weeklyDue(times, first, monday), true);
  assert.equal(weeklyDue(times, first, tuesday), false);
  if (times.length > 1) assert.equal(weeklyDue(times, times.at(-1), monday), false);
  assert.equal(weeklyDue(times, undefined, tuesday), true, 'the preview always has it');
  // Three quick failed worker runs with nothing committed, then the issue blocked.
  const base = monday.getTime() - 3_600_000;
  const at = (s: number) => new Date(base + s * 1000).toISOString();
  const e = (s: number, type: string, payload: object): StoredEvent => ({ id: ++id, ts: at(s), type: type as never, actor: 'c', source: 'coordinator', payload: payload as never });
  const events: StoredEvent[] = [];
  for (const [i, s] of [0, 9, 18].entries()) {
    events.push(e(s, 'run.started', { issue: 4, role: 'worker', model: 'm', worktree: 'w', pid: 1, pgid: 1, attempt: i + 1 }));
    events.push(e(s + 8, 'run.finished', { issue: 4, role: 'worker', reason: 'failed', detail: 'error_during_execution: ' }));
    events.push(e(s + 8.1, 'change.rejected', { issue: 4, why: 'no changes committed' }));
  }
  events.push(e(27, 'issue.blocked', { issue: 4, owner: 'ada', why: 'no passing change after 3 attempts' }));
  const since = new Date(base - 3_600_000);
  const weekly = buildReport(events, cfg, { since, now: monday, slot: first });
  assert.match(weekly.markdown, /\*\*How runs ended, last 7 days\*\* \(3 run\(s\)\)/);
  assert.match(weekly.markdown, /startup failure, 3×/);
  assert.equal(weekly.proposals.length, 1);
  const daily = buildReport(events, cfg, { since, now: tuesday, slot: first });
  assert.doesNotMatch(daily.markdown, /How runs ended/);
  assert.deepEqual(daily.proposals, []);
});

test("recentRunRecords reads an instance's run records ended since a time, and nothing from a missing dir", () => {
  const state = mkdtempSync(join(tmpdir(), 'runs-state-'));
  assert.deepEqual(recentRunRecords(state, new Date(0)), []);
  mkdirSync(join(state, RUNS_DIR));
  const rec = (runId: string, ended: string) =>
    writeFileSync(join(state, RUNS_DIR, `${runId}.json`), JSON.stringify({ v: 1, id: runId, issue: 1, role: 'worker', model: 'm', startedAt: ended, endedAt: ended, reason: 'failed', costUsd: 0, turns: 0, steps: [], files: [], otherTools: 0, final: '', truncated: false }));
  rec('old', '2026-09-01T00:00:00.000Z');
  rec('new', '2026-10-04T00:00:00.000Z');
  writeFileSync(join(state, RUNS_DIR, 'broken.json'), '{');
  assert.deepEqual(recentRunRecords(state, new Date('2026-10-01T00:00:00Z')).map((r) => r.id), ['new']);
});
