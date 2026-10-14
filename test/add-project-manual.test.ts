// Add project on a machine whose sudo is older than 1.9.10: machine-helper.sh leaves the add-project rule out (sudo
// would read its pattern as literal text) and records that in helper-rules.json. The dashboard then never offers a
// button that could only fail at sudo: it shows the root command, with the name and repo filled in. And when a run
// does fail at sudo (a machine set up before the record existed), the failure says what to run instead.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProjectManual, addProjectView } from '../src/console/add-project.js';
import { loadConfig } from '../src/config/load.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { ADD_PROJECT_SCRIPT, addProjectCommand, helperRules, MACHINE_HELPER } from '../src/machine.js';
import { machineRequests, requestAddProject } from '../src/machine-requests.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile, ownerRequester } from './helpers.js';

const posix = process.platform !== 'win32';

/** helper-rules.json as machine-helper.sh writes it, for a sudo of this version. */
function rules(sudo: string, leftOut: string[]) {
  const f = join(mkdtempSync(join(tmpdir(), 'helper-rules-')), 'helper-rules.json');
  writeFileSync(f, `${JSON.stringify({ sudo, patterns_min: '1.9.10', left_out: leftOut })}\n`);
  return f;
}
const OLD = () => rules('1.9.9', ['add-project', 'stage-update-signer', 'discard-update-signer']);
const NEW = () => rules('1.9.15', []);

test('the record: an older sudo\'s left-out commands are read; a newer one, or no record at all, leaves add-project to the helper', () => {
  assert.deepEqual(helperRules(OLD()), { sudo: '1.9.9', leftOut: ['add-project', 'stage-update-signer', 'discard-update-signer'] });
  assert.equal(addProjectManual({ helperRulesFile: NEW() }), null);
  assert.equal(addProjectManual({ helperRulesFile: join(tmpdir(), 'no-such-helper-rules.json') }), null);
  const m = addProjectManual({ helperRulesFile: OLD() })!;
  assert.match(m.why, /this machine's sudo \(1\.9\.9\) is older than 1\.9\.10, so the machine helper's add-project rule isn't installed and the dashboard can't run it: run it at a root shell on the machine/);
  assert.equal(m.script, '/opt/worklane/current/scripts/setup/add-project.sh');
  assert.equal(ADD_PROJECT_SCRIPT, m.script);
  assert.equal(addProjectCommand('shop', 'example/shop'), 'sudo bash /opt/worklane/current/scripts/setup/add-project.sh shop example/shop');
  assert.equal(addProjectCommand(), 'sudo bash /opt/worklane/current/scripts/setup/add-project.sh <name> <owner/repo>');
});

test('on an older sudo the Add project view offers no submit: it says why and carries the root command, for a machine owner and anyone else alike', () => {
  const ownersFile = machineOwnersFile('example-owner');
  const v = addProjectView([], { role: 'owner', requester: ownerRequester('example-owner') }, { ownersFile, helperRulesFile: OLD() });
  assert.equal(v.allowed, false);
  assert.match(v.why!, /older than 1\.9\.10/);
  assert.deepEqual(v.manual, { sudo: '1.9.9', why: v.why, script: ADD_PROJECT_SCRIPT });
  // On 1.9.10 or later, as before: allowed for a machine owner, no manual command.
  const ok = addProjectView([], { role: 'owner', requester: ownerRequester('example-owner') }, { ownersFile, helperRulesFile: NEW() });
  assert.deepEqual([ok.allowed, ok.manual], [true, null]);
});

test('on an older sudo the server refuses the submit itself (no request the coordinator could only fail), naming the root command with the name and repo filled in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'add-project-manual-'));
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: machineOwnersFile('example-owner'), slotsDir: join(dir, 'slots'), machine: { helperRulesPath: OLD() } });
  try {
    const base = d.url.split('/?')[0]!;
    const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asDevicePerson('example-owner') };
    const view = (await (await fetch(`${base}/api/add-project`, { headers: h })).json()) as { allowed: boolean; manual: { script: string } | null };
    assert.deepEqual([view.allowed, view.manual?.script], [false, ADD_PROJECT_SCRIPT]);
    const r = await fetch(`${base}/api/machine/add-project`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'shop', repo: 'example/shop' }) });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /older than 1\.9\.10.*: sudo bash \/opt\/worklane\/current\/scripts\/setup\/add-project\.sh shop example\/shop$/);
    const log = new EventLog(eventsDb);
    try {
      assert.deepEqual(machineRequests(log.read(0)), [], 'nothing recorded for the coordinator');
    } finally {
      log.close();
    }
  } finally {
    await d.close();
  }
});

test('a run sudo refuses (a machine set up before the record) fails saying what to run instead, with the name and repo', { skip: !posix }, async () => {
  const owners = machineOwnersFile('olive');
  const log = new EventLog(':memory:');
  const r = requestAddProject(log, { name: 'alpha', repo: 'example/alpha', requester: ownerRequester('olive'), ownersFile: owners });
  // sudo -n with no rule for these arguments: one line on stderr, exit 1.
  const refusing = () => spawn(process.execPath, ['-e', "process.stderr.write('sudo: a password is required\\n'); process.exit(1)"], { stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(runMachineRequests({ log, ownersFile: owners, instance: 'site', spawn: refusing, home: mkdtempSync(join(tmpdir(), 'home-')), pollMs: 20 }), 1);
  let done = machineRequests(log.read(0)).find((x) => x.id === r.id)!;
  for (let i = 0; i < 300 && done.status === 'running'; i++) {
    await new Promise((res) => setTimeout(res, 10));
    done = machineRequests(log.read(0)).find((x) => x.id === r.id)!;
  }
  assert.equal(done.status, 'failed');
  assert.equal(done.detail, `${MACHINE_HELPER} add-project exited 1: sudo: a password is required; sudo won't run the machine helper's add-project here, so run it at a root shell on the machine: sudo bash /opt/worklane/current/scripts/setup/add-project.sh alpha example/alpha`);
});
