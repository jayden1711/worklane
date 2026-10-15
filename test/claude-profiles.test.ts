// The agents' Claude account profiles, the engine's half (src/claude-profiles.ts, issue #464): runs use the instance's
// active profile's dir, read as each run starts; every profile's login file is denied to agent commands; the
// dashboard's routes are a machine owner's on an allowed device only (every other request refused with 403, audited,
// and starting nothing); a step is a machine request the coordinator runs through the helper with exactly its
// arguments; a finished switch is recorded once as account.switched with from, to, by and the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_PROFILE_CREDENTIAL, latestSwitch, profileLogin, profilesTable, readProfileOps, recordProfileSwitches, requestProfileOp, resolveLogin } from '../src/claude-profiles.js';
import { secretsDir } from '../src/console/secrets.js';
import { checkRootStep, profileStepOk } from '../src/console/root-steps.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { MachineRequestError, machineRequests } from '../src/machine-requests.js';
import { CliRunner } from '../src/runner.js';
import { withDeniedReads, sandboxSettings } from '../src/sandbox.js';
import { asDevicePerson, asPerson, exampleProject, exampleRoles, machineOwnersFile, ownerRequester, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const TOKEN = `sk-ant-oat01-${'p'.repeat(24)}_secret-${'q'.repeat(16)}`;
const AGENT = { user: 'wl-alpha-agent', home: '/home/example/wl-alpha-agent' };

function accountDir(profiles: unknown = {}, ops: object[] = []) {
  const d = mkdtempSync(join(tmpdir(), 'claude-profiles-'));
  writeFileSync(join(d, 'profiles.json'), JSON.stringify(profiles));
  writeFileSync(join(d, 'profile-ops.jsonl'), ops.map((o) => JSON.stringify(o)).join('\n'));
  return d;
}
const twoProfiles = (active: Record<string, unknown> = {}) => ({ version: 1, profiles: { work: { kind: 'setup-token', added_at: '2026-10-15T00:00:00Z', users: { 'wl-alpha-agent': { instance: 'alpha', user: 'wl-alpha-agent', account: 'work@example.com', api_ok: true, checked_at: '2026-10-15T00:00:01Z' } } }, personal: { kind: 'setup-token', users: {} } }, active });

test('two profiles for one agent user: the active one is the CLAUDE_CONFIG_DIR its runs use, read when each run starts', () => {
  const dir = accountDir(twoProfiles());
  const login = profileLogin({ instance: 'alpha', agentUser: AGENT.user, dir });
  const runner = new CliRunner('cli', {}, 'claude', AGENT, undefined, undefined, {}, undefined, undefined, login);
  assert.equal(runner.loginOf({}), '/home/example/wl-alpha-agent/.claude', 'no profile chosen: the login it always had');
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(twoProfiles({ alpha: { profile: 'work', since: '2026-10-15T00:00:02Z' } })));
  assert.equal(runner.loginOf({}), '/home/example/wl-alpha-agent/.claude-profiles/work');
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(twoProfiles({ alpha: { profile: 'personal', since: '2026-10-15T00:00:03Z' } })));
  assert.equal(runner.loginOf({}), '/home/example/wl-alpha-agent/.claude-profiles/personal');
  // Another instance's choice, or another user (the eval lane), is never this one's.
  assert.equal(resolveLogin({ user: 'wl-alpha-eval', home: '/home/example/wl-alpha-eval' }, { instance: 'alpha', agentUser: AGENT.user, dir }).claudeConfigDir, undefined);
  assert.equal(resolveLogin(AGENT, { instance: 'beta', agentUser: AGENT.user, dir }).claudeConfigDir, undefined);
  // A staged profile (added from a dashboard, not confirmed by a root admin) is never used, whatever the file says.
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ ...twoProfiles({ alpha: { profile: 'work', since: 'x' } }), profiles: { work: { kind: 'setup-token', users: {}, staged: true, instance: 'alpha' } } }));
  assert.equal(runner.loginOf({}), '/home/example/wl-alpha-agent/.claude');
  // A name that isn't a profile's (a path, say) is never used.
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ active: { alpha: { profile: '../../etc' } } }));
  assert.equal(runner.loginOf({}), '/home/example/wl-alpha-agent/.claude');
  // The engine without the hook: unchanged.
  assert.equal(new CliRunner('cli', {}, 'claude', AGENT).loginOf({}), '/home/example/wl-alpha-agent/.claude');
});

