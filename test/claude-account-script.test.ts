// scripts/setup/claude-account.sh, with the machine stood in for (the real one runs in CI's "add-project (real
// systemd)" job): stand-ins for sudo (it runs the command with that user's home), systemctl (units that drain a few
// polls after SIGTERM, or never) and claude (signed in when its user's credentials hold a setup token). The real
// install_claude_token writes each user's login. Checked: the pause and the wait with its timeout, the token for every
// agent and eval user at 0600 and in no output, `claude auth status` as each user, an instance whose check fails left
// paused, the rerun, the token from a dashboard, and status.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAccountStatus, readSwitchLines, switchView } from '../src/claude-account.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
// Random, so that any part of it showing up anywhere is a leak, not a coincidence.
const SECRET = `${randomBytes(16).toString('hex')}_new-${randomBytes(6).toString('hex')}`;
const TOKEN = `sk-ant-oat01-${SECRET}`;
/** Whether any 8 characters of the token's secret part are in this text. */
const leaked = (text: string) => Array.from({ length: SECRET.length - 7 }, (_, i) => SECRET.slice(i, i + 8)).some((w) => text.includes(w));
const OLD = `sk-ant-oat01-${'O'.repeat(40)}`;

interface Line {
  step: string;
  state: string;
  instance?: string;
  user?: string;
  detail: string;
}

/**
 * Two instances: alpha (agent and eval users, named in its instance.yaml) and beta (agent only, no run_as: the default
 * wl-beta-agent), both in the machine helper's rule, both running. Every agent user starts on the old login.
 */
function machine() {
  const T = mkdtempSync(join(tmpdir(), 'claude-account-'));
  const s = join(T, 'scripts', 'setup');
  mkdirSync(s, { recursive: true });
  copyFileSync(join(setupDir, 'claude-account.sh'), join(s, 'claude-account.sh'));
  for (const d of ['users', 'homes', 'bin', 'units', 'var']) mkdirSync(join(T, d), { recursive: true });
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
PATH="$T/bin:$PATH"
as_root() { :; }
home_of() { echo "$T/homes/$1"; }
user_exists() { [ -e "$T/users/$1" ]; }
unit_active() { systemctl is-active -q "$1"; }
# The files here are this test's: only the link check is left (find -user would need the real users).
file_owned_by() { [ -f "$1" ] && [ ! -L "$1" ]; }
MACHINE_SUDOERS="$T/sudoers-machine" HUB_UNIT="$T/hub.service" CLAUDE_ACCOUNT_DIR="$T/var" CLAUDE_ACCOUNT_LOCK="$T/lock"
MINUTE=1 SWITCH_POLL=0.05
`,
  );
  const exe = (name: string, body: string) => {
    writeFileSync(join(T, 'bin', name), body);
    chmodSync(join(T, 'bin', name), 0o755);
  };
  // sudo -H -u <user> <command...>: the command, with that user's home; a leading `timeout <n>` dropped (macOS has none).
  exe('sudo', `#!/usr/bin/env bash
T=${JSON.stringify(T)}
echo "sudo $*" >> "$T/calls"
[ "$1" = -H ] && shift
[ "$1" = -u ] || exit 64
user="$2"; shift 2
[ "$1" = timeout ] && shift 2
HOME="$T/homes/$user" USER="$user" exec "$@"
`);
  // systemctl: a unit is active while units/<unit>.active exists. SIGTERM to its main process drains it: inactive after
  // 3 more polls, or never when units/<unit>.stuck exists.
  exe('systemctl', `#!/usr/bin/env bash
T=${JSON.stringify(T)}
echo "systemctl $*" >> "$T/calls"
u="\${@: -1}"; a="$T/units/$u.active"; d="$T/units/$u.drain"
case "$1" in
  is-active)
    [ -e "$a" ] || exit 3
    if [ -e "$d" ]; then n="$(cat "$d")"; if [ "$n" -le 1 ]; then rm -f "$a" "$d"; exit 3; fi; echo $((n - 1)) > "$d"; fi
    exit 0 ;;
  kill) [ -e "$a" ] || exit 1; if [ -e "$T/units/$u.stuck" ]; then echo 999999 > "$d"; else echo 3 > "$d"; fi ;;
  stop) rm -f "$a" "$d" ;;
  start) [ -e "$T/units/$u.nostart" ] && exit 1; touch "$a" ;;
  *) exit 64 ;;
