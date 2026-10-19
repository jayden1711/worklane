// The test runs on the dashboard: /api/test-runs for each role, the Board's and the Machine page's views of it, and
// the test-run slot setting. Viewers see each run's tiers' pass or fail only, never a log, summary or holder.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { testRunsView } from '../src/testrun/status.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

interface Render {
  renderTestRuns(data: unknown, compact?: boolean): string;
  renderMachine(data: unknown): string;
  lockLine?: unknown;
}
let r: Render;

before(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'tr-render-'));
  await build({
    configFile: false,
    root: join(repoRoot, 'web'),
    logLevel: 'silent',
    plugins: [react()],
    ssr: { noExternal: true },
    build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } },
  });
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as Render;
});

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);

function seed(log: EventLog) {
  log.append('testrun.queued', { id: 'fast-q', sha: a, kind: 'fast', prs: [11], shard: null }, 'c');
  log.append('testrun.queued', { id: 'full-r', sha: b, kind: 'full', prs: [12, 13], shard: { index: 1, total: 2 } }, 'c');
  log.append('testrun.started', { id: 'full-r', slot: 'test-0', lock_wait_ms: 4000 }, 'c');
  log.append('testrun.tier', { id: 'full-r', tier: 'suite', ok: false, duration_ms: 65_000, summary: 'SECRET-LOG-LINE at /srv/x', log_ref: 'full-r/suite.log', cpu_s: 120, mem_peak_mb: 1900 }, 'c');
  log.append('testrun.queued', { id: 'fast-d', sha: a, kind: 'fast', prs: [11], shard: null }, 'c');
  log.append('testrun.started', { id: 'fast-d', slot: 'test-1', lock_wait_ms: 0 }, 'c');
  log.append('testrun.tier', { id: 'fast-d', tier: 'chain', ok: true, duration_ms: 3000, summary: 'SECRET-LOG-LINE ok', log_ref: 'fast-d/chain.log', cpu_s: 2, mem_peak_mb: 300 }, 'c');
  log.append('testrun.finished', { id: 'fast-d', sha: a, kind: 'fast', prs: [11], ok: true, outcome: 'done', results: [{ tier: 'chain', ok: true }], detail: '' }, 'c');
  log.append('testrun.sandbox', { ok: true, detail: 'all checks passed' }, 'c');
  log.append('testrun.checks_permission', { level: 'read', detail: 'SECRET-DETAIL the App has Checks: read' }, 'c');
}

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'tr-dash-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  seed(log);
  const { dir: root } = exampleProject();
  const slots = join(dir, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 3 }));
  writeFileSync(join(slots, 'test-0.lock'), JSON.stringify({ pid: process.pid, owner: 'wl-site test run full-r', acquiredAt: new Date().toISOString() }));
  const cfg = loadConfig(root);
  cfg.tests.test_run = { setup: [], fetch: [], setup_network: false, tiers: [{ name: 'chain', command: 'x', kind: 'fast', database: false, shardable: false, full_checkout: false, gpu: false, network: false, timeout_s: 60 }], caches: [], shared: [], checks: {}, env: {} };
  const d = await startDashboard({ root, cfg, eventsDb: db, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: slots, actor: 'wl-site', pollMs: 50, testRunLock: join(dir, 'full-run.lock') });
  const base = d.url.split('/?')[0]!;
  const get = async <T>(path: string, who: string) => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } })).json() as Promise<T>;
  return { d, get };
}

type View = Record<string, unknown> & { queue: { id: string }[]; running: { id: string; tiers: { tier: string; ok: boolean }[] }[]; recent: { id: string }[] };

