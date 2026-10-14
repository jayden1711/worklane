import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { machineView, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile } from './helpers.js';

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
  return { dir, root, cfg: loadConfig(root), slotsDir, eventsDb, machine: { changesPath, updatesConfigPath, updatesLogPath }, machineOwnersFile: machineOwnersFile('example-owner') };
}

test('the machine settings: the slot cap and its bounds, engine updates, who may change them, and the history newest first', () => {
  const s = setup();
  const v = machineView({ cfg: s.cfg, user: 'example-owner', role: 'owner', slotsDir: s.slotsDir, machine: s.machine, machineOwnersFile: s.machineOwnersFile });
  assert.equal(v.canChange, true);
  assert.deepEqual(v.slots, { cap: 3, running: 0, min: 1, max: 16 });
  assert.deepEqual(v.updates, { configured: true, enabled: true, branch: 'main', requiredChecks: ['test'] });
  assert.deepEqual(v.changes.map((c) => [c.by, c.what, c.to]), [['wl-code', 'updates', true], ['wl-site', 'slots', 3]], 'newest first; a torn line skipped');
  assert.deepEqual(v.history.map((h) => h.event), ['rolled_back', 'installed'], 'newest first; an unknown event skipped');
  assert.equal(v.helper, MACHINE_HELPER);
  assert.equal(machineView({ cfg: s.cfg, user: 'example-collaborator', role: 'writer', slotsDir: s.slotsDir, machine: s.machine, machineOwnersFile: s.machineOwnersFile }).canChange, false, 'a writer is not the owner');
  const bare = setup({ updates: null });
  assert.deepEqual(machineView({ cfg: bare.cfg, user: 'example-owner', role: 'owner', slotsDir: bare.slotsDir, machine: bare.machine, machineOwnersFile: bare.machineOwnersFile }).updates, { configured: false, enabled: null }, 'the updater not set up here');
});

async function serve(s: ReturnType<typeof setup>, user: string) {
  const d = await startDashboard({ root: s.root, cfg: s.cfg, eventsDb: s.eventsDb, stateDir: s.dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: s.slotsDir, machine: s.machine, machineOwnersFile: s.machineOwnersFile });
  const base = d.url.split('/?')[0]!;
  const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asDevicePerson(user) };
  const post = (what: string, value: unknown) => fetch(`${base}/api/machine`, { method: 'POST', headers: h, body: JSON.stringify({ what, value }) });
  const view = async () => (await (await fetch(`${base}/api/machine`, { headers: h })).json()) as { requests: { args: string[]; status: string; detail: string }[] };
  return { d, base, h, post, view };
}

/** The coordinator's side: run what's waiting, as the coordinator would on its next tick. */
function coordinatorTick(s: ReturnType<typeof setup>, exec: (file: string, args: string[]) => string) {
  const log = new EventLog(s.eventsDb);
  try {
    return runMachineRequests({ log, instance: 'site', exec, ownersFile: s.machineOwnersFile });
  } finally {
    log.close();
  }
}

test('the owner asks for a slot cap or update change; the dashboard records it, the coordinator runs the helper with sudo -n, and the page shows pending then done', async () => {
  const s = setup();
  const calls: string[][] = [];
  const x = await serve(s, 'example-owner');
  try {
    assert.equal((await fetch(`${x.base}/api/machine`)).status, 401);
    const r = await x.post('slots', 4);
    assert.equal(r.status, 200, await r.clone().text());
    const body = (await r.json()) as { pending: boolean; machine: { slots: { cap: number }; requests: { status: string }[] } };
    assert.equal(body.pending, true);
    assert.equal(body.machine.slots.cap, 3, 'unchanged until the helper has run');
    assert.deepEqual(body.machine.requests.map((q) => q.status), ['pending']);
    assert.equal((await x.post('updates', false)).status, 200);
    assert.equal(calls.length, 0, 'the dashboard ran nothing');
    assert.equal(coordinatorTick(s, (file, args) => (calls.push([file, ...args]), 'ok')), 2);
    assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'set-slots', '4'], ['sudo', '-n', MACHINE_HELPER, 'set-updates', 'off']]);
    assert.deepEqual((await x.view()).requests.map((q) => [q.args.join(' '), q.status, q.detail]), [['set-updates off', 'done', 'ok'], ['set-slots 4', 'done', 'ok']], 'newest first, done with the output');
    for (const [what, value, why] of [['slots', 17, /set-slots <1\.\.16>/], ['slots', 0, /set-slots <1\.\.16>/], ['slots', 2.5, /set-slots <1\.\.16>/], ['updates', 'yes', /on \(true\) or off \(false\)/], ['cap', 3, /slots, testSlots or updates/], ['testSlots', 9, /set-test-slots <1\.\.8>/]] as [string, unknown, RegExp][]) {
      const bad = await x.post(what, value);
      assert.equal(bad.status, 400, `${what}=${value}`);
      assert.match(((await bad.json()) as { error: string }).error, why);
    }
    assert.equal(coordinatorTick(s, (file, args) => (calls.push([file, ...args]), 'ok')), 0, 'a bad value is never recorded, so never run');
    assert.equal(calls.length, 2);
  } finally {
    await x.d.close();
  }
});

test('anyone but the owner is refused; a missing sudo rule or helper shows in the request as failed, saying what an admin does', async () => {
  const s = setup();
  const other = await serve(s, 'example-collaborator');
  try {
    const r = await other.post('slots', 4);
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /only the instance's owners \(admin on [^)]+\) may change machine settings; @example-collaborator is a writer/);
  } finally {
    await other.d.close();
  }
  const fail = (stderr: string) => () => {
    throw Object.assign(new Error('Command failed'), { stderr });
  };
  const x = await serve(s, 'example-owner');
  try {
    assert.equal((await x.post('slots', 4)).status, 200);
    coordinatorTick(s, fail('sudo: a password is required\n'));
    assert.equal((await x.post('updates', true)).status, 200);
    coordinatorTick(s, fail('sudo: /usr/local/libexec/x: command not found'));
    const [updates, slots] = (await x.view()).requests;
    assert.equal(slots!.status, 'failed');
    assert.match(slots!.detail, /may not run .* \(sudo: a password is required\); an admin runs scripts\/setup\/machine-helper\.sh/);
    assert.equal(updates!.status, 'failed');
    assert.match(updates!.detail, /isn't installed; an admin runs scripts\/setup\/machine-helper\.sh once/);
  } finally {
    await x.d.close();
  }
});
