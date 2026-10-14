import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asks } from '../src/console/asks.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { machineRequests, requestMachineChange } from '../src/machine-requests.js';
import { runMachineRequests, STALE_CLAIM_MS } from '../src/coordinator/machine-requests.js';
import { asDevicePerson, exampleProject, exampleRoles, ownerRequester, machineOwnersFile, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
/** olive is the machine's owner in these tests. */
const ownersFile = machineOwnersFile('olive');
const recorder = () => {
  const calls: string[][] = [];
  return { calls, exec: (file: string, args: string[]) => (calls.push([file, ...args]), `ran ${args.slice(2).join(' ')}`) };
};

test('the coordinator runs an allowed request through the helper and records the outcome', () => {
  const log = new EventLog(':memory:');
  const r = requestMachineChange(log, { args: ['set-slots', '4'], requester: ownerRequester('olive'), ownersFile, via: 'settings' });
  assert.equal(r.status, 'pending');
  const x = recorder();
  assert.equal(runMachineRequests({ log, ownersFile, instance: 'site', exec: x.exec }), 1);
  assert.deepEqual(x.calls, [['sudo', '-n', MACHINE_HELPER, 'set-slots', '4']]);
  const done = machineRequests(log.read(0))[0]!;
  assert.deepEqual([done.status, done.detail, done.by], ['done', 'ran set-slots 4', 'olive']);
  const started = log.read(0, ['machine.started']);
  assert.equal(started.length, 1);
  assert.equal((started[0]!.payload as { instance: string }).instance, 'site', 'which coordinator took it');
  // A failure is recorded too, with what an admin does.
  requestMachineChange(log, { args: ['set-updates', 'on'], requester: ownerRequester('olive'), ownersFile, via: 'settings' });
  runMachineRequests({
    log,
    ownersFile,
    instance: 'site',
    exec: () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'sudo: a password is required' });
    },
  });
  const failed = machineRequests(log.read(0)).at(-1)!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /an admin runs scripts\/setup\/machine-helper\.sh/);
});

test('a request off the allowlist is refused by the coordinator even when written straight into the log, and never reaches sudo', () => {
  const log = new EventLog(':memory:');
  // The dashboard refuses these before recording them...
  for (const args of [['set-slots', '99'], ['bash', '-c', 'id'], ['set-updates', 'maybe'], []]) assert.throws(() => requestMachineChange(log, { args, requester: ownerRequester('olive'), ownersFile, via: 'settings' }), String(args));
  // ...and a request written some other way is refused when the coordinator takes it.
  for (const [i, args] of [['set-slots', '99'], ['bash', '-c', 'id'], ['set-slots', '4', '; rm -rf /'], ['set-slots', '04']].entries()) log.append('machine.requested', { id: `forged-${i}`, args, by: 'olive', via: 'settings', ask: null }, 'olive', 'human');
  const x = recorder();
  assert.equal(runMachineRequests({ log, ownersFile, instance: 'site', exec: x.exec }), 0);
  assert.deepEqual(x.calls, [], 'nothing ran');
  const all = machineRequests(log.read(0));
  assert.deepEqual(all.map((r) => r.status), ['refused', 'refused', 'refused', 'refused']);
  for (const r of all) assert.match(r.detail, /needs the helper extended|not a machine helper command/);
});

