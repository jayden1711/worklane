// The Claude account panel, the engine's half (src/claude-account.ts): only a machine owner sees it; a refresh is a
// machine request with the same gate as any machine change; the coordinator runs it through the machine helper. The
// engine manages no Claude account (#736) and never takes a Claude credential (issue #711): neither a switch request
// nor the token route exists, and a switch an older engine left is not followed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAccountView, requestClaudeAccount } from '../src/claude-account.js';
import { secretsDir } from '../src/console/secrets.js';
import { checkRootStep } from '../src/console/root-steps.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { MachineRequestError, machineRequests } from '../src/machine-requests.js';
import { asDevicePerson, asPerson, exampleProject, exampleRoles, ownerRequester, machineOwnersFile } from './helpers.js';

const posix = process.platform !== 'win32';
const TOKEN = `sk-ant-oat01-${'T'.repeat(40)}`;

/** A claude-account dir as an older engine left it: a switch waiting at a root shell for its token. */
function switchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-account-dir-'));
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const lines = [{ step: 'switch', state: 'started', detail: '2 instance(s): alpha beta' }, { step: 'pause', state: 'done', instance: 'alpha', detail: 'starts no more runs' }, { step: 'token', state: 'ask', detail: 'paste the token' }];
  writeFileSync(join(dir, 'switch.jsonl'), lines.map((l) => JSON.stringify({ at, ...l })).join('\n') + '\n');
  return dir;
}

test('a refresh is a machine request for a machine owner only, on an allowed device; one at a time', () => {
  const owners = machineOwnersFile('ada');
  const log = new EventLog(':memory:');
  const ask = (login: string, action: unknown = 'status', extra: Partial<ReturnType<typeof ownerRequester>> = {}) => () => requestClaudeAccount(log, { action, requester: { ...ownerRequester(login), ...extra }, ownersFile: owners });
  const refused = (f: () => unknown, status: number, re: RegExp) => assert.throws(f, (e: Error) => e instanceof MachineRequestError && e.status === status && re.test(e.message), re.source);
  refused(ask('ivy'), 403, /@ivy isn't one/);
  refused(ask('ada', 'status', { deviceOk: false }), 403, /allowed devices/);
  refused(ask('ada', 'rm -rf'), 400, /action is status/);
  const r = ask('ada')();
  assert.deepEqual([r.args, r.via, r.status], [['claude-account', 'status'], 'claude-account', 'pending']);
  refused(ask('ada'), 409, /already waiting for the coordinator/);
  // The helper's allowlist has status, and never switch.
  assert.ok(checkRootStep('claude-account', ['status']).allowed);
  for (const a of [[], ['switch'], ['switch', 'x'], ['Switch'], ['--token-from']]) assert.ok(!checkRootStep('claude-account', a).allowed, JSON.stringify(a));
});

test('issue #711: a switch is never asked for from a dashboard: it takes a Claude credential, a root admin\'s at a root shell', () => {
  const owners = machineOwnersFile('ada');
  const log = new EventLog(':memory:');
  assert.throws(
    () => requestClaudeAccount(log, { action: 'switch', requester: ownerRequester('ada'), ownersFile: owners }),
    (e: Error) => e instanceof MachineRequestError && e.status === 400 && /action is status; the engine manages no Claude account/.test(e.message),
  );
  assert.deepEqual(machineRequests(log.read(0)), [], 'nothing recorded');
  // A switch an earlier version recorded, still pending when the engine was updated: the coordinator refuses it,
  // and never runs the helper.
  const calls: string[][] = [];
  log.append('machine.requested', { id: 'mr-aaaaaaaaaaaa', args: ['claude-account', 'switch'], by: 'ada', via: 'claude-account', ask: null }, 'ada', 'human');
  runMachineRequests({ log, instance: 'alpha', ownersFile: owners, exec: (file, args) => (calls.push([file, ...args]), 'ran') });
  assert.deepEqual(calls, []);
  assert.deepEqual(machineRequests(log.read(0)).map((r) => [r.args[1], r.status]), [['switch', 'refused']]);
});

test('the coordinator runs the refresh through the machine helper, and refuses one by someone who is not a machine owner', () => {
  const owners = machineOwnersFile('ada');
  const log = new EventLog(':memory:');
  const calls: string[][] = [];
  log.append('machine.requested', { id: 'mr-aaaaaaaaaaaa', args: ['claude-account', 'status'], by: 'ada', via: 'claude-account', ask: null }, 'ada', 'human');
  log.append('machine.requested', { id: 'mr-bbbbbbbbbbbb', args: ['claude-account', 'status'], by: 'ivy', via: 'claude-account', ask: null }, 'ivy', 'human');
  runMachineRequests({ log, instance: 'alpha', ownersFile: owners, exec: (file, args) => (calls.push([file, ...args]), '{"users":[]}') });
  assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'claude-account', 'status']]);
  assert.deepEqual(machineRequests(log.read(0)).map((r) => [r.by, r.status]), [['ada', 'done'], ['ivy', 'refused']]);
});

