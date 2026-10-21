// lint-test
// Issue #736: the engine no longer manages Claude subscription accounts. Account profiles, failover between them and
// the whole-login switch are gone; one person signs the agent user in to `claude` themselves (or the instance uses an
// API key). Checked here: the dashboard route and the machine helper's verbs are gone; what an older install left is
// ignored, never used to pick a login (an instance whose runs were on another profile doesn't start, and says why and
// what to do); every leftover profile dir stays on each run's denied reads; doctor and the Machine page name the
// leftovers and the root step that removes them; and nothing in the engine writes a setup token but the two root-shell
// installs of one login (credentials.sh and add-project.sh). Each import is dynamic, so that against an engine without
// #736 each test fails on its own assertions, not the file on a missing module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { machineRequests } from '../src/machine-requests.js';
import { CliRunner } from '../src/runner.js';
import { sandboxSettings, withDeniedReads } from '../src/sandbox.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile, ownerRequester, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const AGENT = { user: 'wl-alpha-agent', home: '/home/example/wl-alpha-agent' };
const REMOVED = [
  ['claude-account', 'use', 'work'],
  ['claude-account', 'use', 'default'],
  ['claude-account', 'remove', 'work'],
  ['claude-account', 'failover', 'default+work', 'back'],
  ['claude-account', 'failover', 'off', 'stay'],
  ['claude-account', 'profile-add', 'work'],
  ['claude-account', 'login', 'work'],
  ['claude-account', 'switch'],
];

/** A claude-account dir as an older engine left it: alpha on profile work, beta on default, failover set for beta. */
function leftovers(o: { active?: Record<string, unknown>; raw?: string; files?: string[] } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'claude-account-left-'));
  const profiles = { version: 1, profiles: { work: { kind: 'setup-token', users: { [AGENT.user]: { instance: 'alpha', user: AGENT.user, account: 'work@example.com', api_ok: true } } } }, active: o.active ?? { alpha: { profile: 'work', since: '2026-10-15T00:00:00Z' } }, failover: { instances: { beta: { order: ['default', 'work'], back: true } } } };
  writeFileSync(join(d, 'profiles.json'), o.raw ?? JSON.stringify(profiles));
  for (const f of o.files ?? []) writeFileSync(join(d, f), '');
  return d;
}

test('the machine helper refuses every removed claude-account verb; only status is left, through the helper and the coordinator alike', async () => {
  const h = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as { parseClaudeAccount: (a: string[]) => unknown; parseClaudeProfile: (a: string[]) => unknown; parseClaudeFailover: (a: string[]) => unknown; parse: (a: string[]) => unknown; needsUnit: (a: string[]) => boolean };
  for (const a of REMOVED) {
    for (const [name, f] of Object.entries({ parseClaudeAccount: h.parseClaudeAccount, parseClaudeProfile: h.parseClaudeProfile, parseClaudeFailover: h.parseClaudeFailover, parse: h.parse })) assert.equal(f(a), null, `${name}(${a.join(' ')})`);
    assert.equal(h.needsUnit(a), false, `needsUnit(${a.join(' ')})`);
  }
  assert.equal(h.parseClaudeAccount(['claude-account', 'status']), 'status', 'status stays');
  // The coordinator's side: the root-step allowlist takes status only, and no profile step reaches the helper.
  const { checkRootStep, ROOT_STEPS } = await import('../src/console/root-steps.js');
  const rule = ROOT_STEPS.find((s) => s.command === 'claude-account')!;
  assert.equal(rule.allows(['status']), true);
  for (const a of REMOVED) assert.equal(rule.allows(a.slice(1)), false, a.join(' '));
  for (const a of REMOVED) assert.equal(checkRootStep(a[0]!, a.slice(1)).allowed, false, `checkRootStep(${a.join(' ')}) refuses it`);
  const { claudeProfile } = (await import('../src/machine.js')) as unknown as { claudeProfile?: (a: readonly string[], exec: (cmd: string, args: readonly string[]) => unknown) => { ok: boolean } };
  if (claudeProfile) {
    const calls: string[][] = [];
    const r = claudeProfile(['use', 'work'], (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    });
    assert.equal(r.ok, false, 'refused');
    assert.deepEqual(calls, [], 'the helper is never run');
  }
});

