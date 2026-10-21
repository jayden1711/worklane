import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './script-child-process.js';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { asks } from '../src/console/asks.js';
import { requestRootStep } from '../src/console/root-steps.js';
import { isMachineOwner, machineChangeRefusal, machineOwners, MACHINE_OWNERS_FILE, readMachineOwners } from '../src/machine-owners.js';
import { MachineRequestError, machineRequests, requestMachineChange } from '../src/machine-requests.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { BRAND } from '../src/brand.js';
import { ownerRequester, machineOwnersFile, repoRoot } from './helpers.js';
import { onRealMachine } from './isolate.js';

const posix = process.platform !== 'win32';
const setup = join(repoRoot, 'scripts', 'setup');

test('the machine owners file: two logins, matched case-insensitively; missing, malformed or open to others is no owners', () => {
  assert.equal(onRealMachine(MACHINE_OWNERS_FILE), `/etc/${BRAND.cli}/machine-owners.json`);
  const two = machineOwnersFile('ada', 'Olu');
  assert.deepEqual(machineOwners(two), ['ada', 'Olu']);
  for (const l of ['ada', 'ADA', 'olu']) assert.equal(isMachineOwner(l, two), true, l);
  for (const l of ['ivy', '', 'ada ', 'ad', null]) assert.equal(isMachineOwner(l, two), false, String(l));
  const dir = mkdtempSync(join(tmpdir(), 'owners-bad-'));
  assert.deepEqual(readMachineOwners(join(dir, 'none.json')), { owners: [], error: null }, 'no file: no owners');
  for (const [name, body] of [['notjson', '{'], ['shape', '["ada"]'], ['badlogin', '{"owners":["ada","a;b"]}'], ['dash', '{"owners":["-ada"]}'], ['type', '{"owners":[1]}']] as const) {
    const f = join(dir, `${name}.json`);
    writeFileSync(f, body, { mode: 0o644 });
    const r = readMachineOwners(f);
    assert.deepEqual(r.owners, [], name);
    assert.ok(r.error, name);
  }
  if (posix) {
    const open = machineOwnersFile('ada');
    chmodSync(open, 0o666);
    assert.match(readMachineOwners(open).error!, /writable by its group or others/);
    assert.equal(isMachineOwner('ada', open), false, 'a file anyone may write names no owner');
  }
});