test("every profile's login file is denied to the agent's commands and to Read, whichever profile it runs on", () => {
  const dir = accountDir(twoProfiles({ alpha: { profile: 'work', since: 'x' } }));
  const files = profileLogin({ instance: 'alpha', agentUser: AGENT.user, dir }).credentialFiles(AGENT);
  assert.deepEqual(files.sort(), ['/home/example/wl-alpha-agent/.claude-profiles/personal/.credentials.json', '/home/example/wl-alpha-agent/.claude-profiles/work/.credentials.json', '/home/example/wl-alpha-agent/.claude/.credentials.json']);
  assert.deepEqual(profileLogin({ instance: 'alpha', agentUser: AGENT.user, dir }).credentialFiles({ user: 'wl-alpha-eval', home: '/home/example/e' }), []);
  const s = withDeniedReads(sandboxSettings({ lane: { allowedDomains: [] }, denyRead: ['/srv/x'] }), files);
  for (const f of files) {
    assert.ok(s.sandbox.filesystem.denyRead.includes(f), f);
    assert.ok(s.permissions.deny.includes(`Read(/${f}/**)`) && s.permissions.deny.includes(`Read(/${f})`), f);
  }
  assert.ok(s.sandbox.filesystem.denyRead.includes('/srv/x'), 'the lane keeps its own');
});

test('the switch time a usage-limit pause and a held login go by: the later of an account switch and a profile switch', () => {
  assert.equal(latestSwitch(null, null), null);
  assert.equal(latestSwitch('2026-10-15T01:00:00Z', null), '2026-10-15T01:00:00Z');
  assert.equal(latestSwitch('2026-10-15T01:00:00Z', '2026-10-15T02:00:00Z'), '2026-10-15T02:00:00Z');
  assert.equal(latestSwitch('2026-10-15T03:00:00Z', '2026-10-15T02:00:00Z'), '2026-10-15T03:00:00Z');
});

test('a profile step is a machine request with exactly its arguments, one at a time, run through the helper as such', () => {
  const dir = accountDir();
  const owners = machineOwnersFile('ada');
  const who = { role: 'owner' as const, requester: ownerRequester('ada') };
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'cp-log-')), 'e.db'));
  try {
    for (const [args, why] of [
      [{ action: 'use', profile: 'Work' }, /profile's name/],
      [{ action: 'use', profile: '../x' }, /profile's name/],
      [{ action: 'profile-add', profile: 'default' }, /never added or removed/],
      [{ action: 'remove', profile: 'default' }, /never added or removed/],
      [{ action: 'switch', profile: 'work' }, /profile-add, use or remove/],
    ] as const) assert.throws(() => requestProfileOp(log, { ...args, who, dir, ownersFile: owners }), why, JSON.stringify(args));
    const r = requestProfileOp(log, { action: 'use', profile: 'work', who, dir, ownersFile: owners });
    // No instance: the helper takes the asking coordinator's from sudo.
    assert.deepEqual(r.args, ['claude-account', 'use', 'work']);
    assert.throws(() => requestProfileOp(log, { action: 'remove', profile: 'personal', who, dir, ownersFile: owners }), (e: unknown) => e instanceof MachineRequestError && e.status === 409);
    // The coordinator runs it through the helper: sudo -n <helper> claude-account use work, nothing else.
    const ran: string[][] = [];
    runMachineRequests({ log, instance: 'alpha', ownersFile: owners, exec: (file, a) => (ran.push([file, ...a]), 'started') });
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0]!.slice(0, 2), ['sudo', '-n']);
    assert.deepEqual(ran[0]!.slice(3), ['claude-account', 'use', 'work']);
    assert.equal(machineRequests(log.read(0)).at(-1)!.status, 'done');
  } finally {
    log.close();
  }
});

