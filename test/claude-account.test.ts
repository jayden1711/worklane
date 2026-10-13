// The Claude account switch, the engine's half (src/claude-account.ts): only a machine owner sees the panel; a
// refresh or a switch is a machine request with the same gate as any machine change, one switch at a time; the
// coordinator runs it through the machine helper; the token is taken only while the switch waits for it, from the
// instance it asked, only a setup token, stored for this user only, and never in a response, an event or the audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_ACCOUNT_CREDENTIAL, ClaudeTokenError, claudeAccountView, requestClaudeAccount, storeSwitchToken, switchedOnto, switchView, readSwitchLines, type SwitchLine, type SwitchState } from '../src/claude-account.js';
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

/** A switch's progress file as claude-account.sh writes it, up to a point. */
function switchDir(lines: Partial<SwitchLine>[], from: string | null = 'alpha'): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-account-dir-'));
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const all = [{ step: 'switch', state: 'started', detail: `2 instance(s): alpha beta; the token from ${from ? `the dashboard of ${from}` : 'this terminal'}` }, ...lines];
  writeFileSync(join(dir, 'switch.jsonl'), all.map((l) => JSON.stringify({ at, ...l })).join('\n') + '\n');
  return dir;
}
const WAITING: Partial<SwitchLine>[] = [
  { step: 'pause', state: 'done', instance: 'alpha', detail: 'starts no more runs' },
  { step: 'pause', state: 'done', instance: 'beta', detail: 'starts no more runs' },
  { step: 'token', state: 'ask', detail: "paste the token in alpha's dashboard" },
];

test('switchedOnto: only an instance whose users all got the new token, passed the check and were resumed', () => {
  const user = (n: string, check: SwitchState): Partial<SwitchLine>[] => [
    { step: 'install', state: 'done', instance: n, user: `wl-${n}-agent`, detail: 'stored' },
    { step: 'check', state: check, instance: n, user: `wl-${n}-agent`, detail: check },
  ];
  const ended = (token: SwitchState, alpha: SwitchState, beta: SwitchState) =>
    readSwitchLines(switchDir([...WAITING.slice(0, 2), { step: 'token' as const, state: token, detail: token }, ...(token === 'done' ? [...user('alpha', 'done'), ...user('beta', 'failed')] : []), { step: 'resume' as const, state: alpha, instance: 'alpha', detail: alpha }, { step: 'resume' as const, state: beta, instance: 'beta', detail: beta }, { step: 'switch' as const, state: 'failed' as const, detail: 'not resumed: beta' }]));
  const lines = ended('done', 'done', 'failed');
  assert.match(switchedOnto('alpha', lines) ?? '', /^\d{4}-\d\d-\d\dT/, 'alpha: new login, checked, resumed');
  assert.equal(switchedOnto('beta', lines), null, 'beta: its check failed');
  assert.equal(switchedOnto('gamma', lines), null, 'not in the switch');
  assert.equal(switchedOnto('alpha', ended('failed', 'done', 'done')), null, 'no token: resumed on its current login, so its limit still applies');
  assert.equal(switchedOnto('alpha', readSwitchLines(switchDir(WAITING))), null, 'still running');
});

test('switchView folds the lines per instance and user, and knows when it waits for the token, ended or stalled', () => {
  const v = switchView(readSwitchLines(switchDir(WAITING)))!;
  assert.deepEqual([v.status, v.waitingForToken, v.tokenFrom, v.instances.map((i) => i.name)], ['running', true, 'alpha', ['alpha', 'beta']]);
  const ended = switchView(readSwitchLines(switchDir([...WAITING, { step: 'token', state: 'done', detail: 'received' }, { step: 'check', state: 'failed', instance: 'beta', user: 'wl-beta-agent', detail: 'not logged in' }, { step: 'resume', state: 'failed', instance: 'beta', detail: 'not resumed' }, { step: 'switch', state: 'failed', detail: 'not resumed: beta' }])))!;
  assert.deepEqual([ended.status, ended.waitingForToken, ended.detail], ['failed', false, 'not resumed: beta']);
  assert.deepEqual(ended.instances[1]!.users, [{ user: 'wl-beta-agent', install: null, check: ended.lines[5] }]);
  assert.equal(switchView(readSwitchLines(switchDir(WAITING)), Date.now() + 2 * 3600_000)!.status, 'stalled');
  assert.equal(switchView([]), null);
});