test('machine changes are refused for an instance-only owner and a disallowed device, for set-slots and set-updates; the break-glass is allowed', () => {
  const owners = machineOwnersFile('ada', 'olu');
  const log = new EventLog(':memory:');
  for (const args of [['set-slots', '4'], ['set-updates', 'on']]) {
    const ask = (requester: Parameters<typeof machineChangeRefusal>[0]) => () => requestMachineChange(log, { args, requester, via: 'settings', ownersFile: owners });
    assert.throws(ask(ownerRequester('ivy')), (e: Error) => e instanceof MachineRequestError && e.status === 403 && /machine owners: @ada, @olu\); @ivy isn't one/.test(e.message), `${args[0]}: instance-only owner`);
    assert.throws(ask({ ...ownerRequester('ada'), deviceOk: false }), /allowed devices/, `${args[0]}: disallowed device`);
    assert.equal(ask(ownerRequester('ada'))().status, 'pending', `${args[0]}: the first machine owner`);
    assert.equal(ask(ownerRequester('OLU'))().status, 'pending', `${args[0]}: the second, any case`);
    // The break-glass: no person, no device, and no owners file at all.
    const glass = requestMachineChange(log, { args, requester: { login: 'example-owner', breakGlass: true, deviceOk: false }, via: 'settings', ownersFile: join(tmpdir(), 'no-such-owners.json') });
    assert.equal(glass.breakGlass, true);
  }
  assert.deepEqual(machineRequests(log.read(0)).map((r) => r.by), ['ada', 'OLU', 'example-owner', 'ada', 'OLU', 'example-owner'], 'only the allowed were recorded');
  // A root step goes through the same gate.
  const step = asks(log).create({ instance: 'site', kind: 'root_step', title: 'Four slots', detail: 'x', command: 'set-slots', args: ['4'] });
  assert.throws(() => requestRootStep(log, step.id, { by: 'ivy', role: 'owner', requester: ownerRequester('ivy'), ownersFile: owners }), /@ivy isn't one/);
  assert.equal(requestRootStep(log, step.id, { by: 'ada', role: 'owner', requester: ownerRequester('ada'), ownersFile: owners }).request.by, 'ada');
});

test('the coordinator refuses a request written straight to the log by someone who is not a machine owner, and runs nothing', () => {
  const owners = machineOwnersFile('ada');
  const log = new EventLog(':memory:');
  log.append('machine.requested', { id: 'forged-1', args: ['set-slots', '9'], by: 'ivy', via: 'settings', ask: null }, 'ivy', 'human');
  log.append('machine.requested', { id: 'forged-2', args: ['set-updates', 'off'], by: 'ivy', via: 'settings', ask: null }, 'ivy', 'human');
  log.append('machine.requested', { id: 'real-1', args: ['set-slots', '3'], by: 'ada', via: 'settings', ask: null }, 'ada', 'human');
  log.append('machine.requested', { id: 'glass-1', args: ['set-slots', '2'], by: 'example-owner', via: 'settings', ask: null, breakGlass: true }, 'example-owner', 'human');
  const calls: string[][] = [];
  assert.equal(runMachineRequests({ log, instance: 'site', ownersFile: owners, exec: (f, a) => (calls.push([f, ...a]), 'ok') }), 2);
  assert.deepEqual(calls.map((c) => c.slice(3).join(' ')), ['set-slots 3', 'set-slots 2'], "only the machine owner's and the break-glass's ran");
  const byId = new Map(machineRequests(log.read(0)).map((r) => [r.id, r]));
  for (const id of ['forged-1', 'forged-2']) {
    assert.equal(byId.get(id)!.status, 'refused', id);
    assert.match(byId.get(id)!.detail, /@ivy isn't one of the machine's owners \(machine owners: @ada\)/);
  }
});

test('dashboards.sh --machine-owner writes the machine owners file root:root 0644, with exactly the logins given', { skip: !posix && 'bash' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'owners-sh-'));
  const bin = join(dir, 'bin');
  const etc = join(dir, 'etc');
  for (const d of [bin, etc]) spawnSync('mkdir', ['-p', d]);
  // chown needs root here; a stand-in records what it was asked to do.
  const chownLog = join(dir, 'chown.log');
  writeFileSync(join(bin, 'chown'), `#!/bin/sh\necho "$*" >> "${chownLog}"\n`);
  chmodSync(join(bin, 'chown'), 0o755);
  const file = join(etc, 'machine-owners.json');
  const run = (csv: string) => spawnSync('bash', ['-c', 'source "$1"; install_machine_owners "$2" "$3"', '_', join(setup, 'lib.sh'), csv, file], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  // umask 0 would leave a fresh file 0666: the mode is set, not inherited.
  const r = spawnSync('bash', ['-c', 'umask 000; source "$1"; install_machine_owners "$2" "$3"', '_', join(setup, 'lib.sh'), 'ada,Olu-2', file], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { owners: ['ada', 'Olu-2'] });
  assert.equal((statSync(file).mode & 0o777).toString(8), '644');
  assert.deepEqual(readFileSync(chownLog, 'utf8').trim().split('\n'), [`root:root ${join(etc, '.machine-owners.json.tmp')}`], 'root:root, on the temp file before it is moved into place');
  assert.deepEqual(machineOwners(file), ['ada', 'Olu-2'], 'the engine reads what the script wrote');
  // A bad list changes nothing.
  for (const bad of ['', 'ada,', 'a;b', '-ada', 'ada,ADA', 'x'.repeat(40), 'ada olu']) {
    const b = run(bad);
    assert.equal(b.status, 2, `${bad}: ${b.stderr}`);
    assert.match(b.stderr, /--machine-owner/);
  }
  assert.deepEqual(machineOwners(file), ['ada', 'Olu-2']);
  // dashboards.sh checks the list before it changes anything, writes it only when given, and names the owners at the end.
  const sh = readFileSync(join(setup, 'dashboards.sh'), 'utf8');
  assert.match(sh, /--machine-owner\) machine_owner="\$\{2:-\}"; machine_owner_set=1; shift 2 ;;/);
  assert.ok(sh.indexOf('machine_owners_json "$machine_owner" >/dev/null || exit 2') < sh.indexOf('ensure_user "$viewer"'), 'validated before anything changes');
  assert.match(sh, /if \[ -n "\$machine_owner_set" \]; then\n[^\n]*\n  install_machine_owners "\$machine_owner"\nfi/);
  const lib = readFileSync(join(setup, 'lib.sh'), 'utf8');
  assert.match(lib, new RegExp(`^MACHINE_OWNERS=${onRealMachine(MACHINE_OWNERS_FILE).replace(/[.]/g, '\\.')}$`, 'm'), "the script's path is the engine's");
});
