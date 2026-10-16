// The daily budget is enforced on this machine's local day (src/local-day.ts), the same day the dashboard's "spend
// today" shows, not the UTC day. Tokyo is east of UTC, so just after local midnight the UTC date is still yesterday's:
// last evening's spend must not hold today's work, and the hold lasts until the next LOCAL midnight.
process.env.TZ = 'Asia/Tokyo';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { FakeRunner } from '../src/runner.js';
import { repoRoot } from './helpers.js';

function coordinator() {
  const base = mkdtempSync(join(tmpdir(), 'budget-day-'));
  const repo = join(base, 'repo');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  const cfg = loadConfig(repo);
  cfg.agents.daily_budget_usd = 1;
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const log = new EventLog(join(base, 'events.db'));
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), runner: new FakeRunner(() => ({})), repo, instance: 'alice', stateDir: join(base, 'state'), slotsDir, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
  return { c, log };
}

test('budget-local-day: just after local midnight (UTC still yesterday), last evening spend no longer counts and the hold ends at local midnight', (t) => {
  const { c, log } = coordinator();
  // 23:00 on Oct 14 in Tokyo (14:00 UTC, Oct 14): $1, the whole budget, spent last evening.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T14:00:00.000Z') });
  log.append('run.cost', { issue: null, role: 'x', model: 'm', usd: 1, turns: 1 }, 'alice');
  assert.equal(c.governorHold()?.kind, 'budget', 'held on Oct 14 (local)');
  assert.equal(c.governorHold()?.facts?.until, '2026-10-14T15:00:00.000Z', 'until local midnight (00:00 Oct 15 Tokyo), not UTC midnight');

  // 00:30 on Oct 15 in Tokyo is 15:30 UTC, still Oct 14 in UTC: a new local day, so nothing is spent today.
  t.mock.timers.setTime(Date.parse('2026-10-14T15:30:00.000Z'));
  assert.equal(c.spentToday(), 0, "last evening's spend is yesterday's here, though UTC calls it today");
  assert.equal(c.governorHold(), null, 'no budget hold on the new local day');

  // Spend after local midnight counts toward today.
  log.append('run.cost', { issue: null, role: 'x', model: 'm', usd: 0.25, turns: 1 }, 'alice');
  assert.equal(c.spentToday(), 0.25);
  log.close();
});