test("the allowlist and the helper take the same profile steps, and no other", () => {
  const helper = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as { parseClaudeProfile: (a: string[]) => unknown };
  const good = [['profile-add', 'work'], ['remove', 'work'], ['use', 'work'], ['use', 'default']];
  // Never an instance (another one, or "all"), never confirm-profile, never the script's own flags.
  const bad = [['profile-add', 'default'], ['remove', 'default'], ['profile-add'], ['profile-add', 'Work'], ['profile-add', 'work', 'alpha'], ['remove', 'work', 'alpha'], ['use'], ['use', 'work', 'alpha'], ['use', 'default', 'alpha'], ['use', 'work', 'all'], ['use', 'work', 'alpha', 'beta'], ['use', '../x'], ['use', 'work', '--for'], ['use', 'work', '--for', 'beta'], ['use', `w${'x'.repeat(21)}`], ['switch', 'work'], ['confirm-profile', 'work']];
  for (const a of good) {
    assert.ok(profileStepOk(a), JSON.stringify(a));
    assert.ok(checkRootStep('claude-account', a).allowed, JSON.stringify(a));
    assert.ok(helper.parseClaudeProfile(['claude-account', ...a]), JSON.stringify(a));
  }
  for (const a of bad) {
    assert.ok(!profileStepOk(a), JSON.stringify(a));
    assert.ok(!checkRootStep('claude-account', a).allowed, JSON.stringify(a));
    assert.equal(helper.parseClaudeProfile(['claude-account', ...a]), null, JSON.stringify(a));
  }
  // The switch's own two are as they were.
  for (const a of [['status'], ['switch']]) assert.ok(checkRootStep('claude-account', a).allowed);
});

test('a finished switch asked from this dashboard is recorded once as account.switched: from, to, by, the result', () => {
  // Each step after the dashboard's request (recorded below, now).
  const at = new Date(Date.now() + 60_000).toISOString();
  const op = (id: string, profile: string, step: string, state: string, extra: object = {}) => ({ at, id, op: 'use', profile, step, state, for: 'alpha', detail: `${step} ${state}`, ...extra });
  const dir = accountDir({}, [
    op('op-1', 'work', 'use', 'started'),
    op('op-1', 'work', 'check', 'done', { instance: 'alpha', user: 'wl-alpha-agent' }),
    op('op-1', 'work', 'check', 'done', { instance: 'beta', user: 'wl-beta-agent' }),
    op('op-1', 'work', 'use', 'done', { from: { alpha: 'default', beta: 'personal' } }),
    op('op-2', 'personal', 'use', 'started'),
    op('op-2', 'personal', 'check', 'failed', { instance: 'alpha', user: 'wl-alpha-agent' }),
    op('op-2', 'personal', 'use', 'failed', { from: { alpha: 'work' }, detail: 'refused: HTTP 401. Nothing changed' }),
    { ...op('op-3', 'x', 'use', 'started'), for: 'beta' },
    { ...op('op-3', 'x', 'use', 'done'), for: 'beta' },
  ]);
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'cp-log-')), 'e.db'));
  try {
    log.append('machine.requested', { id: 'mr-1', args: ['claude-account', 'use', 'work'], by: 'ada', via: 'claude-account', ask: null }, 'ada', 'human');
    assert.equal(recordProfileSwitches(log, 'alpha', dir), 2);
    assert.equal(recordProfileSwitches(log, 'alpha', dir), 0, 'once');
    const sw = log.read(0, ['account.switched']).map((e) => e.payload as { op: string; to: string; from: Record<string, string>; instances: string[]; by: string; ok: boolean; detail: string });
    assert.deepEqual(sw.map((s) => [s.op, s.to, s.from, s.instances, s.by, s.ok]), [
      ['op-1', 'work', { alpha: 'default', beta: 'personal' }, ['alpha', 'beta'], 'ada', true],
      ['op-2', 'personal', { alpha: 'work' }, ['alpha'], 'terminal', false],
    ]);
    assert.match(sw[1]!.detail, /refused: HTTP 401/);
    assert.deepEqual(readProfileOps(dir).map((o) => o.status), ['done', 'failed', 'done']);
  } finally {
    log.close();
  }
});