esac
`);
  // claude auth status --json: signed in when this user's credentials hold a setup token, unless fail-auth-<user> exists.
  exe('claude', `#!/usr/bin/env node
const fs = require('node:fs');
const T = ${JSON.stringify(T)};
fs.appendFileSync(T + '/claude-calls', process.env.USER + ' ' + process.argv.slice(2).join(' ') + '\\n');
let tok = '';
try { tok = JSON.parse(fs.readFileSync(process.env.HOME + '/.claude/.credentials.json', 'utf8')).claudeAiOauth.accessToken; } catch {}
const ok = /^sk-ant-oat01-/.test(tok) && !fs.existsSync(T + '/fail-auth-' + process.env.USER);
process.stdout.write(JSON.stringify(ok ? { loggedIn: true, authMethod: 'claude.ai', email: tok.includes('_new-') ? 'new@example.com' : 'old@example.com', orgName: 'Example', subscriptionType: 'max' } : { loggedIn: false, authMethod: 'none' }, null, 2));
`);
  const user = (u: string) => {
    writeFileSync(join(T, 'users', u), '');
    const c = join(T, 'homes', u, '.claude');
    mkdirSync(c, { recursive: true, mode: 0o700 });
    writeFileSync(join(c, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: OLD, expiresAt: Date.now() + 86_400_000 }, other: 1 }), { mode: 0o600 });
  };
  for (const u of ['wl-alpha', 'wl-alpha-agent', 'wl-alpha-eval', 'wl-beta', 'wl-beta-agent']) user(u);
  const inst = join(T, 'homes', 'wl-alpha', '.local', 'state', 'worklane', 'instances', 'alpha');
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(inst, 'instance.yaml'), `version: 1\nname: alpha\nrepos:\n  - path: /srv/worklane/alpha/a\n    repo: example/alpha\nrun_as:\n  agent_user: wl-alpha-agent\n  agent_home: ${T}/homes/wl-alpha-agent\n  eval_user: wl-alpha-eval\n`);
  writeFileSync(join(T, 'sudoers-machine'), 'Cmnd_Alias WORKLANE_MACHINE = x\nwl-alpha, wl-beta ALL=(root) NOPASSWD: WORKLANE_MACHINE\n');
  for (const u of ['worklane-alpha.service', 'worklane-beta.service']) writeFileSync(join(T, 'units', `${u}.active`), '');
  const run = (args: string[], input = `${TOKEN}\n`) => {
    const r = spawnSync('bash', [join(s, 'claude-account.sh'), ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T } });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { ...r, lines, events: args.includes('--json') && args[0] === 'switch' ? lines.map((l) => JSON.parse(l) as Line) : [] };
  };
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n') : []);
  const cred = (u: string) => join(T, 'homes', u, '.claude', '.credentials.json');
  const active = (n: string) => existsSync(join(T, 'units', `worklane-${n}.service.active`));
  /** Everything the switch wrote or printed, to scan for the token. */
  const outputs = (r: { stdout: string; stderr: string }) => [r.stdout, r.stderr, ...['switch.jsonl', 'status.json', 'paused'].map((f) => (existsSync(join(T, 'var', f)) ? readFileSync(join(T, 'var', f), 'utf8') : '')), ...calls()].join('\n');
  return { T, s, run, calls, cred, active, outputs };
}

const AGENTS = ['wl-alpha-agent', 'wl-alpha-eval', 'wl-beta-agent'];

test('switch pauses every instance, installs the token for each agent and eval user at 0600, checks each as that user, and resumes', { skip: !posix }, () => {
  const m = machine();
  const r = m.run(['switch', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // In order: pause each, the token, each instance's runs finished, install and check each user, resume each.
  const steps = r.events.map((e) => `${e.step} ${e.state}${e.instance ? ` ${e.instance}` : ''}${e.user ? ` ${e.user}` : ''}`);
  assert.deepEqual(steps, [
    'switch started',
    'pause done alpha',
    'pause done beta',
    'token ask',
    'token done',
    'wait done alpha',
    'wait done beta',
    'install done alpha wl-alpha-agent',
    'check done alpha wl-alpha-agent',
    'install done alpha wl-alpha-eval',
    'check done alpha wl-alpha-eval',
    'install done beta wl-beta-agent',
    'check done beta wl-beta-agent',
    'resume done alpha',
    'resume done beta',
    'switch done',
  ]);
  // Paused by SIGTERM to the coordinator's main process (its runs finish), never `systemctl stop`; then started again.
  const sys = m.calls().filter((c) => c.startsWith('systemctl ') && !c.includes('is-active'));
  assert.deepEqual(sys, ['systemctl kill --kill-whom=main --signal=SIGTERM worklane-alpha.service', 'systemctl kill --kill-whom=main --signal=SIGTERM worklane-beta.service', 'systemctl start worklane-alpha.service', 'systemctl start worklane-beta.service']);
  assert.match(r.events.find((e) => e.step === 'wait' && e.instance === 'alpha')!.detail, /its runs have finished/);
  assert.ok(m.active('alpha') && m.active('beta'));
  for (const u of AGENTS) {
    const c = JSON.parse(readFileSync(m.cred(u), 'utf8')) as { claudeAiOauth: { accessToken: string; expiresAt: number }; other: number };
    assert.equal(c.claudeAiOauth.accessToken, TOKEN, u);
    assert.equal(c.other, 1, `${u}: the file's other entries kept`);
    assert.ok(c.claudeAiOauth.expiresAt > Date.now() + 300 * 86_400_000, `${u}: a year`);
    assert.equal(statSync(m.cred(u)).mode & 0o777, 0o600, `${u}: 0600`);
    assert.equal(statSync(join(m.T, 'homes', u, '.claude')).mode & 0o777, 0o700, `${u}: ~/.claude 0700`);
  }
  // claude auth status, as each user.
  assert.deepEqual(readFileSync(join(m.T, 'claude-calls'), 'utf8').trim().split('\n').slice(0, 3), AGENTS.map((u) => `${u} auth status --json`));
  assert.match(r.events.find((e) => e.step === 'check' && e.user === 'wl-beta-agent')!.detail, /signed in as new@example\.com \(claude\.ai\)/);
  // The token is in no output, no progress line, no status, and no command line (it goes through stdin).
  assert.ok(!leaked(m.outputs(r)), 'the token is never echoed');
  // status.json: each user on the new login, with its token id and expiry; nothing paused.
  const st = readAccountStatus(join(m.T, 'var'))!;
  assert.deepEqual(st.users.map((u) => [u.instance, u.kind, u.user, u.loggedIn, u.account]), [
    ['alpha', 'agent', 'wl-alpha-agent', true, 'new@example.com'],
    ['alpha', 'eval', 'wl-alpha-eval', true, 'new@example.com'],
    ['beta', 'agent', 'wl-beta-agent', true, 'new@example.com'],
  ]);
  assert.equal(new Set(st.users.map((u) => u.tokenId)).size, 1, 'one login: one token id');
  assert.match(st.users[0]!.tokenId!, /^[0-9a-f]{8}$/);
  assert.equal(readFileSync(join(m.T, 'var', 'paused'), 'utf8'), '');
  for (const f of ['switch.jsonl', 'status.json', 'paused']) assert.equal(statSync(join(m.T, 'var', f)).mode & 0o777, 0o644, f);
  // The engine folds the same lines into the dashboard's step view.
  const v = switchView(readSwitchLines(join(m.T, 'var')))!;
  assert.deepEqual([v.status, v.waitingForToken, v.tokenFrom], ['done', false, null]);
  assert.deepEqual(v.instances.map((i) => [i.name, i.users.map((u) => u.user), i.resume?.state]), [['alpha', ['wl-alpha-agent', 'wl-alpha-eval'], 'done'], ['beta', ['wl-beta-agent'], 'done']]);
});