test('the dashboard: the panel is a machine owner\'s only; the old token route is gone and stores nothing', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-account-dash-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const owners = machineOwnersFile('example-owner');
  const accountDir = switchDir();
  writeFileSync(join(accountDir, 'status.json'), JSON.stringify({ at: '2026-10-13T00:00:00Z', users: [{ instance: 'alpha', kind: 'agent', user: 'wl-alpha-agent', stored: true, logged_in: true, auth_method: 'claude.ai', account: 'agents@example.com', token_id: '0123abcd', expires_at: '2027-10-13T00:00:00.000Z' }] }));
  const home = mkdtempSync(join(tmpdir(), 'claude-account-dash-home-'));
  const d = await startDashboard({ root, cfg, eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: owners, claudeAccountDir: accountDir, secretsHome: home, slotsDir: join(dir, 'slots') });
  try {
    const base = d.url.split('/?')[0]!;
    const call = async (path: string, headers: Record<string, string>, body?: unknown) => {
      const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, text: await r.text() };
    };
    // Hidden from a writer and from an instance owner who isn't a machine owner.
    assert.equal((await call('/api/claude-account', asPerson('example-collaborator'))).status, 403);
    writeFileSync(owners, `${JSON.stringify({ owners: ['olu'] })}\n`);
    assert.equal((await call('/api/claude-account', asPerson('example-owner'))).status, 403);
    writeFileSync(owners, `${JSON.stringify({ owners: ['example-owner'] })}\n`);
    const view = await call('/api/claude-account', asDevicePerson('example-owner'));
    assert.equal(view.status, 200);
    const v = JSON.parse(view.text) as { machineOwner: boolean; allowed: boolean; canPasteToken?: boolean; status: { users: { account: string; tokenId: string }[] }; switch?: unknown; retired: { files: string[] } | null };
    assert.deepEqual([v.machineOwner, v.allowed, v.status.users[0]!.account, v.status.users[0]!.tokenId], [true, true, 'agents@example.com', '0123abcd']);
    assert.equal(v.canPasteToken, undefined, 'never a paste box');
    // #736: a switch an older engine left waiting for its token is not followed: only named as a leftover.
    assert.equal(v.switch, undefined);
    assert.deepEqual(v.retired?.files, ['switch.jsonl']);

    // Issue #711: the token route is gone (410) for everyone, a machine owner on an allowed device included, and its
    // body is never read: nothing is stored, audited or recorded.
    for (const who of [asDevicePerson('example-owner'), asDevicePerson('example-collaborator'), {}]) {
      const r = await call('/api/claude-account/token', who, { value: TOKEN });
      assert.equal(r.status, 410, r.text);
      assert.ok(!r.text.includes(TOKEN.slice(13)));
    }
    assert.ok(!existsSync(secretsDir(cfg.project.project.name, home)) || readdirSync(secretsDir(cfg.project.project.name, home)).length === 0, 'nothing stored');
    // A switch is refused; a refresh is recorded for the coordinator.
    const sw = await call('/api/machine/claude-account', asDevicePerson('example-owner'), { action: 'switch' });
    assert.equal(sw.status, 400, sw.text);
    const st = await call('/api/machine/claude-account', asDevicePerson('example-owner'), { action: 'status' });
    assert.equal(st.status, 200, st.text);
    const log = new EventLog(eventsDb);
    try {
      const all = JSON.stringify(log.read(0));
      assert.ok(!all.includes(TOKEN.slice(13)), 'the token is in no event, the audit included');
      assert.ok(!log.read(0).some((e) => e.type === 'dashboard.audit' && (e.payload as { action: string }).action === 'claude_account.token'));
      assert.deepEqual(machineRequests(log.read(0)).map((r) => r.args), [['claude-account', 'status']]);
    } finally {
      log.close();
    }
    // A writer can't ask for anything.
    assert.equal((await call('/api/machine/claude-account', asDevicePerson('example-collaborator'), { action: 'status' })).status, 403);
  } finally {
    await d.close();
  }
});

test('the view: a machine owner may act; anyone else gets nothing to act on; nothing offers a paste box', () => {
  const owners = machineOwnersFile('ada');
  const v = claudeAccountView({ dir: mkdtempSync(join(tmpdir(), 'claude-account-empty-')), events: [], who: { role: 'owner', requester: ownerRequester('ada') }, instance: 'alpha', ownersFile: owners });
  assert.deepEqual([v.machineOwner, v.allowed, v.status, v.retired], [true, true, null, null]);
  const other = claudeAccountView({ dir: switchDir(), events: [], who: { role: 'owner', requester: ownerRequester('ivy') }, instance: 'alpha', ownersFile: owners });
  assert.deepEqual([other.machineOwner, other.allowed], [false, false]);
  for (const x of [v, other]) assert.ok(!('canPasteToken' in x) && !('canSwitch' in x), 'nothing to paste a token into, nor a switch to start');
});
