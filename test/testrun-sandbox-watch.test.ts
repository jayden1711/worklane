// WHY: a sandbox check that failed at coordinator start switched test runs off with nothing in the journal. These
// tests hold that the failure is said on stderr with its FAIL lines, and that it raises the watchdog's test_sandbox
// incident, on the Health page and in the ops channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { HELPER_PROTOCOL } from '../src/testrun/helper.js';
import type { RunHost } from '../src/testrun/host.js';
import { useTestRuns } from '../src/testrun/index.js';
import { setupTestRuns } from '../src/testrun/setup.js';
import { testRunStatus } from '../src/testrun/status.js';
import { readIncidents } from '../src/watchdog/incidents.js';
import { incidentsView } from '../src/watchdog/view.js';
import { Watchdog } from '../src/watchdog/watchdog.js';
import { exampleProject } from './helpers.js';

const FAIL = 'FAIL in the sandbox (exit 226): the probe printed nothing';
const testRun = { tiers: [{ name: 'unit', command: 'echo unit ok', kind: 'fast' }], checks: { unit: 'test / unit' } };
const cfg = { tests: { test_run: TestRunConfig.parse(testRun), checkout: { sparse_exclude: [] } } } as unknown as Config;
const host = { kind: 'sandbox', helperVersion: async () => ({ version: HELPER_PROTOCOL, stderr: '' }), check: async () => ({ ok: false, detail: FAIL }) } as unknown as RunHost;

test('regression: a sandbox check that fails at coordinator start is in the journal, with its FAIL lines (stderr by default)', async () => {
  const p = exampleProject();
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'sbx-journal-')), 'events.db'));
  const said: string[] = [];
  const real = console.error;
  const err: string[] = [];
  try {
    await setupTestRuns(cfg, { instance: 'shop', repo: 'example-org/example-shop', token: async () => 't', host, say: (l) => said.push(l) }, { log, actor: 'shop', root: p.dir, stateDir: p.stateDir });
    console.error = (...a: unknown[]) => void err.push(a.join(' '));
    await setupTestRuns(cfg, { instance: 'shop', repo: 'example-org/example-shop', token: async () => 't', host }, { log, actor: 'shop', root: p.dir, stateDir: p.stateDir });
  } finally {
    console.error = real;
    useTestRuns(null);
    log.close();
  }
  for (const lines of [said, err]) {
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^test runs are OFF: the test sandbox check failed/);
    assert.ok(lines[0]!.includes(`\n  ${FAIL}`), lines[0]);
  }
});

test('a sandbox check that fails at coordinator start raises one test_sandbox incident: on the Health page and in the ops channel', async () => {
  const p = exampleProject();
  const base = mkdtempSync(join(tmpdir(), 'sbx-alert-'));
  const log = new EventLog(join(base, 'events.db'));
  const incidents = join(base, 'incidents');
  mkdirSync(incidents);
  const posts: string[] = [];
  let now = Date.parse('2026-10-13T21:05:22Z');
  const dog = new Watchdog({
    instance: 'shop',
    dir: incidents,
    events: () => log.read(0),
    stop: () => null,
    emergency: () => false,
    instances: () => ['shop'],
    units: () => null,
    updates: () => [],
    disks: () => [],
    config: () => ({ stallHours: 6, diskPct: 85, opsChannel: null, dashboardUrl: null }),
    poster: () => ({ poster: async (c: string) => (posts.push(c), true), dashboardUrl: 'https://dash.example.test', secrets: [] }),
    now: () => new Date(now),
  });
  try {
    await setupTestRuns(cfg, { instance: 'shop', repo: 'example-org/example-shop', token: async () => 't', host, say: () => undefined }, { log, actor: 'shop', root: p.dir, stateDir: p.stateDir });
    assert.deepEqual(log.read(0, ['testrun.sandbox']).map((e) => (e.payload as EventPayload<'testrun.sandbox'>).ok), [false]);
    assert.match(testRunStatus(log.read(0)).problems[0]!, /^Test runs are off: the sandbox failed its check \(FAIL in the sandbox/);
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      await dog.pass();
    }
    const open = readIncidents(incidents).incidents.filter((x) => !x.resolvedAt);
    assert.deepEqual(open.map((x) => [x.kind, x.key, x.instance, x.severity]), [['test_sandbox', 'shop', 'shop', 'red']]);
    assert.ok(open[0]!.detail.includes(FAIL));
    assert.equal(posts.length, 1, 'posted to the ops channel, once');
    assert.match(posts[0]!, /The test sandbox check is failing/);
    const page = incidentsView({ dir: incidents, instance: 'shop', full: true });
    assert.equal(page.status, 'red');
    assert.deepEqual(page.open.map((x) => x.kind), ['test_sandbox']);
  } finally {
    useTestRuns(null);
    log.close();
  }
});