test('the wait has a timeout: an instance whose runs are still going is stopped then, and still switched', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'units', 'worklane-beta.service.stuck'), '');
  const t0 = Date.now();
  const r = m.run(['switch', '--json', '--timeout', '3']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(Date.now() - t0 < 20_000, 'it gave up at the timeout');
  assert.match(r.events.find((e) => e.step === 'wait' && e.instance === 'beta')!.detail, /still running after 3 min: stopped/);
  assert.match(r.events.find((e) => e.step === 'wait' && e.instance === 'alpha')!.detail, /its runs have finished/);
  const sys = m.calls().filter((c) => /^systemctl (stop|start)/.test(c));
  assert.deepEqual(sys, ['systemctl stop worklane-beta.service', 'systemctl start worklane-alpha.service', 'systemctl start worklane-beta.service'], 'only the one that timed out was stopped');
  assert.ok(m.active('beta'));
});

test('an instance whose check fails is not resumed; the rerun resumes it once it passes', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'fail-auth-wl-beta-agent'), '');
  const r = m.run(['switch', '--json']);
  assert.equal(r.status, 1);
  assert.match(r.events.find((e) => e.step === 'check' && e.user === 'wl-beta-agent')!.detail, /not logged in/);
  const resume = r.events.filter((e) => e.step === 'resume').map((e) => [e.instance, e.state]);
  assert.deepEqual(resume, [['alpha', 'done'], ['beta', 'failed']]);
  assert.match(r.events.find((e) => e.step === 'resume' && e.instance === 'beta')!.detail, /not resumed: its auth check failed\. Fix it, then rerun: sudo bash .*claude-account\.sh switch/);
  assert.equal(r.events.at(-1)!.state, 'failed');
  assert.ok(m.active('alpha') && !m.active('beta'), 'beta stays paused');
  assert.ok(!m.calls().includes('systemctl start worklane-beta.service'));
  assert.equal(readFileSync(join(m.T, 'var', 'paused'), 'utf8'), 'beta\n', 'remembered for the rerun');

  // Fixed; the rerun knows beta as its own (paused by the last switch) and resumes it; alpha is paused and resumed again.
  rmSync(join(m.T, 'fail-auth-wl-beta-agent'));
  const again = m.run(['switch', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.events.find((e) => e.step === 'pause' && e.instance === 'beta')!.detail, /paused by an earlier switch/);
  assert.deepEqual(again.events.filter((e) => e.step === 'resume').map((e) => [e.instance, e.state]), [['alpha', 'done'], ['beta', 'done']]);
  assert.ok(m.active('alpha') && m.active('beta'));
  assert.equal(readFileSync(join(m.T, 'var', 'paused'), 'utf8'), '');
  for (const u of AGENTS) assert.equal((JSON.parse(readFileSync(m.cred(u), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken, TOKEN);
  assert.ok(!leaked(m.outputs(again)));
});

test('an instance stopped before the switch gets the token but is left stopped', { skip: !posix }, () => {
  const m = machine();
  rmSync(join(m.T, 'units', 'worklane-beta.service.active'));
  const r = m.run(['switch', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.events.find((e) => e.step === 'pause' && e.instance === 'beta')!.state, 'skipped');
  assert.equal(r.events.find((e) => e.step === 'resume' && e.instance === 'beta')!.state, 'skipped');
  assert.ok(!m.active('beta') && m.active('alpha'));
  assert.equal((JSON.parse(readFileSync(m.cred('wl-beta-agent'), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken, TOKEN);
});

test('no token, or not one from claude setup-token: nothing is installed, and each instance resumes on its current login', { skip: !posix }, () => {
  for (const input of ['', `not-a-token-${'x'.repeat(30)}\n`]) {
    const m = machine();
    const before = AGENTS.map((u) => readFileSync(m.cred(u), 'utf8'));
    const r = m.run(['switch', '--json'], input);
    assert.equal(r.status, 1, JSON.stringify(input));
    assert.equal(r.events.find((e) => e.step === 'token' && e.state !== 'ask')!.state, 'failed');
    assert.ok(!r.events.some((e) => e.step === 'install'), 'no install');
    assert.deepEqual(AGENTS.map((u) => readFileSync(m.cred(u), 'utf8')), before, 'every login as it was');
    assert.deepEqual(r.events.filter((e) => e.step === 'resume').map((e) => e.state), ['done', 'done'], 'resumed on the old login, which passes');
    if (input) assert.ok(!m.outputs(r).includes(input.trim()), 'a wrong paste is not echoed either');
  }
});

test("from the dashboard: the token is taken from the asking instance's secrets, once, and a link is refused", { skip: !posix }, () => {
  const m = machine();
  const dir = join(m.T, 'homes', 'wl-alpha', '.config', 'alpha-secrets');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude-account-token'), TOKEN, { mode: 0o400 });
  const r = m.run(['switch', '--json', '--token-from', 'alpha'], '');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.events.find((e) => e.step === 'token' && e.state === 'ask')!.detail, /in alpha's dashboard/);
  assert.ok(!existsSync(join(dir, 'claude-account-token')), 'deleted once read');
  assert.equal((JSON.parse(readFileSync(m.cred('wl-beta-agent'), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken, TOKEN);
  assert.equal(switchView(readSwitchLines(join(m.T, 'var')))!.tokenFrom, 'alpha');
  assert.ok(!leaked(m.outputs(r)));

  // A link in its place (to a file root can read) is never read; nothing pasted in time: the switch resumes, unchanged.
  const m2 = machine();
  const dir2 = join(m2.T, 'homes', 'wl-alpha', '.config', 'alpha-secrets');
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(m2.T, 'elsewhere'), TOKEN);
  symlinkSync(join(m2.T, 'elsewhere'), join(dir2, 'claude-account-token'));
  const r2 = m2.run(['switch', '--json', '--token-from', 'alpha'], '');
  assert.equal(r2.status, 1);
  assert.equal(r2.events.find((e) => e.step === 'token' && e.state !== 'ask')!.state, 'failed');
  assert.equal((JSON.parse(readFileSync(m2.cred('wl-beta-agent'), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken, OLD);
  const m3 = machine();
  const r3 = m3.run(['switch', '--json', '--token-from', 'alpha', '--token-timeout', '1'], '');
  assert.equal(r3.status, 1);
  assert.match(r3.events.find((e) => e.step === 'token' && e.state === 'failed')!.detail, /no token came/);
  assert.ok(m3.active('alpha') && m3.active('beta'));
});

test('status names each agent user\'s account, token id and expiry, and fails while one is signed out', { skip: !posix }, () => {
  const m = machine();
  const r = m.run(['status']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.lines.length, 3);
  assert.match(r.lines[0]!, /^alpha +wl-alpha-agent +signed in +old@example\.com \(Example\) +token [0-9a-f]{8} +expires \d{4}-\d\d-\d\d$/);
  assert.match(r.lines[2]!, /^beta +wl-beta-agent +signed in/);
  writeFileSync(join(m.T, 'fail-auth-wl-alpha-eval'), '');
  const j = m.run(['status', '--json']);
  assert.equal(j.status, 1);
  const users = (JSON.parse(j.stdout) as { users: { user: string; logged_in: boolean; error: string | null; token_id: string }[] }).users;
  assert.deepEqual(users.map((u) => [u.user, u.logged_in]), [['wl-alpha-agent', true], ['wl-alpha-eval', false], ['wl-beta-agent', true]]);
  assert.match(users[1]!.error!, /not logged in/);
  assert.equal(readAccountStatus(join(m.T, 'var'))!.users.length, 3, 'written for the dashboard');
  assert.ok(!m.outputs(j).includes(OLD), 'never the token');
  assert.deepEqual(m.calls().filter((c) => c.startsWith('systemctl') && !c.includes('is-active')), [], 'status pauses nothing');
});

test("status <instance>: only that instance's records are found again; every other instance's stays as it was (add-project and credentials.sh name theirs, bug B)", { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run(['status']).status, 0);
  const before = readAccountStatus(join(m.T, 'var'))!;
  assert.deepEqual(before.users.map((u) => [u.user, u.loggedIn]), [['wl-alpha-agent', true], ['wl-alpha-eval', true], ['wl-beta-agent', true]]);
  writeFileSync(join(m.T, 'fail-auth-wl-alpha-agent'), '');
  writeFileSync(join(m.T, 'fail-auth-wl-beta-agent'), '');
  const r = m.run(['status', '--json', 'alpha']);
  assert.equal(r.status, 1, 'alpha\'s agent is signed out now');
  assert.deepEqual((JSON.parse(r.stdout) as { users: { user: string }[] }).users.map((u) => u.user), ['wl-alpha-agent', 'wl-alpha-eval'], 'only the named instance is asked');
  const after = readAccountStatus(join(m.T, 'var'))!;
  assert.deepEqual(after.users.map((u) => [u.user, u.loggedIn]).sort(), [['wl-alpha-agent', false], ['wl-alpha-eval', true], ['wl-beta-agent', true]], "beta's record kept as it was, not asked again");
  assert.ok(!m.outputs(r).includes(OLD), 'never the token');
});

test('bad arguments are refused before anything runs', { skip: !posix }, () => {
  const m = machine();
  for (const a of [[], ['swap'], ['switch', '--timeout', 'x'], ['switch', 'Bad'], ['switch', '--token-from', 'a;b'], ['status', 'Bad'], ['switch', '--nope']]) {
    const r = m.run(a);
    assert.equal(r.status, 2, JSON.stringify(a));
  }
  assert.deepEqual(m.calls(), []);
});