test('a refresh or a switch is a machine request for a machine owner only, on an allowed device; one switch at a time', () => {
  const owners = machineOwnersFile('ada');
  const log = new EventLog(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'claude-account-none-'));
  const ask = (login: string, action: unknown = 'switch', extra: Partial<ReturnType<typeof ownerRequester>> = {}, d = dir) => () => requestClaudeAccount(log, { action, requester: { ...ownerRequester(login), ...extra }, dir: d, ownersFile: owners });
  const refused = (f: () => unknown, status: number, re: RegExp) => assert.throws(f, (e: Error) => e instanceof MachineRequestError && e.status === status && re.test(e.message), re.source);
  refused(ask('ivy'), 403, /@ivy isn't one/);
  refused(ask('ada', 'switch', { deviceOk: false }), 403, /allowed devices/);
  refused(ask('ada', 'rm -rf'), 400, /status or switch/);
  const r = ask('ada')();
  assert.deepEqual([r.args, r.via, r.status], [['claude-account', 'switch'], 'claude-account', 'pending']);
  refused(ask('ada'), 409, /already waiting for the coordinator/);
  assert.equal(ask('ada', 'status')().args[1], 'status', 'a refresh meanwhile is fine');
  log.append('machine.finished', { id: r.id, outcome: 'done', detail: 'started' }, 'alpha', 'coordinator');
  refused(ask('ada', 'switch', {}, switchDir(WAITING)), 409, /switch is running on this machine/);
  // The helper's allowlist has exactly the two.
  assert.ok(checkRootStep('claude-account', ['switch']).allowed && checkRootStep('claude-account', ['status']).allowed);
  for (const a of [[], ['switch', 'x'], ['Switch'], ['--token-from']]) assert.ok(!checkRootStep('claude-account', a).allowed, JSON.stringify(a));
});

test('the coordinator runs the request through the machine helper, and refuses one by someone who is not a machine owner', () => {
  const owners = machineOwnersFile('ada');
  const log = new EventLog(':memory:');
  const calls: string[][] = [];
  log.append('machine.requested', { id: 'mr-aaaaaaaaaaaa', args: ['claude-account', 'switch'], by: 'ada', via: 'claude-account', ask: null }, 'ada', 'human');
  log.append('machine.requested', { id: 'mr-bbbbbbbbbbbb', args: ['claude-account', 'switch'], by: 'ivy', via: 'claude-account', ask: null }, 'ivy', 'human');
  runMachineRequests({ log, instance: 'alpha', ownersFile: owners, exec: (file, args) => (calls.push([file, ...args]), 'started the Claude account switch') });
  assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'claude-account', 'switch']]);
  assert.deepEqual(machineRequests(log.read(0)).map((r) => [r.by, r.status]), [['ada', 'done'], ['ivy', 'refused']]);
});

