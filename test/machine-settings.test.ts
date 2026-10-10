import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { machineView, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { exampleProject } from './helpers.js';

function setup(o: { updates?: boolean | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-machine-'));
  const slotsDir = join(dir, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 3 }));
  const updatesConfigPath = join(dir, 'updates.json');
  if (o.updates !== null) writeFileSync(updatesConfigPath, JSON.stringify({ enabled: o.updates ?? true, repo_url: 'https://example.test/engine.git', branch: 'main', required_checks: ['test'] }));
  const changesPath = join(dir, 'machine-changes.jsonl');
  writeFileSync(changesPath, [JSON.stringify({ at: '2026-01-01T00:00:00Z', by: 'wl-site', what: 'slots', from: 2, to: 3 }), 'not json', JSON.stringify({ at: '2026-01-02T00:00:00Z', by: 'wl-code', what: 'updates', from: false, to: true })].join('\n'));
  const updatesLogPath = join(dir, 'updates.jsonl');
  writeFileSync(updatesLogPath, [JSON.stringify({ at: '2026-01-03T00:00:00Z', event: 'installed', from: 'a'.repeat(40), to: 'b'.repeat(40), units: ['harness-site.service'] }), JSON.stringify({ at: '2026-01-04T00:00:00Z', event: 'rolled_back', from: 'b'.repeat(40), to: 'c'.repeat(40), failed: ['harness-site.service'], back: 'b'.repeat(40) }), JSON.stringify({ at: '2026-01-05T00:00:00Z', event: 'mystery' })].join('\n'));
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const { dir: root } = exampleProject();
  return { dir, root, cfg: loadConfig(root), slotsDir, eventsDb, machine: { changesPath, updatesConfigPath, updatesLogPath } };
}

test('the machine settings: the slot cap and its bounds, engine updates, who may change them, and the history newest first', () => {
  const s = setup();
  const v = machineView({ cfg: s.cfg, user: 'example-owner', slotsDir: s.slotsDir, machine: s.machine });
  assert.equal(v.canChange, true);
  assert.deepEqual(v.slots, { cap: 3, running: 0, min: 1, max: 16 });
  assert.deepEqual(v.updates, { configured: true, enabled: true, branch: 'main', requiredChecks: ['test'] });
  assert.deepEqual(v.changes.map((c) => [c.by, c.what, c.to]), [['wl-code', 'updates', true], ['wl-site', 'slots', 3]], 'newest first; a torn line skipped');
  assert.deepEqual(v.history.map((h) => h.event), ['rolled_back', 'installed'], 'newest first; an unknown event skipped');
  assert.equal(v.helper, MACHINE_HELPER);
  assert.equal(machineView({ cfg: s.cfg, user: 'example-collaborator', slotsDir: s.slotsDir, machine: s.machine }).canChange, false, 'a writer is not the owner');
  const bare = setup({ updates: null });
  assert.deepEqual(machineView({ cfg: bare.cfg, user: 'example-owner', slotsDir: bare.slotsDir, machine: bare.machine }).updates, { configured: false, enabled: null }, 'the updater not set up here');
});

async function serve(s: ReturnType<typeof setup>, user: string, exec: (file: string, args: string[]) => string) {
  const d = await startDashboard({ root: s.root, cfg: s.cfg, eventsDb: s.eventsDb, stateDir: s.dir, user, slotsDir: s.slotsDir, machine: { ...s.machine, exec } });
  const base = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' };
  const post = (what: string, value: unknown) => fetch(`${base}/api/machine`, { method: 'POST', headers: h, body: JSON.stringify({ what, value }) });
  return { d, base, h, post };
}

test('the owner changes the slot cap and engine updates through the machine helper, as this server\'s user, with sudo -n', async () => {
  const s = setup();
  const calls: string[][] = [];
  const x = await serve(s, 'example-owner', (file, args) => (calls.push([file, ...args]), 'ok'));
  try {
    assert.equal((await fetch(`${x.base}/api/machine`)).status, 401);
    const r = await x.post('slots', 4);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(((await r.json()) as { machine: { slots: { cap: number } } }).machine.slots.cap, 3, 'the view is re-read after the change (the helper writes the real cap)');
    assert.equal((await x.post('updates', false)).status, 200);
    assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'set-slots', '4'], ['sudo', '-n', MACHINE_HELPER, 'set-updates', 'off']]);
    for (const [what, value, why] of [['slots', 17, /1 to 16/], ['slots', 0, /1 to 16/], ['slots', 2.5, /whole number/], ['updates', 'yes', /on \(true\) or off \(false\)/], ['cap', 3, /slots or updates/]] as [string, unknown, RegExp][]) {
      const bad = await x.post(what, value);
      assert.equal(bad.status, 400, `${what}=${value}`);
      assert.match(((await bad.json()) as { error: string }).error, why);
    }
    assert.equal(calls.length, 2, 'a bad value never reaches the helper');
  } finally {
    await x.d.close();
  }
});

test('anyone but the owner is refused; a missing sudo rule or helper says what an admin does', async () => {
  const s = setup();
  const calls: string[][] = [];
  const other = await serve(s, 'example-collaborator', (file, args) => (calls.push([file, ...args]), 'ok'));
  try {
    const r = await other.post('slots', 4);
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /only the owner \(@example-owner\)/);
    assert.equal(calls.length, 0);
  } finally {
    await other.d.close();
  }
  const fail = (stderr: string) => () => {
    throw Object.assign(new Error('Command failed'), { stderr });
  };
  const noRule = await serve(s, 'example-owner', fail('sudo: a password is required\n'));
  try {
    const r = await noRule.post('slots', 4);
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /may not run .* \(sudo: a password is required\); an admin runs scripts\/setup\/machine-helper\.sh/);
  } finally {
    await noRule.d.close();
  }
  const noHelper = await serve(s, 'example-owner', fail('sudo: /usr/local/libexec/x: command not found'));
  try {
    const r = await noHelper.post('updates', true);
    assert.match(((await r.json()) as { error: string }).error, /isn't installed; an admin runs scripts\/setup\/machine-helper\.sh once/);
  } finally {
    await noHelper.d.close();
  }
});
