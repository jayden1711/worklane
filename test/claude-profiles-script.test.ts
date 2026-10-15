// scripts/setup/claude-account.sh's account profiles (issue #464), with the machine stood in for: sudo (runs the
// command as that user's home), and claude, which reads its login from CLAUDE_CONFIG_DIR as the real one does (else
// ~/.claude). Checked: profile-add installs the token in each agent user's own profile dir and proves it with a real
// call there, and keeps nothing when the API refuses it; use proves the profile with one real call per agent user
// before profiles.json names it active, and changes nothing when a call is refused; remove is refused while a profile
// is active; the token is in no output, file or command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProfileOps, readProfiles } from '../src/claude-profiles.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
const SECRET = `${randomBytes(16).toString('hex')}_new-${randomBytes(6).toString('hex')}`;
const TOKEN = `sk-ant-oat01-${SECRET}`;
const leaked = (text: string) => Array.from({ length: SECRET.length - 7 }, (_, i) => SECRET.slice(i, i + 8)).some((w) => text.includes(w));
const OLD = `sk-ant-oat01-${'O'.repeat(40)}`;

/** Two instances, alpha (agent and eval users) and beta (agent only), each agent user on its old login in ~/.claude. */
function machine() {
  const T = mkdtempSync(join(tmpdir(), 'claude-profiles-'));
  const s = join(T, 'scripts', 'setup');
  mkdirSync(s, { recursive: true });
  copyFileSync(join(setupDir, 'claude-account.sh'), join(s, 'claude-account.sh'));
  for (const d of ['users', 'homes', 'bin', 'var']) mkdirSync(join(T, d), { recursive: true });
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
PATH="$T/bin:$PATH"
as_root() { :; }
home_of() { echo "$T/homes/$1"; }
user_exists() { [ -e "$T/users/$1" ]; }
file_owned_by() { [ -f "$1" ] && [ ! -L "$1" ]; }
MACHINE_SUDOERS="$T/sudoers-machine" HUB_UNIT="$T/hub.service" CLAUDE_ACCOUNT_DIR="$T/var" CLAUDE_ACCOUNT_LOCK="$T/lock" MACHINE_CHANGES="$T/changes.jsonl"
`,
  );
  const exe = (name: string, body: string) => {
    writeFileSync(join(T, 'bin', name), body);
    chmodSync(join(T, 'bin', name), 0o755);
  };
  exe('sudo', `#!/usr/bin/env bash
T=${JSON.stringify(T)}
echo "sudo $*" >> "$T/calls"
[ "$1" = -H ] && shift
[ "$1" = -u ] || exit 64
user="$2"; shift 2
[ "$1" = timeout ] && shift 2
HOME="$T/homes/$user" USER="$user" exec "$@"
`);
  // claude: its login from $CLAUDE_CONFIG_DIR (else ~/.claude). -p (the real call) is refused when refuse-new exists
  // and the login is the new token, or refuse-<user> exists; then a 401 with the token in it, as a leak trap.
  exe('claude', `#!/usr/bin/env node
const fs = require('node:fs');
const T = ${JSON.stringify(T)};
const dir = process.env.CLAUDE_CONFIG_DIR || process.env.HOME + '/.claude';
fs.appendFileSync(T + '/claude-calls', process.env.USER + ' ' + dir + ' ' + process.argv.slice(2).join(' ') + '\\n');
let tok = '';
try { tok = JSON.parse(fs.readFileSync(dir + '/.credentials.json', 'utf8')).claudeAiOauth.accessToken; } catch {}
const ok = /^sk-ant-oat01-/.test(tok);
if (process.argv[2] === '-p') {
  const refused = !ok || (tok.includes('_new-') && fs.existsSync(T + '/refuse-new')) || fs.existsSync(T + '/refuse-' + process.env.USER);
  if (!refused) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })); process.exit(0); }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid bearer token (' + tok + ')' }));
  process.exit(1);
}
process.stdout.write(JSON.stringify(ok ? { loggedIn: true, authMethod: 'claude.ai', email: tok.includes('_new-') ? 'new@example.com' : 'old@example.com', subscriptionType: 'max' } : { loggedIn: false, authMethod: 'none' }));
`);
  const user = (u: string) => {
    writeFileSync(join(T, 'users', u), '');
    const c = join(T, 'homes', u, '.claude');
    mkdirSync(c, { recursive: true, mode: 0o700 });
    writeFileSync(join(c, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: OLD } }), { mode: 0o600 });
  };
  for (const u of ['wl-alpha', 'wl-alpha-agent', 'wl-alpha-eval', 'wl-beta', 'wl-beta-agent']) user(u);
  const inst = join(T, 'homes', 'wl-alpha', '.local', 'state', 'worklane', 'instances', 'alpha');
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(inst, 'instance.yaml'), `version: 1\nname: alpha\nrun_as:\n  agent_user: wl-alpha-agent\n  agent_home: ${T}/homes/wl-alpha-agent\n  eval_user: wl-alpha-eval\n`);
  writeFileSync(join(T, 'sudoers-machine'), 'Cmnd_Alias WORKLANE_MACHINE = x\nwl-alpha, wl-beta ALL=(root) NOPASSWD: WORKLANE_MACHINE\n');
  const run = (args: string[], input = '', env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [join(s, 'claude-account.sh'), ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T, ...env } });
    return { ...r, lines: r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { step: string; state: string; instance?: string; user?: string; detail: string }) };
  };
  const pdir = (u: string, p: string) => join(T, 'homes', u, '.claude-profiles', p);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const outputs = (r: { stdout: string; stderr: string }) => [r.stdout, r.stderr, read(join(T, 'var', 'profile-ops.jsonl')), read(join(T, 'var', 'profiles.json')), read(join(T, 'calls')), read(join(T, 'claude-calls')), read(join(T, 'changes.jsonl'))].join('\n');
  const claudeCalls = () => read(join(T, 'claude-calls')).trim().split('\n').filter(Boolean);
  /** The ops alerts: the machine change log's profile lines. */
  const changes = () => read(join(T, 'changes.jsonl')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { by: string; what: string; from: string; to: string });
  /** A dashboard's pasted token, where the helper's --token-from reads it: the instance coordinator's secrets dir. */
  const pasted = (inst: string, token = TOKEN) => {
    const d = join(T, 'homes', `wl-${inst}`, '.config', `${inst}-secrets`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'claude-profile-token'), token, { mode: 0o400 });
    return join(d, 'claude-profile-token');
  };
  return { T, run, pdir, outputs, claudeCalls, changes, pasted };
}

test('profile-add: the token in each agent user own profile dir (0700/0600), proven by a real call there; the eval user and ~/.claude untouched', { skip: !posix }, () => {
  const m = machine();
  const r = m.run(['profile-add', 'work', '--json'], `${TOKEN}\n`);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(
    r.lines.map((l) => `${l.step} ${l.state}${l.user ? ` ${l.user}` : ''}`),
    ['profile-add started', 'token done', 'install done wl-alpha-agent', 'check done wl-alpha-agent', 'install done wl-beta-agent', 'check done wl-beta-agent', 'profile-add done'],
  );
  for (const u of ['wl-alpha-agent', 'wl-beta-agent']) {
    const d = m.pdir(u, 'work');
    assert.equal(JSON.parse(readFileSync(join(d, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, TOKEN);
    assert.equal(statSync(join(d, '.credentials.json')).mode & 0o777, 0o600);
    assert.equal(statSync(d).mode & 0o777, 0o700);
    assert.equal(statSync(join(m.T, 'homes', u, '.claude-profiles')).mode & 0o777, 0o700);
    // The login it had is as it was.
    assert.equal(JSON.parse(readFileSync(join(m.T, 'homes', u, '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, OLD);
  }
  assert.ok(!existsSync(m.pdir('wl-alpha-eval', 'work')), 'the eval user keeps its own login');
  // The real call ran on the profile's dir, as that user.
  assert.ok(m.claudeCalls().some((c) => c.startsWith(`wl-beta-agent ${m.pdir('wl-beta-agent', 'work')} -p Reply with the single word: ok --model haiku`)));
  const p = readProfiles(join(m.T, 'var'));
  assert.deepEqual(Object.keys(p.profiles), ['work']);
  assert.equal(p.profiles.work!.users['wl-beta-agent']!.account, 'new@example.com');
  assert.equal(p.profiles.work!.users['wl-beta-agent']!.apiOk, true);
  assert.deepEqual(p.active, {}, 'added is not chosen');
  assert.ok(!leaked(m.outputs(r)), 'the token is in no output, file or command line');
  assert.equal(statSync(join(m.T, 'var', 'profiles.json')).mode & 0o777, 0o644);
});

test('profile-add: the API refuses the token for one user, so nothing is kept for any user', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'refuse-wl-beta-agent'), '');
  const r = m.run(['profile-add', 'work', '--json'], `${TOKEN}\n`);
  assert.equal(r.status, 1);
  assert.equal(r.lines.at(-1)!.state, 'failed');
  assert.match(r.lines.at(-1)!.detail, /refused: .*HTTP 401.*Nothing was added/);
  for (const u of ['wl-alpha-agent', 'wl-beta-agent']) assert.ok(!existsSync(m.pdir(u, 'work')), `${u}: removed`);
  assert.deepEqual(readProfiles(join(m.T, 'var')).profiles, {});
  assert.ok(!leaked(m.outputs(r)), "Claude's 401 carried the token: redacted everywhere");
});

test('use at a root shell: a real call on the profile as every agent user, then active; a refused call changes nothing', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run(['profile-add', 'work', '--json'], `${TOKEN}\n`).status, 0);
  const before = m.claudeCalls().length;
  // beta only: one real call, as beta's agent user on beta's profile dir.
  const one = m.run(['use', 'work', 'beta', '--json']);
  assert.equal(one.status, 0, one.stderr + one.stdout);
  const calls = m.claudeCalls().slice(before).filter((c) => c.includes(' -p '));
  assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 2).join(' ')), [`wl-beta-agent ${m.pdir('wl-beta-agent', 'work')}`]);
  let p = readProfiles(join(m.T, 'var'));
  assert.equal(p.active.beta?.profile, 'work');
  assert.equal(p.active.alpha, undefined);
  // Machine-wide, but the API refuses alpha's: refused, and nothing changes (beta stays on work, alpha on default).
  writeFileSync(join(m.T, 'refuse-wl-alpha-agent'), '');
  const all = m.run(['use', 'default', '--json']);
  assert.equal(all.status, 1);
  assert.match(all.lines.at(-1)!.detail, /^refused: wl-alpha-agent: HTTP 401.*Nothing changed/);
  p = readProfiles(join(m.T, 'var'));
  assert.equal(p.active.beta?.profile, 'work', 'the previous profile stays active');
  assert.equal(p.profiles.default?.users['wl-alpha-agent']?.apiOk, false, 'the failed check is recorded');
  rmSync(join(m.T, 'refuse-wl-alpha-agent'));
  assert.equal(m.run(['use', 'default', '--json']).status, 0);
  assert.deepEqual(readProfiles(join(m.T, 'var')).active, {});
  const ops = readProfileOps(join(m.T, 'var'));
  assert.deepEqual(ops.map((o) => [o.op, o.profile, o.status]), [['profile-add', 'work', 'done'], ['use', 'work', 'done'], ['use', 'default', 'failed'], ['use', 'default', 'done']]);
});

test('from a dashboard (--for, --token-from: what the helper passes from SUDO_USER): its own instance only; another instance, or every one, is refused before anything runs', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run(['profile-add', 'work', '--json'], `${TOKEN}\n`).status, 0);
  const before = m.claudeCalls().length;
  for (const args of [['use', 'work', 'beta', '--for', 'alpha'], ['use', 'work', 'beta', '--json', '--for', 'alpha'], ['remove', 'work', 'beta', '--for', 'alpha'], ['use', 'work', '--for', 'alpha', '--token-from', 'beta']]) {
    const r = m.run(args);
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.equal(m.claudeCalls().length, before, 'no call made');
  assert.deepEqual(readProfiles(join(m.T, 'var')).active, {}, 'nothing changed');
  // With no instance named, --for is the instance: alpha alone, never "every instance".
  const own = m.run(['use', 'work', '--json', '--for', 'alpha']);
  assert.equal(own.status, 0, own.stderr);
  assert.deepEqual(readProfiles(join(m.T, 'var')).active, { alpha: { profile: 'work', since: readProfiles(join(m.T, 'var')).active.alpha!.since } });
  assert.deepEqual(m.claudeCalls().slice(before).filter((c) => c.includes(' -p ')).map((c) => c.split(' ')[0]), ['wl-alpha-agent']);
  assert.ok(own.lines.every((l) => (l as { for?: string }).for === 'alpha'));
});

test('profile-add from a dashboard: its own agent user only, STAGED; nothing may use it until a root admin confirms it, seeing the account and typing the name', { skip: !posix }, () => {
  const m = machine();
  const file = m.pasted('alpha');
  const add = m.run(['profile-add', 'work', '--json', '--token-from', 'alpha']);
  assert.equal(add.status, 0, add.stderr + add.stdout);
  assert.ok(!existsSync(file), 'the pasted token file is read once and deleted');
  assert.ok(existsSync(m.pdir('wl-alpha-agent', 'work')));
  assert.ok(!existsSync(m.pdir('wl-beta-agent', 'work')), "never in another instance's agent user");
  let p = readProfiles(join(m.T, 'var'));
  assert.deepEqual([p.profiles.work!.staged, p.profiles.work!.instance, Object.keys(p.profiles.work!.users)], [true, 'alpha', ['wl-alpha-agent']]);
  // Unusable: from its dashboard, and at a root shell too.
  for (const args of [['use', 'work', '--json', '--for', 'alpha'], ['use', 'work', 'alpha', '--json']]) {
    const r = m.run(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.lines.at(-1)!.detail, /staged, not confirmed: an admin confirms it on this machine first/);
  }
  assert.deepEqual(readProfiles(join(m.T, 'var')).active, {});
  // Confirm: never from a dashboard, never as a coordinator user, never without the name typed.
  assert.equal(m.run(['confirm-profile', 'work', '--for', 'alpha'], 'work\n').status, 2);
  assert.equal(m.run(['confirm-profile', 'work'], 'work\n', { SUDO_USER: 'wl-alpha' }).status, 2);
  const wrong = m.run(['confirm-profile', 'work'], 'wokr\n');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /wl-alpha-agent\): Claude account new@example\.com, plan max: the API answered a real call on it/);
  assert.match(wrong.stderr, /the name typed isn't work: nothing was confirmed/);
  assert.equal(readProfiles(join(m.T, 'var')).profiles.work!.staged, true);
  const ok = m.run(['confirm-profile', 'work'], 'work\n');
  assert.equal(ok.status, 0, ok.stderr);
  p = readProfiles(join(m.T, 'var'));
  assert.equal(p.profiles.work!.staged, false);
  assert.equal(m.run(['use', 'work', '--json', '--for', 'alpha']).status, 0);
  assert.equal(readProfiles(join(m.T, 'var')).active.alpha?.profile, 'work');
  // Confirmed once: there is nothing more to confirm.
  assert.equal(m.run(['confirm-profile', 'work'], 'work\n').status, 1);
  assert.ok(!leaked(m.outputs(add)), 'the token is in no output, file, alert or command line');
});

test('a profile the API refuses is never confirmed', { skip: !posix }, () => {
  const m = machine();
  m.pasted('alpha');
  assert.equal(m.run(['profile-add', 'work', '--json', '--token-from', 'alpha']).status, 0);
  writeFileSync(join(m.T, 'refuse-wl-alpha-agent'), '');
  const r = m.run(['confirm-profile', 'work'], 'work\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not confirmed: the API refused it/);
  assert.equal(readProfiles(join(m.T, 'var')).profiles.work!.staged, true);
});

test('remove from a dashboard: only its own agent user\'s copy, of a profile it has, never one any instance uses', { skip: !posix }, () => {
  const m = machine();
  // A root admin's, for every agent user, and in use by beta.
  assert.equal(m.run(['profile-add', 'shared', '--json'], `${TOKEN}\n`).status, 0);
  assert.equal(m.run(['use', 'shared', 'beta', '--json']).status, 0);
  m.pasted('alpha');
  assert.equal(m.run(['profile-add', 'mine', '--json', '--token-from', 'alpha']).status, 0);
  const inUse = m.run(['remove', 'shared', '--json', '--for', 'alpha']);
  assert.equal(inUse.status, 1);
  assert.match(inUse.lines.at(-1)!.detail, /refused: beta use profile shared/);
  assert.equal(m.run(['use', 'default', 'beta', '--json']).status, 0);
  const other = m.run(['remove', 'mine', '--json', '--for', 'beta']);
  assert.equal(other.status, 1, "beta can't remove alpha's");
  assert.match(other.lines.at(-1)!.detail, /isn't one of beta's/);
  assert.ok(existsSync(m.pdir('wl-alpha-agent', 'mine')));
  // A root admin's profile, in use by no one: alpha removes its own agent user's copy, and only that.
  const shared = m.run(['remove', 'shared', '--json', '--for', 'alpha']);
  assert.equal(shared.status, 0, shared.stderr);
  assert.ok(!existsSync(m.pdir('wl-alpha-agent', 'shared')) && existsSync(m.pdir('wl-beta-agent', 'shared')), "beta's copy stays");
  assert.deepEqual(Object.keys(readProfiles(join(m.T, 'var')).profiles.shared!.users), ['wl-beta-agent']);
  const own = m.run(['remove', 'mine', '--json', '--for', 'alpha']);
  assert.equal(own.status, 0, own.stderr);
  assert.ok(!existsSync(m.pdir('wl-alpha-agent', 'mine')));
  assert.equal(readProfiles(join(m.T, 'var')).profiles.mine, undefined);
});

test('every add, confirm, use and remove is an ops alert line (machine change log): names and who asked, the account only after confirm, never the token', { skip: !posix }, () => {
  const m = machine();
  m.pasted('alpha');
  m.run(['profile-add', 'work', '--json', '--token-from', 'alpha']);
  m.run(['confirm-profile', 'work'], 'work\n');
  m.run(['use', 'work', '--json', '--for', 'alpha']);
  m.run(['use', 'default', '--json', '--for', 'alpha']);
  m.run(['remove', 'work', '--json', '--for', 'alpha']);
  m.run(['profile-add', 'spare', '--json'], `${TOKEN}\n`);
  const c = m.changes();
  assert.ok(c.every((x) => x.what === 'claude_account.profile'));
  assert.deepEqual(c.map((x) => [x.by, x.to]), [
    ['wl-alpha', 'staged work for alpha'],
    ['root', 'confirmed work as new@example.com'],
    ['wl-alpha', 'use work for alpha'],
    ['wl-alpha', 'use default for alpha'],
    ['wl-alpha', 'removed work for alpha'],
    ['root', 'added spare'],
  ]);
  assert.ok(!c.slice(0, 1).some((x) => x.to.includes('@')), 'no account before confirm');
  assert.ok(!leaked(JSON.stringify(c)));
});

test('use: a profile never added is refused; remove is refused while active, then removes each user dir as that user', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run(['use', 'nope', '--json']).status, 1);
  assert.equal(m.run(['profile-add', 'work', '--json'], `${TOKEN}\n`).status, 0);
  assert.equal(m.run(['profile-add', 'work', '--json'], `${TOKEN}\n`).status, 1, 'adding it again is refused');
  assert.equal(m.run(['use', 'work', 'alpha', '--json']).status, 0);
  const busy = m.run(['remove', 'work', '--json']);
  assert.equal(busy.status, 1);
  assert.match(busy.lines.at(-1)!.detail, /refused: alpha use profile work/);
  assert.ok(existsSync(m.pdir('wl-alpha-agent', 'work')));
  assert.equal(m.run(['use', 'default', 'alpha', '--json']).status, 0);
  const r = m.run(['remove', 'work', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const u of ['wl-alpha-agent', 'wl-beta-agent']) assert.ok(!existsSync(m.pdir(u, 'work')));
  assert.ok(readFileSync(join(m.T, 'calls'), 'utf8').includes(`sudo -H -u wl-beta-agent rm -rf -- ${m.pdir('wl-beta-agent', 'work')}`), 'removed as the user, never as root');
  assert.deepEqual(Object.keys(readProfiles(join(m.T, 'var')).profiles).filter((n) => n !== 'default'), []);
});

test('names are checked before anything runs', { skip: !posix }, () => {
  const m = machine();
  for (const args of [['profile-add', 'default'], ['remove', 'default'], ['use', 'Work'], ['use', '../x'], ['use', 'work', 'alpha', 'beta'], ['remove', 'work', 'alpha'], ['use', 'work', '--for', 'X']]) {
    const r = m.run(args);
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.ok(!existsSync(join(m.T, 'var', 'profile-ops.jsonl')));
});