test('the accounts × instances table: each instance on its active profile, the last real call on each, default from status.json', () => {
  const dir = accountDir(twoProfiles({ alpha: { profile: 'work', since: 'x' } }));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ at: '2026-10-14T00:00:00Z', users: [{ instance: 'alpha', kind: 'agent', user: 'wl-alpha-agent', logged_in: true, account: 'old@example.com', api_ok: true }, { instance: 'beta', kind: 'agent', user: 'wl-beta-agent', logged_in: true, account: 'old@example.com', api_ok: false, api_error: 'HTTP 401' }, { instance: 'alpha', kind: 'eval', user: 'wl-alpha-eval' }] }));
  const t = profilesTable({ dir });
  assert.deepEqual(t.instances, ['alpha', 'beta']);
  assert.deepEqual(t.active, { alpha: 'work', beta: 'default' });
  assert.deepEqual(t.profiles.map((p) => p.name), ['default', 'personal', 'work']);
  const cell = (p: string, i: string) => t.profiles.find((x) => x.name === p)!.cells.find((c) => c.instance === i)!;
  assert.deepEqual([cell('work', 'alpha').active, cell('work', 'alpha').apiOk, cell('work', 'alpha').account], [true, true, 'work@example.com']);
  assert.deepEqual([cell('default', 'beta').active, cell('default', 'beta').apiOk, cell('default', 'beta').apiError], [true, false, 'HTTP 401']);
  assert.equal(cell('personal', 'beta').apiOk, null, 'never checked');
});