test("a request isn't run twice: not on a later tick, not by a second taker, and not after a coordinator stopped mid-run", () => {
  const log = new EventLog(':memory:');
  requestMachineChange(log, { args: ['set-slots', '5'], requester: ownerRequester('olive'), ownersFile, via: 'settings' });
  const x = recorder();
  runMachineRequests({ log, ownersFile, instance: 'site', exec: x.exec });
  runMachineRequests({ log, ownersFile, instance: 'site', exec: x.exec });
  assert.equal(x.calls.length, 1, 'once, over two ticks');

  // A second taker (the same log, another process) that read the request as pending loses the claim.
  const r = requestMachineChange(log, { args: ['set-slots', '6'], requester: ownerRequester('olive'), ownersFile, via: 'settings' });
  log.append('machine.started', { id: r.id, instance: 'site' }, 'site', 'coordinator');
  runMachineRequests({ log, ownersFile, instance: 'site', exec: x.exec });
  assert.equal(x.calls.length, 1, 'a request already claimed is left to its taker');
  // That taker stopped before finishing: once the claim is stale it's marked interrupted, and still not run.
  runMachineRequests({ log, ownersFile, instance: 'site', exec: x.exec, now: () => Date.now() + STALE_CLAIM_MS + 1000 });
  assert.equal(x.calls.length, 1);
  assert.equal(machineRequests(log.read(0)).find((q) => q.id === r.id)!.status, 'interrupted');

  // A root-step ask has at most one request waiting.
  const ask = asks(log).create({ instance: 'site', kind: 'root_step', title: 'Seven slots', detail: 'x', command: 'set-slots', args: ['7'] });
  requestMachineChange(log, { args: ['set-slots', '7'], requester: ownerRequester('olive'), ownersFile, via: 'ask', ask: ask.id });
  assert.throws(() => requestMachineChange(log, { args: ['set-slots', '7'], requester: ownerRequester('olive'), ownersFile, via: 'ask', ask: ask.id }), /already has a machine change waiting/);
  runMachineRequests({ log, ownersFile, instance: 'site', exec: x.exec });
  assert.equal(asks(log).get(ask.id)!.answer!.answer, 'ran', 'the coordinator answers the ask');
});

test('the dashboard path never spawns sudo: Settings and root steps only record a request', { skip: !posix && 'a fake sudo on PATH needs a POSIX shell' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-sudo-'));
  const marker = join(dir, 'sudo-ran');
  const fake = join(dir, 'sudo');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${marker}"\necho ok\n`);
  chmodSync(fake, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  const log = new EventLog(eventsDb);
  const step = asks(log).create({ instance: 'site', kind: 'root_step', title: 'Four slots', detail: 'x', command: 'set-slots', args: ['4'] });
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: machineOwnersFile('example-owner'), slotsDir: join(dir, 'slots'), machine: { changesPath: join(dir, 'changes.jsonl'), updatesConfigPath: join(dir, 'updates.json'), updatesLogPath: join(dir, 'updates.jsonl') } });
  try {
    const base = d.url.split('/?')[0]!;
    const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asDevicePerson('example-owner') };
    assert.equal((await fetch(`${base}/api/machine`, { method: 'POST', headers: h, body: JSON.stringify({ what: 'slots', value: 4 }) })).status, 200);
    assert.equal((await fetch(`${base}/api/machine`, { method: 'POST', headers: h, body: JSON.stringify({ what: 'updates', value: true }) })).status, 200);
    const run = await fetch(`${base}/api/asks/${step.id}/run`, { method: 'POST', headers: h, body: '{}' });
    assert.equal(run.status, 200, await run.text());
    assert.equal(existsSync(marker), false, `the dashboard ran sudo: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`);
    assert.deepEqual(machineRequests(log.read(0)).map((r) => [r.args.join(' '), r.status]), [['set-slots 4', 'pending'], ['set-updates on', 'pending'], ['set-slots 4', 'pending']]);
  } finally {
    process.env.PATH = prevPath;
    log.close();
    await d.close();
  }
});

test('only the coordinator runs the helper: no other module calls setSlotCap, setUpdates or a root step rule', () => {
  const src = join(repoRoot, 'src');
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
  const allowed = new Set(['src/machine.ts', 'src/console/root-steps.ts', 'src/coordinator/machine-requests.ts']);
  const callers = files(src)
    .filter((f) => /\b(setSlotCap|setUpdates)\(|\brule\.run\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(repoRoot, f).split('\\').join('/'));
  assert.deepEqual(callers.filter((f) => !allowed.has(f)), []);
  assert.ok(callers.includes('src/coordinator/machine-requests.ts'));
});
