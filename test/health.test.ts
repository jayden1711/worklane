import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { healthStats, startDashboard } from '../src/dashboard.js';
import { startHub } from '../src/dashboard-hub.js';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { checkTimings, healthView, QUOTA_NOTE, REGRESSION, suggestions, usageByDay, type MachineStats } from '../src/health.js';
import { exampleProject } from './helpers.js';

let id = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown>): StoredEvent => ({ id: ++id, ts, type, actor: 'c', source: 'harness', payload }) as unknown as StoredEvent;
const day = (d: number, h = 0) => new Date(Date.UTC(2026, 0, d, h)).toISOString();
/** A check.result as the coordinator records it: duration_ms on each check that ran, none on one that didn't. */
const result = (ts: string, checks: [name: string, ms: number | null, status?: string][]) =>
  ev('check.result', ts, { issue: 1, head: 'a'.repeat(40), stage: 'verify', checks: checks.map(([check, ms, status = 'pass']) => ({ check, status, exitCode: ms === null ? null : 0, ...(ms === null ? {} : { duration_ms: ms }) })) });

test('check times: the slowest first, and a check that got slower is flagged by the rule', () => {
  const events: StoredEvent[] = [];
  for (let i = 0; i < 20; i++) events.push(result(day(1, i), [['full suite', 60_000], ['lint', 1_000], ['unit', 10_000]]));
  for (let i = 0; i < 5; i++) events.push(result(day(2, i), [['full suite', 90_000], ['lint', 1_600], ['unit', 10_500]]));
  // A check with too little history isn't judged; one that didn't run has no duration and isn't timed.
  for (let i = 0; i < 6; i++) events.push(result(day(3, i), [['new check', 5_000 + i * 10_000], ['unit', null, 'skipped']]));
  const t = checkTimings(events);
  const by = Object.fromEntries(t.timings.map((x) => [x.check, x]));
  assert.deepEqual(t.regressions, ['full suite'], '+50% and 30 s slower; lint is +60% but under the 2 s floor; new check has no history');
  assert.deepEqual(by['full suite']!.regression, { slowerPct: 50 });
  assert.equal(by['full suite']!.recentMedianMs, 90_000);
  assert.equal(by['full suite']!.priorMedianMs, 60_000);
  assert.equal(by.lint!.regression, null);
  assert.equal(by['new check']!.priorMedianMs, null, `fewer than ${REGRESSION.minPrior} runs before the last ${REGRESSION.recent}`);
  assert.equal(by.unit!.runs, 25, 'runs without a duration are not times');
  assert.deepEqual(t.slowest, ['full suite', 'new check', 'unit']);
  assert.equal(by['full suite']!.series.length, 25);
  assert.match(t.rule, /last 5 runs is more than 25%/);
});

test('usage per day: runs, estimated cost, rate limits, login trouble, retries by cause and lock waits', () => {
  const events = [
    ev('run.started', day(5, 1), { issue: 1, role: 'worker' }),
    ev('run.cost', day(5, 1), { issue: 1, role: 'worker', model: 'm', usd: 0.5, turns: 4 }),
    ev('run.started', day(5, 2), { issue: 2, role: 'worker' }),
    ev('run.finished', day(5, 2), { issue: 2, role: 'worker', reason: 'rate_limited', detail: '' }),
    ev('run.transient_retry', day(5, 3), { issue: 2, role: 'worker', model: 'm', attempt: 1, cause: 'token_refresh', wait_ms: 5_000, detail: '401' }),
    ev('run.transient_retry', day(5, 3), { issue: 2, role: 'worker', model: 'm', attempt: 2, cause: 'overloaded', wait_ms: 20_000, detail: '529' }),
    ev('run.lock_waited', day(5, 3), { issue: 2, role: 'worker', model: 'm', wait_ms: 120_000 }),
    ev('run.started', day(6, 1), { issue: 3, role: 'evaluator' }),
    ev('run.cost', day(6, 1), { issue: 3, role: 'evaluator', model: 'm', usd: 0.25, turns: 2 }),
    ev('run.finished', day(6, 1), { issue: 3, role: 'evaluator', reason: 'auth_mismatch', detail: '' }),
  ];
  const u = usageByDay(events);
  assert.deepEqual(u.map((d) => d.day), ['2026-01-06', '2026-01-05'], 'newest first');
  assert.deepEqual(u[1], { day: '2026-01-05', runs: 2, estimatedUsd: 0.5, turns: 4, rateLimited: 1, authProblems: 1, retries: { token_refresh: 1, overloaded: 1 }, retryWaitMs: 25_000, lockWaits: 1, lockWaitMs: 120_000 });
  assert.equal(u[0]!.authProblems, 1, 'a login mismatch');
  assert.equal(u[0]!.estimatedUsd, 0.25);
});

const svc = `${BRAND.cli}-shop.service`;
const calm: MachineStats = {
  at: '',
  platform: 'linux',
  memory: { totalBytes: 32e9, availableBytes: 20e9, swapTotalBytes: 8e9, swapFreeBytes: 8e9 },
  load: [2, 2, 2],
  units: [
    { unit: `${BRAND.cli}.slice`, memoryCurrent: 4e9, memoryMax: null, memorySwapCurrent: 0, cpuUsageNSec: 1e12, activeState: 'active' },
    { unit: svc, memoryCurrent: 2e9, memoryMax: 10e9, memorySwapCurrent: 0, cpuUsageNSec: 1e11, activeState: 'active' },
  ],
  disks: [{ path: '/srv', freeBytes: 200e9, totalBytes: 500e9 }],
  unavailable: [],
};
const NOTHING = ['Nothing to suggest: memory, disk, load, usage and check times are within the usual limits.'];