test('the dashboard: only a machine owner on an allowed device starts a profile step; every other request is refused (403), audited, and starts nothing', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-dash-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const instance = cfg.project.project.name;
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const owners = machineOwnersFile('example-owner', 'viewer-person', 'example-collaborator');
  const acct = accountDir();
  const home = mkdtempSync(join(tmpdir(), 'cp-dash-home-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  const d = await startDashboard({ root, cfg, eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: owners, claudeAccountDir: acct, secretsHome: home, slotsDir: join(dir, 'slots') });
  const tokenFile = join(secretsDir(instance, home), CLAUDE_PROFILE_CREDENTIAL);
  try {
    const base = d.url.split('/?')[0]!;
    const call = async (path: string, headers: Record<string, string>, body: unknown) => {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, text: await r.text() };
    };
    const add = (headers: Record<string, string>) => call('/api/claude-account/profile-add?profile=work', headers, { value: TOKEN });
    const use = (headers: Record<string, string>) => call('/api/machine/claude-profile', headers, { action: 'use', profile: 'work' });
    // Another instance, or every one, from this dashboard: refused for anyone, audited, nothing started.
    for (const instance of ['beta', 'all']) {
      const r = await call('/api/machine/claude-profile', asDevicePerson('example-owner'), { action: 'use', profile: 'work', instance });
      assert.equal(r.status, 403, r.text);
      assert.match(r.text, /a root admin's on the machine/);
    }
    const refusedBy = new Map<string, Record<string, string>>([
      // A writer, and a viewer (both machine owners by the file: the instance role is checked too).
      ['writer', asDevicePerson('example-collaborator')],
      ['viewer', asDevicePerson('viewer-person')],
      // A machine owner on a device the console doesn't allow.
      ['machine owner, disallowed device', asPerson('example-owner')],
      // No session: the key through a proxy, no person named (and so no break-glass).
      ['no session', { 'x-forwarded-for': '192.0.2.9' }],
    ]);
    const audits = () => {
      const log = new EventLog(eventsDb);
      try {
        return log.read(0).filter((e) => e.type === 'dashboard.audit' || e.type === 'claude_account.refused');
      } finally {
        log.close();
      }
    };
    const requests = () => {
      const log = new EventLog(eventsDb);
      try {
        return machineRequests(log.read(0));
      } finally {
        log.close();
      }
    };
    for (const [who, headers] of refusedBy) {
      for (const send of [add, use]) {
        const before = audits().length;
        const r = await send(headers);
        assert.equal(r.status, 403, `${who}: ${r.text}`);
        assert.ok(!r.text.includes(TOKEN.slice(13)));
        assert.equal(audits().length, before + 1, `${who}: audited`);
        assert.equal(requests().length, 0, `${who}: nothing started`);
        assert.ok(!existsSync(tokenFile), `${who}: no token stored`);
      }
    }
    // An owner of this instance who isn't one of the machine's owners, on an allowed device.
    writeFileSync(owners, `${JSON.stringify({ owners: ['someone-else'] })}\n`);
    for (const send of [add, use]) {
      const before = audits().length;
      assert.equal((await send(asDevicePerson('example-owner'))).status, 403, 'instance-only owner');
      assert.equal(audits().length, before + 1);
      assert.equal(requests().length, 0);
      assert.ok(!existsSync(tokenFile));
    }
    // A machine owner on an allowed device: the token stored for the coordinator user only, and the step recorded.
    writeFileSync(owners, `${JSON.stringify({ owners: ['example-owner'] })}\n`);
    const ok = await add(asDevicePerson('example-owner'));
    assert.equal(ok.status, 200, ok.text);
    assert.ok(existsSync(tokenFile));
    assert.deepEqual(requests().map((r) => [r.args, r.by]), [[['claude-account', 'profile-add', 'work'], 'example-owner']]);
    // One at a time: the next is refused while that one waits, and its token isn't kept.
    const busy = await use(asDevicePerson('example-owner'));
    assert.equal(busy.status, 409, busy.text);
    const log = new EventLog(eventsDb);
    try {
      assert.ok(!JSON.stringify(log.read(0)).includes(TOKEN.slice(13)), 'the token is in no event, the audit included');
      assert.ok(log.read(0).some((e) => e.type === 'dashboard.audit' && (e.payload as { action: string }).action === 'machine.claude_profile'));
    } finally {
      log.close();
    }
  } finally {
    await d.close();
  }
});

test('the ops alert: each profile change in the machine change log is an alert for a day; a staged one says how to confirm or remove it; never more than the line says', async () => {
  const { profileFindings } = await import('../src/watchdog/probes.js');
  const now = Date.parse('2026-10-15T12:00:00Z');
  const line = (at: string, by: string, to: string) => ({ at, by, what: 'claude_account.profile', from: '', to });
  const f = profileFindings([line('2026-10-15T11:00:00Z', 'wl-alpha', 'staged work for alpha'), line('2026-10-15T11:05:00Z', 'root', 'confirmed work as a@example.com'), line('2026-10-13T11:00:00Z', 'wl-alpha', 'use work for alpha'), { at: '2026-10-15T11:00:00Z', by: 'root', what: 'set-slots', from: 1, to: 2 }], now);
  assert.deepEqual(f.map((x) => [x.kind, x.instance]), [['claude_profile_changed', 'alpha'], ['claude_profile_changed', null]]);
  assert.match(f[0]!.detail, /staged work for alpha, by wl-alpha \(instance alpha's dashboard\).*Staged: nothing may use it/);
  assert.match(f[0]!.fix, /confirm-profile work.*remove work/);
  assert.match(f[1]!.detail, /confirmed work as a@example\.com/);
});