test('/api/test-runs: owners and writers get the queue, slots, lock, summaries and problems; a viewer gets tier pass or fail only', async () => {
  const s = await serve();
  try {
    for (const who of ['example-owner', 'example-collaborator']) {
      const v = await s.get<View>('/api/test-runs', who);
      assert.equal(v.configured, true);
      assert.equal(v.cap, 3);
      assert.equal(v.inUse, 1);
      assert.deepEqual([v.queue.map((x) => x.id), v.running.map((x) => x.id), v.recent.map((x) => x.id)], [['fast-q'], ['full-r'], ['fast-d']]);
      assert.deepEqual((v.slots as { slot: string; owner: string }[]).map((x) => [x.slot, x.owner]), [['test-0', 'wl-site test run full-r']]);
      assert.match(JSON.stringify(v), /SECRET-LOG-LINE/, `${who} sees the tier's summary`);
      assert.match((v.problems as string[])[0]!, /can't post their checks/);
      assert.ok(v.lock && typeof v.lock === 'object');
    }
    const viewer = await s.get<View>('/api/test-runs', 'someone-else');
    assert.equal(viewer.viewer, true);
    assert.deepEqual(viewer.running[0], { id: 'full-r', sha: b, kind: 'full', prs: [12, 13], state: 'running', tiers: [{ tier: 'suite', ok: false }] });
    assert.deepEqual(Object.keys(viewer).sort(), ['cap', 'configured', 'inUse', 'queue', 'recent', 'running', 'viewer']);
    assert.doesNotMatch(JSON.stringify(viewer), /SECRET|suite\.log|test-0|wl-site|Checks/);
    // The event log: a viewer sees a run's outcome with each tier's pass or fail, never a tier's summary or log.
    const events = await s.get<{ type: string; payload: Record<string, unknown> }[]>('/api/events', 'someone-else');
    const tr = events.filter((e) => e.type.startsWith('testrun.'));
    assert.deepEqual(tr.map((e) => e.type), ['testrun.finished']);
    assert.deepEqual(tr[0]!.payload.results, [{ tier: 'chain', ok: true }]);
    assert.doesNotMatch(JSON.stringify(events), /SECRET/);
    const activity = (await s.get<{ activity: { type: string; summary: string }[] }>('/api/state', 'someone-else')).activity;
    assert.ok(activity.some((x) => x.summary === `fast test run passed on ${a.slice(0, 8)} (#11)`), JSON.stringify(activity));
    // The machine settings carry the test-run slot cap.
    const m = await s.get<{ testSlots: unknown }>('/api/machine', 'example-owner');
    assert.deepEqual(m.testSlots, { cap: 3, running: 1, min: 1, max: 8 });
  } finally {
    await s.d.close();
  }
});

const writerData = {
  configured: true,
  viewer: false,
  cap: 2,
  inUse: 1,
  queue: [{ id: 'fast-q', sha: a, kind: 'fast', prs: [11], state: 'queued', tiers: [], queuedAt: new Date().toISOString() }],
  running: [{ id: 'full-r', sha: b, kind: 'full', prs: [12, 13], state: 'running', shard: { index: 1, total: 2 }, slot: 'test-0', startedAt: new Date().toISOString(), tiers: [{ tier: 'suite', ok: false, durationMs: 65_000, summary: 'boom' }] }],
  recent: [{ id: 'fast-d', sha: a, kind: 'fast', prs: [11], state: 'passed', finishedAt: new Date().toISOString(), tiers: [{ tier: 'chain', ok: true, durationMs: 3000 }] }],
  slots: [{ slot: 'test-0', owner: 'wl-site test run full-r', acquiredAt: new Date().toISOString() }],
  lock: { path: '/run/lock/x.lock', holders: [{ pid: 4242, mode: 'exclusive' }] },
  tierStats: [{ tier: 'suite', runs: 4, medianMs: 60_000, peakMemMb: 1900, maxCpuS: 120 }],
  problems: ["Test runs can't post their checks: the App has no Checks: write permission (it has read)."],
};

test('the Machine page\'s test runs: queue, the running slot and its holder, who holds the lock, tiers, figures and problems', () => {
  const html = r.renderTestRuns(writerData);
  assert.match(html, /data-testid="test-runs-counts"[^>]*>1 of 2 slots running, machine-wide · 1 queued · full-run lock: held exclusively \(pid 4242\); test runs wait for it</);
  assert.match(html, /data-testid="test-runs-problem"[^>]*>Test runs can&#x27;t post their checks/);
  assert.match(html, /data-state="running"[\s\S]*full bbbbbbbb[\s\S]*1\/2[\s\S]*#12 #13[\s\S]*test-0[\s\S]*data-ok="no"[^>]*>✗ suite/);
  assert.match(html, /data-state="queued"[\s\S]*fast aaaaaaaa/);
  assert.match(html, /data-testid="test-runs-slots"[\s\S]*wl-site test run full-r/);
  assert.match(html, /data-testid="test-runs-recent"[\s\S]*data-state="passed"[\s\S]*data-ok="yes"[^>]*>✓ chain/);
  assert.match(html, /data-testid="test-runs-tier-stats"[\s\S]*suite[\s\S]*1900 MB[\s\S]*120 s/);
  // Shared by test runs, or free.
  assert.match(r.renderTestRuns({ ...writerData, lock: { path: '/x', holders: [{ pid: 1, mode: 'shared' }, { pid: 2, mode: 'shared' }] } }), /full-run lock: shared by 2 test runs/);
  assert.match(r.renderTestRuns({ ...writerData, lock: { path: '/x', holders: [] } }), /full-run lock: free/);
  // The Board's short form: the live and recent runs, no slot holders or figures.
  const board = r.renderTestRuns(writerData, true);
  assert.match(board, /data-testid="test-runs-live"/);
  assert.doesNotMatch(board, /test-runs-slots|test-runs-tier-stats/);
  assert.match(r.renderTestRuns({ configured: false, viewer: false, cap: 2, inUse: 0, queue: [], running: [], recent: [] }), /data-configured="no"[^>]*>Test runs: off/);
});

test('#545 round 9 (c): the Machine page shows a machine that can\'t give runs a user namespace of their own as a red problem with the fix, with test runs on', () => {
  const why = "this machine's unshare can't be the test runs' wrapper (no setpriv): install util-linux 2.38 or later and setpriv, then run scripts/setup/test-user.sh install shop again";
  const events = [{ id: 1, ts: new Date().toISOString(), type: 'testrun.sandbox', actor: 'shop', source: 'engine', payload: { ok: true, detail: 'all checks passed', unsupported: why } }] as unknown as StoredEvent[];
  const view = testRunsView({ events, configured: true, writer: true, cap: 2, slots: [], lock: { path: '/x', holders: [] } });
  const html = r.renderTestRuns(view);
  assert.match(html, /data-testid="test-runs-problem"[^>]*>Test runs share the host&#x27;s user namespace[^<]*install util-linux 2\.38 or later and setpriv, then run scripts\/setup\/test-user\.sh install shop again\. Test runs go on meanwhile; this doesn&#x27;t turn them off\.</);
  assert.equal((view as { sandbox: { ok: boolean } }).sandbox.ok, true);
});

test('the Machine page\'s test runs: root\'s network grants, read-only with the root command; none of it on the Board', () => {
  const on = r.renderTestRuns({ ...writerData, network: { state: 'on', tiers: ['e2e', 'setup'], change: 'sudo bash /opt/worklane/current/scripts/setup/testrun-network.sh disable shop', status: 'x' } });
  assert.match(on, /data-testid="test-runs-network" data-state="on"[^>]*>[\s\S]*Network for test runs: [\s\S]*none, except tiers e2e, setup \(public addresses only\)[\s\S]*Only root changes it: [\s\S]*data-testid="test-runs-network-command"[^>]*>sudo bash \/opt\/worklane\/current\/scripts\/setup\/testrun-network\.sh disable shop</);
  const off = r.renderTestRuns({ ...writerData, network: { state: 'off', why: 'no root grant file', change: 'sudo bash x enable shop --tiers <tier>', status: 'x' } });
  assert.match(off, /data-state="off"[\s\S]*none for every tier[\s\S]*sudo bash x enable shop --tiers &lt;tier&gt;/);
  assert.doesNotMatch(r.renderTestRuns({ ...writerData, network: { state: 'off', why: 'x', change: 'x', status: 'x' } }, true), /test-runs-network"/, 'not on the Board');
});

test('the Machine page\'s test runs: root\'s GPU opt-in, read-only with the root command; a GPU tier says whether it got the GPU; none of it on the Board', () => {
  const gpuTier = { tier: 'cuda', ok: true, durationMs: 9000, gpu: { granted: true, devices: ['/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia0'], detail: 'GPU 0; max 1200 s; waited 0 s' } };
  const noGpu = { tier: 'cuda2', ok: true, durationMs: 9000, gpu: { granted: false, devices: [], detail: 'not on for shop' } };
  const data = { ...writerData, recent: [{ ...writerData.recent[0]!, tiers: [gpuTier, noGpu] }], gpu: { state: 'on', devices: [0], maxMinutes: 20, change: 'sudo bash /opt/worklane/current/scripts/setup/testrun-gpu.sh disable shop', status: 'x' } };
  const html = r.renderTestRuns(data);
  assert.match(html, /data-testid="test-runs-gpu" data-state="on"[^>]*>[\s\S]*GPU for test runs: [\s\S]*on: GPU 0, at most 20 min a GPU command, one run per GPU[\s\S]*Only root changes it: [\s\S]*data-testid="test-runs-gpu-command"[^>]*>sudo bash \/opt\/worklane\/current\/scripts\/setup\/testrun-gpu\.sh disable shop</);
  assert.match(html, /title="GPU: \/dev\/nvidiactl \/dev\/nvidia-uvm \/dev\/nvidia0; GPU 0; max 1200 s; waited 0 s" data-testid="test-run-tier-gpu" data-granted="yes">GPU</);
  assert.match(html, /title="no GPU: not on for shop" data-testid="test-run-tier-gpu" data-granted="no">no GPU</);
  const off = r.renderTestRuns({ ...writerData, gpu: { state: 'off', why: 'GPU test runs are off on this machine (no root opt-in file)', change: 'sudo bash x enable shop --devices 0 --max-minutes 20', status: 'x' } });
  assert.match(off, /data-state="off"[\s\S]*off \(GPU test runs are off on this machine \(no root opt-in file\)\)[\s\S]*sudo bash x enable shop/);
  assert.doesNotMatch(r.renderTestRuns(data, true), /test-runs-gpu"/, 'not on the Board');
  assert.doesNotMatch(r.renderTestRuns(writerData), /test-runs-gpu"/, 'nothing without the field');
});

test('a viewer\'s test runs show each tier\'s pass or fail and nothing more', () => {
  const viewer = { configured: true, viewer: true, cap: 2, inUse: 1, queue: [], running: [{ id: 'full-r', sha: b, kind: 'full', prs: [12], state: 'running', tiers: [{ tier: 'suite', ok: false }] }], recent: [] };
  const html = r.renderTestRuns(viewer);
  assert.match(html, /data-ok="no"[^>]*>✗ suite/);
  assert.match(html, /data-testid="test-runs-viewer"/);
  assert.doesNotMatch(html, /data-testid="test-run-tier"[^>]*title=|title="[^"]*"[^>]*data-testid="test-run-tier"/, 'no summary to hover');
  assert.doesNotMatch(html, />never</);
  assert.doesNotMatch(html, /full-run lock|test-runs-slots|test-runs-problem/);
});

test('the machine settings: the owner can change the test-run slot cap, with its bounds', () => {
  const data = { owner: 'example-owner', user: 'example-owner', canChange: true, helper: '/usr/local/libexec/harness-machine', slots: { cap: 3, running: 1, min: 1, max: 16 }, testSlots: { cap: 2, running: 1, min: 1, max: 8 }, updates: { configured: false, enabled: null }, changes: [], history: [] };
  const html = r.renderMachine(data);
  assert.match(html, /data-setting="testSlots"[\s\S]*?>2<[\s\S]*?1–8; 1 running now/);
  assert.doesNotMatch(r.renderMachine({ ...data, testSlots: undefined }), /data-setting="testSlots"/, 'an older server without it: no row');
});