test('suggestions are conservative, always phrased as suggestions, and say so when there is nothing', () => {
  const quiet = healthView([], calm, { cores: 8, today: '2026-01-05' });
  assert.deepEqual(quiet.suggestions, NOTHING);
  assert.equal(quiet.usage.quotaNote, QUOTA_NOTE);
  assert.match(QUOTA_NOTE, /isn't visible/);
  const strained: MachineStats = {
    ...calm,
    memory: { totalBytes: 32e9, availableBytes: 2e9, swapTotalBytes: 8e9, swapFreeBytes: 4e9 },
    load: [9, 9, 9],
    units: [calm.units![0]!, { unit: svc, memoryCurrent: 9.5e9, memoryMax: 10e9, memorySwapCurrent: 1e9, cpuUsageNSec: 1, activeState: 'active' }, { unit: 'gone.service', error: 'not loaded' }],
    disks: [{ path: '/state', freeBytes: 6e9, totalBytes: 100e9 }, { path: '/missing', error: 'ENOENT' }],
  };
  const events = [...Array.from({ length: 3 }, () => ev('run.finished', day(5, 1), { issue: 1, role: 'worker', reason: 'rate_limited', detail: '' })), ev('run.lock_waited', day(5, 2), { issue: 1, role: 'worker', model: 'm', wait_ms: 40 * 60_000 })];
  for (let i = 0; i < 20; i++) events.push(result(day(1, i), [['full suite', 60_000]]));
  for (let i = 0; i < 5; i++) events.push(result(day(2, i), [['full suite', 90_000]]));
  const s = healthView(events, strained, { cores: 4, today: '2026-01-05', diskLabels: { '/state': 'the state dir' } }).suggestions;
  assert.equal(s.length, 8, s.join('\n'));
  for (const line of s) assert.match(line, /^Consider /, 'a suggestion, never an instruction');
  for (const re of [/of memory \(2\.0 GB\) is available/, /50% of swap is in use/, new RegExp(`${svc}'s memory limit`), /5-minute load \(9\.0\) is over 1\.5× the 4 cores/, /space on the state dir/, /3 runs hit the usage limit today/, /waited 40 min today/, /"full suite" got slower/]) assert.ok(s.some((l) => re.test(l)), String(re));
  // Just under every threshold: nothing. Unknown figures (null load, no cores, units that couldn't be read) suggest nothing.
  const edge: MachineStats = { ...calm, memory: { totalBytes: 100, availableBytes: 10, swapTotalBytes: 100, swapFreeBytes: 75 }, load: [6, 6, 6], units: [{ unit: svc, memoryCurrent: 89, memoryMax: 100, memorySwapCurrent: 0, cpuUsageNSec: 0, activeState: 'active' }], disks: [{ path: '/x', freeBytes: 10e9, totalBytes: 100e9 }] };
  assert.deepEqual(suggestions({ instance: null, machine: edge, cores: 4, checks: checkTimings([]), usage: { days: usageByDay([]), quotaNote: QUOTA_NOTE } }), NOTHING);
  assert.deepEqual(healthView([], { ...strained, memory: null, load: null, units: null, disks: [] }, { cores: null }).suggestions, NOTHING);
});

test('the dashboard serves /api/health behind its token, from the OS adapter\'s stats, and the hub forwards it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-health-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('coordinator.started', { instance: 'shop@box', pid: 1, version: '0' }, 'c');
  log.append('run.cost', { issue: 1, role: 'worker', model: 'm', usd: 0.4, turns: 3 }, 'c');
  const { dir: root } = exampleProject();
  const asked: string[][] = [];
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', slotsDir: join(dir, 'slots'), logs: { unit: svc, file: null }, machineStats: () => (asked.push(['stats']), calm) });
  const h = await startHub({ instances: [{ name: 'shop', port: Number(new URL(d.url).port), tokenFile: join(dir, 'dashboard-token') }], stateDir: mkdtempSync(join(tmpdir(), 'dash-health-hub-')) });
  try {
    const base = d.url.split('/?')[0]!;
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    const v = (await (await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${d.token}` } })).json()) as { instance: string; machine: MachineStats; cores: number; usage: { days: { estimatedUsd: number }[]; quotaNote: string }; suggestions: string[] };
    assert.equal(v.instance, 'shop@box');
    assert.deepEqual(v.machine, calm, 'the adapter\'s snapshot as read');
    assert.ok(v.cores > 0);
    assert.equal(v.usage.days[0]!.estimatedUsd, 0.4);
    assert.equal(v.usage.quotaNote, QUOTA_NOTE);
    assert.deepEqual(v.suggestions, NOTHING);
    const viaHub = await fetch(`${h.url.split('/?')[0]}/api/i/shop/health`, { headers: { authorization: `Bearer ${h.token}` } });
    assert.equal(viaHub.status, 200);
    assert.equal(((await viaHub.json()) as { instance: string }).instance, 'shop@box');
  } finally {
    await h.close();
    await d.close();
    log.close();
  }
});

test('by default the health view reads the harness slice, this instance\'s service, and the checkout\'s and state dir\'s volumes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-health-vol-'));
  const s = healthStats({ serviceUnit: svc, root: dir, stateDir: dir });
  assert.deepEqual(s.disks.map((x) => x.path), [dir], 'one volume, listed once');
  if (s.units) assert.deepEqual(s.units.map((u) => u.unit), [`${BRAND.cli}.slice`, svc]);
  const plain = healthStats({ serviceUnit: null, root: dir, stateDir: join(dir, 'no', 'such') });
  assert.equal(plain.disks.length, 2);
  if (plain.units) assert.deepEqual(plain.units.map((u) => u.unit), [`${BRAND.cli}.slice`], 'a checkout has no service of its own');
});