test('the token is taken only while the switch waits for it from this instance, only a setup token, for this user only', { skip: !posix }, () => {
  const owners = machineOwnersFile('ada');
  const home = mkdtempSync(join(tmpdir(), 'claude-account-home-'));
  const who: { role: 'owner' | 'writer'; requester: ReturnType<typeof ownerRequester> } = { role: 'owner', requester: ownerRequester('ada') };
  const store = (dir: string, value = TOKEN, instance = 'alpha', w = who) => () => storeSwitchToken({ value, instance, who: w, dir, home, ownersFile: owners });
  const refused = (f: () => unknown, status: number, re: RegExp) =>
    assert.throws(f, (e: Error) => {
      assert.ok(!e.message.includes(TOKEN.slice(13)) && !e.message.includes('not-a-token'), 'the value is never in an error');
      return e instanceof ClaudeTokenError && e.status === status && re.test(e.message);
    }, re.source);
  refused(store(mkdtempSync(join(tmpdir(), 'none-'))), 409, /no Claude account switch is waiting/);
  const waiting = switchDir(WAITING);
  refused(store(waiting, TOKEN, 'beta'), 409, /alpha's dashboard, not this one/);
  refused(store(waiting, TOKEN, 'alpha', { role: 'owner', requester: ownerRequester('ivy') }), 403, /@ivy isn't one/);
  refused(store(waiting, TOKEN, 'alpha', { role: 'writer', requester: ownerRequester('ada') }), 403, /only an owner of this instance/);
  refused(store(waiting, `not-a-token-${'x'.repeat(30)}`), 400, /not a token from claude setup-token/);
  const file = store(waiting)();
  assert.equal(file, join(secretsDir('alpha', home), CLAUDE_ACCOUNT_CREDENTIAL));
  assert.equal(readFileSync(file, 'utf8'), TOKEN);
  assert.equal(statSync(file).mode & 0o777, 0o400);
  refused(store(switchDir(WAITING, null)), 409, /the terminal it was started in/);
});

test('the dashboard: the panel is a machine owner\'s only; the token goes nowhere but its file', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-account-dash-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const owners = machineOwnersFile('example-owner');
  const accountDir = switchDir(WAITING, cfg.project.project.name);
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
    const v = JSON.parse(view.text) as { machineOwner: boolean; allowed: boolean; canPasteToken: boolean; status: { users: { account: string; tokenId: string }[] }; switch: { waitingForToken: boolean } };
    assert.deepEqual([v.machineOwner, v.allowed, v.canPasteToken, v.switch.waitingForToken, v.status.users[0]!.account, v.status.users[0]!.tokenId], [true, true, true, true, 'agents@example.com', '0123abcd']);
    // Off an allowed device: sees it, read-only.
    const stale = JSON.parse((await call('/api/claude-account', asPerson('example-owner'))).text) as { allowed: boolean; canPasteToken: boolean };
    assert.deepEqual([stale.allowed, stale.canPasteToken], [false, false]);

    // The token: refused for a writer before its body is read, and for a bad one; stored for a machine owner.
    assert.equal((await call('/api/claude-account/token', asDevicePerson('example-collaborator'), { value: TOKEN })).status, 403);
    const bad = await call('/api/claude-account/token', asDevicePerson('example-owner'), { value: `not-a-token-${'y'.repeat(30)}` });
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes('not-a-token'));
    const ok = await call('/api/claude-account/token', asDevicePerson('example-owner'), { value: TOKEN });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(!ok.text.includes(TOKEN));
    const file = join(secretsDir(cfg.project.project.name, home), CLAUDE_ACCOUNT_CREDENTIAL);
    assert.equal(readFileSync(file, 'utf8'), TOKEN);
    // A switch from the dashboard, recorded for the coordinator.
    const sw = await call('/api/machine/claude-account', asDevicePerson('example-owner'), { action: 'status' });
    assert.equal(sw.status, 200, sw.text);
    const log = new EventLog(eventsDb);
    try {
      const all = JSON.stringify(log.read(0));
      assert.ok(!all.includes(TOKEN.slice(13)), 'the token is in no event, the audit included');
      assert.ok(log.read(0).some((e) => e.type === 'dashboard.audit' && (e.payload as { action: string }).action === 'claude_account.token'));
      assert.deepEqual(machineRequests(log.read(0)).map((r) => r.args), [['claude-account', 'status']]);
    } finally {
      log.close();
    }
    // A writer can't start one.
    assert.equal((await call('/api/machine/claude-account', asDevicePerson('example-collaborator'), { action: 'switch' })).status, 403);
  } finally {
    await d.close();
  }
});

test('the view: a machine owner may switch when nothing runs; anyone else gets nothing to act on', () => {
  const owners = machineOwnersFile('ada');
  const v = claudeAccountView({ dir: mkdtempSync(join(tmpdir(), 'claude-account-empty-')), events: [], who: { role: 'owner', requester: ownerRequester('ada') }, instance: 'alpha', ownersFile: owners });
  assert.deepEqual([v.machineOwner, v.allowed, v.canSwitch, v.status, v.switch], [true, true, true, null, null]);
  const other = claudeAccountView({ dir: switchDir(WAITING), events: [], who: { role: 'owner', requester: ownerRequester('ivy') }, instance: 'alpha', ownersFile: owners });
  assert.deepEqual([other.machineOwner, other.allowed, other.canSwitch, other.canPasteToken], [false, false, false, false]);
});