test('the claude-profile route is gone: 404 for every action, nothing recorded; the routes that once took a credential still answer 410', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-accounts-retired-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const acct = leftovers();
  // A relayed sign-in an earlier version left waiting: its link is never shown.
  writeFileSync(join(acct, 'login-url'), 'https://claude.ai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s\n');
  const d = await startDashboard({ root, cfg, eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: machineOwnersFile('example-owner'), claudeAccountDir: acct, secretsHome: join(dir, 'home'), slotsDir: join(dir, 'slots') });
  try {
    const base = d.url.split('/?')[0]!;
    // A machine owner who owns the instance, on an allowed device: everyone the route ever let through.
    const headers = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asDevicePerson('example-owner') };
    for (const body of [{ action: 'use', profile: 'work' }, { action: 'use', profile: 'default' }, { action: 'remove', profile: 'work' }, { action: 'failover', order: ['default', 'work'], back: true }, { action: 'failover', order: null, back: false }, { action: 'login', profile: 'work' }]) {
      const r = await fetch(`${base}/api/machine/claude-profile`, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(r.status, 404, `${JSON.stringify(body)}: ${await r.text()}`);
    }
    for (const path of ['/api/claude-account/token', '/api/claude-account/profile-add', '/api/claude-account/login-code']) assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers, body: '{}' })).status, 410, path);
    const view = await (await fetch(`${base}/api/claude-account`, { headers })).text();
    assert.ok(!view.includes('oauth/authorize'), 'no sign-in link');
    assert.ok(!/"profiles"|"profileOps"|"switch"/.test(view), `no profile table, profile steps or switch: ${view.slice(0, 400)}`);
    const log = new EventLog(eventsDb);
    try {
      assert.deepEqual(machineRequests(log.read(0)), [], 'nothing asked of the machine');
    } finally {
      log.close();
    }
  } finally {
    await d.close();
  }
});

