// Add project from the dashboard, the root half: the dashboard records it only for a machine owner freshly signed in
// on an allowed device (src/machine-owners.ts, the same gate as any machine change); the coordinator runs the machine
// helper's add-project and relays each progress line as an add_project.step event, the GitHub clicks as setup-console
// asks. Never the Claude token (issue #711): no paste box takes it, and nothing goes to the script's stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { asks } from '../src/console/asks.js';
import { secretsDir, storeSecret } from '../src/console/secrets.js';
import { runningAddProjects } from '../src/coordinator/add-project.js';
import { runMachineRequests, STALE_CLAIM_MS } from '../src/coordinator/machine-requests.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { MachineRequestError, machineRequests, requestAddProject } from '../src/machine-requests.js';
import type { MachineRequester } from '../src/machine-owners.js';
import { asDevicePerson, asPerson, exampleProject, exampleRoles, ownerRequester, machineOwnersFile } from './helpers.js';

const posix = process.platform !== 'win32';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const TOKEN = `sk-ant-oat01-${'Z'.repeat(40)}`;

test('add-project is refused for an instance-only owner and a disallowed device; two machine owners may each ask; one at a time', () => {
  const owners = machineOwnersFile('ada', 'olu');
  const log = new EventLog(':memory:');
  const ask = (requester: MachineRequester, name: unknown = 'alpha', repo: unknown = 'example/alpha') => () => requestAddProject(log, { name, repo, requester, ownersFile: owners });
  const refused = (f: () => unknown, status: number, re: RegExp, what: string) => assert.throws(f, (e: Error) => e instanceof MachineRequestError && e.status === status && re.test(e.message), what);
  refused(ask({ ...ownerRequester('ivy') }), 403, /machine owners: @ada, @olu\); @ivy isn't one/, 'an instance-only owner');
  refused(ask({ ...ownerRequester('ada'), deviceOk: false }), 403, /allowed devices/, 'a disallowed device');
  refused(ask({ ...ownerRequester('ada') }, 'Alpha'), 400, /the project's name/, 'a bad name');
  refused(ask({ ...ownerRequester('ada') }, 'alpha', 'example/alpha/x'), 400, /a GitHub owner\/name/, 'a bad repo');
  assert.deepEqual(machineRequests(log.read(0)), [], 'nothing recorded for any of them');

  const first = ask({ ...ownerRequester('ada') })();
  assert.deepEqual([first.status, first.by, first.via, first.args], ['pending', 'ada', 'add-project', ['add-project', 'alpha', 'example/alpha']]);
  refused(ask({ ...ownerRequester('olu') }, 'beta', 'example/beta'), 409, /already pending/, 'a second while the first is open');
  log.append('machine.finished', { id: first.id, outcome: 'done', detail: 'added alpha' }, 'site', 'coordinator');
  const second = ask({ ...ownerRequester('OLU') }, 'beta', 'example/beta')();
  assert.deepEqual([second.status, second.by], ['pending', 'OLU'], 'the second machine owner, any case');
});

test('the dashboard records an add-project only for a machine owner on an allowed device, however long ago they signed in', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'add-project-dash-'));
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const owners = machineOwnersFile('olu', 'example-owner');
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: owners, slotsDir: join(dir, 'slots'), machine: { changesPath: join(dir, 'changes.jsonl'), updatesConfigPath: join(dir, 'updates.json'), updatesLogPath: join(dir, 'updates.jsonl') } });
  try {
    const base = d.url.split('/?')[0]!;
    const post = (headers: Record<string, string>, body: unknown = { name: 'alpha', repo: 'example/alpha' }) => fetch(`${base}/api/machine/add-project`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const status = async (r: Promise<Response>) => {
      const x = await r;
      return [x.status, ((await x.json()) as { error?: string }).error ?? ''] as const;
    };
    const [s2, e2] = await status(post(asPerson('example-owner')));
    assert.equal(s2, 403, 'a disallowed device');
    assert.match(e2, /allowed devices/);
    const [s3, e3] = await status(post(asDevicePerson('example-collaborator')));
    assert.equal(s3, 403, 'a writer');
    assert.match(e3, /only the instance's owners/);
    writeFileSync(owners, `${JSON.stringify({ owners: ['olu'] })}\n`);
    const [s4, e4] = await status(post(asDevicePerson('example-owner')));
    assert.equal(s4, 403, 'the instance owner who is not a machine owner');
    assert.match(e4, /@example-owner isn't one/);
    writeFileSync(owners, `${JSON.stringify({ owners: ['olu', 'example-owner'] })}\n`);
    const [s5] = await status(post(asDevicePerson('example-owner'), { name: 'alpha', repo: 'example/alpha; id' }));
    assert.equal(s5, 400);
    // An older hub still sends the sign-in time it used to (x-dashboard-authenticated-at): ignored, however old.
    const ok = await post({ ...asDevicePerson('example-owner'), 'x-dashboard-authenticated-at': String(Date.now() - 6 * DAY) });
    assert.equal(ok.status, 200, 'a sign-in 6 days ago, from an allowed device');
    const r = (await ok.json()) as { request: { args: string[]; status: string } };
    assert.deepEqual([r.request.status, r.request.args], ['pending', ['add-project', 'alpha', 'example/alpha']]);
    const log = new EventLog(eventsDb);
    assert.deepEqual(machineRequests(log.read(0)).map((x) => x.by), ['example-owner'], 'only the allowed one was recorded');
    const audit = log.read(0, ['dashboard.audit']).map((e) => (e.payload as { action: string }).action);
    assert.ok(audit.includes('machine.add_project'), `audited: ${audit.join(', ')}`);
    assert.ok(audit.includes('machine.add_project_refused'), 'the refusals are audited too');
    log.close();
  } finally {
    await d.close();
  }
});

/**
 * The helper as the coordinator starts it, played by a script: the lines an earlier add-project.sh printed, its
 * claude-token step asking for a pasted token and reading stdin, which says what it got there.
 */
const FAKE_HELPER = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ step: 'instance', state: 'started', detail: '' });
out({ step: 'instance', state: 'done', detail: 'users there' });
out({ step: 'app', state: 'started', detail: '' });
out({ step: 'app', state: 'ask', detail: 'Create alpha-app on GitHub', ask: { kind: 'approve_link', title: 'Create alpha-app on GitHub', detail: 'Approve it.', url: 'https://hub.example.test/setup/app-manifest/start/amf-1' } });
out({ step: 'app', state: 'done', detail: 'the App is set up' });
process.stdout.write('not a progress line\\n');
out({ step: 'claude-token', state: 'started', detail: '' });
out({ step: 'claude-token', state: 'ask', detail: 'token', ask: { kind: 'paste_secret', credential: 'claude-token', title: "The Claude login for alpha's agents", detail: 'Paste it.' } });
let got = '';
process.stdin.on('data', (c) => (got += c));
process.stdin.on('end', () => {
  const t = got.trim();
  out({ step: 'claude-token', state: 'done', detail: 'stdin gave ' + t.length + ' characters' });
  out({ step: 'checkout', state: 'started', detail: '' });
  out({ step: 'checkout', state: 'failed', detail: 'the clone was refused', retry: 'sudo bash /opt/x/add-project.sh alpha example/alpha' });
  process.exit(1);
});
`;

test('the coordinator runs add-project through the helper, relays each step, makes the GitHub asks; issue #711: never a paste box for the Claude token, and nothing on the script\'s stdin', { skip: !posix }, async () => {
  const owners = machineOwnersFile('olive');
  const log = new EventLog(':memory:');
  const home = mkdtempSync(join(tmpdir(), 'add-project-home-'));
  const r = requestAddProject(log, { name: 'alpha', repo: 'example/alpha', requester: ownerRequester('olive'), ownersFile: owners });
  const started: string[][] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const fakeSpawn = (file: string, args: string[]) => {
    started.push([file, ...args]);
    const c = spawn(process.execPath, ['-e', FAKE_HELPER, TOKEN], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(c);
    return c;
  };
  try {
    assert.equal(runMachineRequests({ log, ownersFile: owners, instance: 'site', spawn: fakeSpawn }), 1);
    assert.deepEqual(started, [['sudo', '-n', MACHINE_HELPER, 'add-project', 'alpha', 'example/alpha']]);
    const run = runningAddProjects.get(r.id)!;
    assert.ok(run, 'running alongside the ticks');
    // The script's claude-token ask comes, and opens no paste box.
    const asked = () => log.read(0, ['add_project.step']).some((e) => (e.payload as { step: string; state: string }).step === 'claude-token' && (e.payload as { state: string }).state === 'ask');
    for (let i = 0; i < 300 && !asked(); i++) await new Promise((res) => setTimeout(res, 10));
    assert.ok(asked(), 'the step line is relayed');
    assert.deepEqual(asks(log).list({}).filter((a) => a.kind === 'paste_secret'), [], 'no paste_secret ask: no paste box takes the token');
    // A later tick, long after the claim, while it runs: still running, not marked interrupted, not started twice.
    runMachineRequests({ log, ownersFile: owners, instance: 'site', spawn: fakeSpawn, now: () => Date.now() + STALE_CLAIM_MS + MIN });
    assert.equal(started.length, 1);
    await run;
  } finally {
    for (const c of children) c.kill();
  }

  const steps = log.read(0, ['add_project.step']).map((e) => e.payload as { request_id: string; name: string; repo: string; step: string; state: string; detail: string; ask?: string; retry?: string });
  assert.deepEqual(steps.map((s) => `${s.step} ${s.state}`), ['instance started', 'instance done', 'app started', 'app ask', 'app done', 'claude-token started', 'claude-token ask', 'claude-token done', 'checkout started', 'checkout failed']);
  assert.ok(steps.every((s) => s.request_id === r.id && s.name === 'alpha' && s.repo === 'example/alpha'));
  assert.equal(steps.find((s) => s.step === 'claude-token' && s.state === 'done')!.detail, 'stdin gave 0 characters', 'the script\'s stdin is closed at once, nothing written');
  assert.equal(steps.at(-1)!.retry, 'sudo bash /opt/x/add-project.sh alpha example/alpha');
  // The App's link: an approve_link ask, answered once the App step was done, by who asked.
  const appAsk = asks(log).get(steps.find((s) => s.step === 'app' && s.state === 'ask')!.ask!)!;
  assert.equal(appAsk.kind, 'approve_link');
  assert.deepEqual([appAsk.status, appAsk.answer?.answer, appAsk.answer?.by], ['answered', 'approved', 'olive']);
  // The request's outcome names the step and the retry.
  const done = machineRequests(log.read(0)).find((x) => x.id === r.id)!;
  assert.equal(done.status, 'failed');
  assert.equal(done.detail, 'checkout: the clone was refused; retry: sudo bash /opt/x/add-project.sh alpha example/alpha');
  // The token: nowhere in the log, and never stored for this user.
  assert.ok(!JSON.stringify(log.read(0)).includes(TOKEN), 'never in an event');
  assert.ok(!existsSync(join(secretsDir('alpha', home), 'claude-token')), 'nothing stored');
  assert.equal(runningAddProjects.size, 0);
});

test('issue #711: no paste box stores a Claude credential: an ask an earlier version opened for the token is never answered, and a token-shaped secret is refused for any ask', () => {
  const log = new EventLog(':memory:');
  const home = mkdtempSync(join(tmpdir(), 'add-project-secret-'));
  const a = asks(log);
  // As an earlier coordinator opened it, still open in an existing install's log.
  const claude = a.create({ kind: 'paste_secret', instance: 'alpha', title: "The Claude login for alpha's agents", detail: 'Paste the token claude setup-token prints.', credential: 'claude-token', where: "wl-alpha-agent's Claude login" }, 'add-project').id;
  const other = a.create({ kind: 'paste_secret', instance: 'alpha', title: 'A bot token', detail: 'Paste it.', credential: 'discord-token', where: 'the bot' }, 'add-project').id;
  const refused = (id: string, value: string) =>
    assert.throws(() => storeSecret(log, id, { by: 'olive', role: 'owner', value, dir: secretsDir('alpha', home) }), (e: Error) => /never takes one/.test(e.message) && !e.message.includes(value.slice(14)));
  refused(claude, TOKEN);
  refused(claude, `not-a-token-${'x'.repeat(30)}`);
  refused(other, TOKEN);
  refused(other, `${'a'.repeat(24)}#${'b'.repeat(24)}`);
  assert.ok(!existsSync(secretsDir('alpha', home)), 'nothing stored');
  assert.deepEqual([a.get(claude)!.status, a.get(other)!.status], ['open', 'open']);
  // Any other secret, as before.
  storeSecret(log, other, { by: 'olive', role: 'owner', value: 'a-bot-token.with.dots', dir: secretsDir('alpha', home) });
  assert.equal(a.get(other)!.status, 'answered');
});

test('the coordinator refuses an add-project written to the log by someone who is not a machine owner, or with bad arguments, and starts nothing', () => {
  const owners = machineOwnersFile('olive');
  const log = new EventLog(':memory:');
  log.append('machine.requested', { id: 'forged-1', args: ['add-project', 'alpha', 'example/alpha'], by: 'ivy', via: 'add-project', ask: null }, 'ivy', 'human');
  log.append('machine.requested', { id: 'forged-2', args: ['add-project', 'alpha', 'example/alpha; id'], by: 'olive', via: 'add-project', ask: null }, 'olive', 'human');
  log.append('machine.requested', { id: 'forged-3', args: ['add-project', 'alpha'], by: 'olive', via: 'add-project', ask: null }, 'olive', 'human');
  const started: string[][] = [];
  assert.equal(runMachineRequests({ log, ownersFile: owners, instance: 'site', spawn: (f, a) => (started.push([f, ...a]), spawn('true')) as never }), 0);
  assert.deepEqual(started, []);
  assert.deepEqual(machineRequests(log.read(0)).map((x) => x.status), ['refused', 'refused', 'refused']);
});