test("leftover state never picks a login: a run's login is its user's own dir, whatever the machine's profiles.json says", { skip: !posix }, async () => {
  const { retiredLogin } = await import('../src/claude-accounts-retired.js');
  const { CLAUDE_ACCOUNT_DIR } = await import('../src/claude-account.js');
  // What an older engine wrote to put alpha's runs on profile work: the file it read as each run started.
  mkdirSync(CLAUDE_ACCOUNT_DIR, { recursive: true });
  writeFileSync(join(CLAUDE_ACCOUNT_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: { work: { kind: 'setup-token', users: {} } }, active: { alpha: { profile: 'work', since: 'x' } } }));
  const login = retiredLogin({ agentUser: AGENT.user });
  const runner = new CliRunner('cli', {}, 'claude', AGENT, undefined, undefined, {}, undefined, undefined, login);
  assert.equal(runner.loginOf({}), '/home/example/wl-alpha-agent/.claude');
  assert.deepEqual(login.resolve(AGENT), AGENT, 'the user as it is: no CLAUDE_CONFIG_DIR of a profile');
  const own = { ...AGENT, claudeConfigDir: '/srv/alpha/claude' };
  assert.deepEqual(login.resolve(own), own, "instance.yaml's claude_config_dir stays the login");
  assert.equal(new CliRunner('cli', {}, 'claude', own, undefined, undefined, {}, undefined, undefined, login).loginOf({}), '/srv/alpha/claude');
  // A switch time an older engine left ends no usage-limit pause: the coordinator's hook always hears "never".
  const { accountSwitchedAt } = await import('../src/claude-accounts-retired.js');
  writeFileSync(join(CLAUDE_ACCOUNT_DIR, 'profiles.json'), JSON.stringify({ switched_at: { alpha: new Date().toISOString() } }));
  writeFileSync(join(CLAUDE_ACCOUNT_DIR, 'switch.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), step: 'switch', state: 'done', detail: 'x' })}\n`);
  assert.equal(accountSwitchedAt('alpha'), null);
});

test("every profile dir left on disk stays on each run's denied reads (the whole ~/.claude-profiles, whatever its names), with the user's own login file", async () => {
  const { retiredLogin } = await import('../src/claude-accounts-retired.js');
  const files = retiredLogin({ agentUser: AGENT.user }).credentialFiles(AGENT);
  assert.deepEqual([...files].sort(), ['/home/example/wl-alpha-agent/.claude-profiles', '/home/example/wl-alpha-agent/.claude/.credentials.json']);
  // Another user of the instance (the eval lane): its own home's profile dir too, never the agent's.
  assert.deepEqual(retiredLogin({ agentUser: AGENT.user }).credentialFiles({ user: 'wl-alpha-eval', home: '/home/example/e' }), ['/home/example/e/.claude-profiles']);
  const s = withDeniedReads(sandboxSettings({ lane: { allowedDomains: [] }, denyRead: ['/srv/x'] }), files);
  for (const f of files) {
    assert.ok(s.sandbox.filesystem.denyRead.includes(f), f);
    assert.ok(s.permissions.deny.includes(`Read(/${f}/**)`) && s.permissions.deny.includes(`Read(/${f})`), f);
  }
  assert.ok(s.permissions.deny.includes('Read(//home/example/wl-alpha-agent/.claude-profiles/**)'), 'a profile named in no file is under it');
});

test('an instance whose runs were on another profile at upgrade starts no run, and says why and what to do; one on default starts, with a warning', async () => {
  const { retiredAccountGate, retiredAccountWarning, UNINSTALL_ACCOUNTS } = await import('../src/claude-accounts-retired.js');
  const dir = leftovers({ files: ['switch.jsonl', 'profile-ops.jsonl'] });
  const why = retiredAccountGate('alpha', dir);
  assert.ok(why, 'alpha is refused');
  assert.match(why!, /profile "?work"?/);
  assert.match(why!, /removed/);
  assert.ok(why!.includes(UNINSTALL_ACCOUNTS), 'names the root step');
  assert.match(why!, /claude auth login/, 'and how its agent user signs in');
  assert.match(why!, /api-key/, 'or an API key');
  assert.equal(retiredAccountGate('beta', dir), null, 'beta was on default: it starts');
  assert.match(retiredAccountWarning(dir) ?? '', /ignored/);
  assert.ok((retiredAccountWarning(dir) ?? '').includes(UNINSTALL_ACCOUNTS));
  // Unsure is no: a profiles.json that can't be read refuses every instance.
  const garbled = leftovers({ raw: '{"active": {"alpha": ' });
  for (const n of ['alpha', 'beta']) assert.match(retiredAccountGate(n, garbled) ?? '', /can't be read/, n);
  // Nothing left: nothing said.
  const clean = mkdtempSync(join(tmpdir(), 'claude-account-clean-'));
  writeFileSync(join(clean, 'status.json'), '{"at":"x","users":[]}');
  assert.equal(retiredAccountGate('alpha', clean), null);
  assert.equal(retiredAccountWarning(clean), null);
  assert.equal(retiredAccountGate('alpha', join(clean, 'no-such-dir')), null);
});

test("the instance's start refuses it, before its config is loaded, on the machine's own claude-account dir", { skip: !posix }, async (t) => {
  const { CLAUDE_ACCOUNT_DIR } = await import('../src/claude-account.js');
  mkdirSync(CLAUDE_ACCOUNT_DIR, { recursive: true });
  writeFileSync(join(CLAUDE_ACCOUNT_DIR, 'profiles.json'), JSON.stringify({ active: { retiredgate: { profile: 'work', since: 'x' } } }));
  // A failover notice an older engine left open: nothing would ever close it now, so the start does.
  const { raiseIncident, readIncidents } = await import('../src/watchdog/incidents.js');
  const { FAILOVER_INCIDENT } = await import('../src/usage-limit.js');
  raiseIncident(FAILOVER_INCIDENT, 'retiredgate', 'moved to account work', 'nothing to do', { instance: 'retiredgate' });
  const said: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => void said.push(a.join(' ')));
  const { runInstanceCoordinator } = await import('../src/service.js');
  assert.equal(await runInstanceCoordinator('retiredgate', { once: true }), 1);
  assert.match(said.join('\n'), /^instance retiredgate not started: .*profile "?work"?/m);
  assert.ok(readIncidents().incidents.filter((x) => x.kind === FAILOVER_INCIDENT && x.key === 'retiredgate').every((x) => x.resolvedAt), 'the old failover notice is closed');
});

test('a failover notice an older engine left is info: it never colours an instance status, and its post says Notice', async () => {
  const { FAILOVER_INCIDENT } = await import('../src/usage-limit.js');
  const { healthStatus, KINDS } = await import('../src/watchdog/incidents.js');
  const { postText } = await import('../src/watchdog/post.js');
  assert.equal(KINDS[FAILOVER_INCIDENT as keyof typeof KINDS].severity, 'info');
  const x = { id: 'x', kind: FAILOVER_INCIDENT, key: 'alpha', instance: 'alpha', severity: 'info' as const, title: 't', detail: 'd', fix: 'f', tried: [], since: 'a', lastSeen: 'a', resolvedAt: null, posted: {} };
  assert.equal(healthStatus([x], 'alpha'), 'green');
  assert.match(postText(x, 'raised'), /^\*\*Notice\*\* on instance alpha/);
});

test("the ops alert an older engine's profile changes left in the machine change log: an alert for a day, never more than the line says", async () => {
  const { profileFindings } = await import('../src/watchdog/probes.js');
  const now = Date.parse('2026-10-15T12:00:00Z');
  const line = (at: string, by: string, to: string) => ({ at, by, what: 'claude_account.profile', from: '', to });
  const f = profileFindings([line('2026-10-15T11:00:00Z', 'wl-alpha', 'staged work for alpha'), line('2026-10-15T11:05:00Z', 'root', 'confirmed work as a@example.com'), line('2026-10-13T11:00:00Z', 'wl-alpha', 'use work for alpha'), { at: '2026-10-15T11:00:00Z', by: 'root', what: 'set-slots', from: 1, to: 2 }], now);
  assert.deepEqual(f.map((x) => [x.kind, x.instance]), [['claude_profile_changed', 'alpha'], ['claude_profile_changed', null]]);
  assert.match(f[0]!.detail, /staged work for alpha, by wl-alpha \(instance alpha's dashboard\)/);
  assert.match(f[1]!.detail, /confirmed work as a@example\.com/);
  // What it says to do names no removed command.
  for (const x of f) assert.doesNotMatch(x.fix, /confirm-profile|remove work|Machine page/, x.fix);
  assert.match(f[0]!.fix, /claude-account\.sh uninstall/);
});

test('doctor names every leftover file and the root step that removes them: a failure while an instance is refused, else a warning', async () => {
  const { claudeAccountLeftoverCheck, UNINSTALL_ACCOUNTS } = await import('../src/claude-accounts-retired.js');
  const blocked = claudeAccountLeftoverCheck(leftovers({ files: ['switch.jsonl', 'paused'] }));
  assert.equal(blocked?.level, 'fail');
  for (const s of ['profiles.json', 'switch.jsonl', 'paused', 'alpha', UNINSTALL_ACCOUNTS]) assert.ok(blocked!.detail.includes(s), s);
  const warn = claudeAccountLeftoverCheck(leftovers({ active: {} }));
  assert.equal(warn?.level, 'warn');
  assert.ok(warn!.detail.includes('profiles.json') && warn!.detail.includes(UNINSTALL_ACCOUNTS));
  assert.match(warn!.detail, /failover/, 'a failover setting left is named as ignored');
  assert.equal(claudeAccountLeftoverCheck(mkdtempSync(join(tmpdir(), 'claude-account-none-'))), null);
});

test("the Machine page's Claude account panel names the leftovers, the instances refused and the root step; and how an agent user signs in", async () => {
  const { claudeAccountView } = await import('../src/claude-account.js');
  const { UNINSTALL_ACCOUNTS } = await import('../src/claude-accounts-retired.js');
  const owners = machineOwnersFile('ada');
  const v = claudeAccountView({ dir: leftovers({ files: ['switch.jsonl'] }), events: [], who: { role: 'owner', requester: ownerRequester('ada') }, instance: 'alpha', ownersFile: owners }) as unknown as { retired?: { files: string[]; refused: string[]; command: string } | null; switch?: unknown; signin?: string };
  assert.deepEqual(v.retired?.files.sort(), ['profiles.json', 'switch.jsonl']);
  assert.deepEqual(v.retired?.refused, ['alpha']);
  assert.equal(v.retired?.command, UNINSTALL_ACCOUNTS);
  assert.equal('switch' in v, false, 'no switch is followed any more');
  assert.match(v.signin ?? '', /^sudo -u .+ -i claude auth login$/);
});

test('nothing in the engine writes a setup token but the two root-shell installs of one login (credentials.sh <name> claude, add-project.sh); claude-account.sh has none', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(repoRoot, 'src'));
  walk(join(repoRoot, 'scripts'));
  const rel = (p: string) => relative(repoRoot, p).replaceAll('\\', '/');
  // The one function that writes a Claude login (lib.sh), and who calls it.
  const callers = files.filter((f) => /(^|[^\w])install_claude_token\s+"/m.test(readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(callers, ['scripts/setup/add-project.sh', 'scripts/setup/credentials.sh']);
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'claude-account.sh'), 'utf8');
  assert.doesNotMatch(sh, /install_claude_token|restore_claude_credentials|setup-token|\.claude-profiles\/\$/, 'claude-account.sh takes, writes and puts back no login');
  // No engine source names a token file of a profile or a switch, or the old profile and switch modules.
  for (const f of files.filter((p) => p.endsWith('.ts'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /claude-profiles\.js|claude-failover\.js|claude-profiles-routes\.js/, rel(f));
  for (const gone of ['claude-profiles.ts', 'claude-profiles-routes.ts', 'claude-failover.ts']) assert.ok(!existsSync(join(repoRoot, 'src', gone)), gone);
});
