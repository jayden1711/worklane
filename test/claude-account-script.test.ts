// scripts/setup/claude-account.sh, with the machine stood in for (the real one runs in CI's "add-project (real
// systemd)" job): stand-ins for sudo (it runs the command with that user's home), systemctl (units that drain a few
// polls after SIGTERM, or never) and claude (signed in when its user's credentials hold a setup token). Checked:
// status (each user's account, `claude auth status` and the real call as each user, never a token), never a token
// from a dashboard (#711), the removed switch, profile and failover commands refused (#736), and uninstall. And lib.sh's
// own Claude steps that credentials.sh and add-project.sh use: install_claude_token (the token at 0600, as that user,
// bounded: #613) and claude_login_ok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAccountStatus } from '../src/claude-account.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
/**
 * The shifted clock (test/clock-shift.ts, #687), passed to the script on the weekly job: the script starts with only
 * PATH and HOME, and its Node child (lib.sh's install_claude_token) writes expiresAt from its own clock. Without these
 * it wrote a real-clock expiry that a test 400 days ahead read as already past (#800). Empty on every other run.
 */
const clockShift: Record<string, string> = process.env.TEST_CLOCK_SHIFT ? { TEST_CLOCK_SHIFT: process.env.TEST_CLOCK_SHIFT, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' } : {};
// Random, so that any part of it showing up anywhere is a leak, not a coincidence.
const SECRET = `${randomBytes(16).toString('hex')}_new-${randomBytes(6).toString('hex')}`;
const TOKEN = `sk-ant-oat01-${SECRET}`;
/** Whether any 8 characters of the token's secret part are in this text. */
const leaked = (text: string) => Array.from({ length: SECRET.length - 7 }, (_, i) => SECRET.slice(i, i + 8)).some((w) => text.includes(w));
const OLD = `sk-ant-oat01-${'O'.repeat(40)}`;
/** ~/.claude.json on a machine signed in to the old account: its account cached (#341), and keys a switch must keep. */
const CACHE = { numStartups: 7, theme: 'dark', oauthAccount: { emailAddress: 'old@example.com', organizationName: 'Example', accountUuid: 'a-1' }, projects: { '/srv/x': { allowedTools: [] } } };

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
MACHINE_SUDOERS="$T/sudoers-machine" HUB_UNIT="$T/hub.service" CLAUDE_ACCOUNT_DIR="$T/var" CLAUDE_ACCOUNT_LOCK="$T/lock" MACHINE_CHANGES="$T/machine-changes.jsonl"
MINUTE=1 SWITCH_POLL=0.05
`,
  );
  const exe = (name: string, body: string) => {
    writeFileSync(join(T, 'bin', name), body);
    chmodSync(join(T, 'bin', name), 0o755);
  };
  // sudo -H -u <user> <command...>: the command, with that user's home. A leading `timeout [-k <k>] <n>` is kept where
  // this machine has timeout (a step that never returns is cut off, as on the real machine, #613), dropped where it
  // has none (macOS).
  exe('sudo', `#!/usr/bin/env bash
T=${JSON.stringify(T)}
echo "sudo $*" >> "$T/calls"
[ "$1" = -H ] && shift
[ "$1" = -u ] || exit 64
user="$2"; shift 2
if [ "$1" = timeout ] && ! command -v timeout >/dev/null; then shift; [ "$1" = -k ] && shift 2; shift; fi
# A user whose dir can't be removed (a mount, an immutable file): its rm fails, as on the real machine.
if [ "$1" = rm ] && [ -e "$T/fail-rm-$user" ]; then echo "rm: cannot remove: Operation not permitted" >&2; exit 1; fi
HOME="$T/homes/$user" USER="$user" exec "$@"
`);
  // Host tools nothing here should reach: recorded and refused, never the machine's own.
  for (const tool of ['logger', 'systemd-run', 'journalctl']) exe(tool, `#!/usr/bin/env bash\necho "${tool} $*" >> ${JSON.stringify(join(T, 'calls'))}\nexit 1\n`);
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
  // claude auth status --json: signed in when this user's credentials ($CLAUDE_CONFIG_DIR, else ~/.claude, as the real
  // one reads them) hold a setup token, unless fail-auth-<user> exists.
  // The account it names is the one cached in Claude Code's profile (.claude.json in $CLAUDE_CONFIG_DIR, else in $HOME),
  // as the real one does (#341): not the token's. With no account cached, the token's (as if fetched again for it).
  // claude -p (the login's proof, one minimal real call): answered, unless the API refuses the login: refuse-new (the new
  // token, for every user) or refuse-api-<user> exists; then a 401 as claude prints it, with the token on stderr too.
  exe('claude', `#!/usr/bin/env node
const fs = require('node:fs');
const T = ${JSON.stringify(T)};
fs.appendFileSync(T + '/claude-calls', process.env.USER + ' ' + process.argv.slice(2).join(' ') + '\\n');
let tok = '';
try { tok = JSON.parse(fs.readFileSync((process.env.CLAUDE_CONFIG_DIR || process.env.HOME + '/.claude') + '/.credentials.json', 'utf8')).claudeAiOauth.accessToken; } catch {}
const ok = /^sk-ant-oat01-/.test(tok) && !fs.existsSync(T + '/fail-auth-' + process.env.USER);
let cached = null;
try { cached = JSON.parse(fs.readFileSync((process.env.CLAUDE_CONFIG_DIR || process.env.HOME) + '/.claude.json', 'utf8')).oauthAccount || null; } catch {}
if (process.argv[2] === '-p') {
  const refused = !ok || (tok.includes('_new-') && fs.existsSync(T + '/refuse-new')) || fs.existsSync(T + '/refuse-api-' + process.env.USER);
  if (!refused) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.02 })); process.exit(0); }
  process.stderr.write('request with Authorization: Bearer ' + tok + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key · Please run /login (' + tok + ')' }));
  process.exit(1);
}
const email = cached ? cached.emailAddress : tok.includes('_new-') ? 'new@example.com' : 'old@example.com';
process.stdout.write(JSON.stringify(ok ? { loggedIn: true, authMethod: 'claude.ai', email, orgName: 'Example', subscriptionType: 'max' } : { loggedIn: false, authMethod: 'none' }, null, 2));
`);
  const user = (u: string) => {
    writeFileSync(join(T, 'users', u), '');
    const c = join(T, 'homes', u, '.claude');
    mkdirSync(c, { recursive: true, mode: 0o700 });
    writeFileSync(join(c, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: OLD, expiresAt: Date.now() + 86_400_000 }, other: 1 }), { mode: 0o600 });
    // Claude Code's profile, as a machine signed in to the old account has it: that account cached, among other keys.
    writeFileSync(join(T, 'homes', u, '.claude.json'), JSON.stringify(CACHE, null, 2), { mode: 0o600 });
  };
  for (const u of ['wl-alpha', 'wl-alpha-agent', 'wl-alpha-eval', 'wl-beta', 'wl-beta-agent']) user(u);
  const inst = join(T, 'homes', 'wl-alpha', '.local', 'state', 'worklane', 'instances', 'alpha');
  mkdirSync(inst, { recursive: true });
  writeFileSync(join(inst, 'instance.yaml'), `version: 1\nname: alpha\nrepos:\n  - path: /srv/worklane/alpha/a\n    repo: example/alpha\nrun_as:\n  agent_user: wl-alpha-agent\n  agent_home: ${T}/homes/wl-alpha-agent\n  eval_user: wl-alpha-eval\n`);
  writeFileSync(join(T, 'sudoers-machine'), 'Cmnd_Alias WORKLANE_MACHINE = x\nwl-alpha, wl-beta ALL=(root) NOPASSWD: WORKLANE_MACHINE\n');
  for (const u of ['worklane-alpha.service', 'worklane-beta.service']) writeFileSync(join(T, 'units', `${u}.active`), '');
  // deadline (ms): the run is killed then (r.error set), so a step that hangs fails the test instead of hanging it.
  const run = (args: string[], input = `${TOKEN}\n`, deadline?: number) => {
    const r = spawnSync('bash', [join(s, 'claude-account.sh'), ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T, ...clockShift }, ...(deadline ? { timeout: deadline } : {}) });
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

/** install_claude_token <user> (lib.sh; credentials.sh and add-project.sh install one login with it), token on stdin. */
const install = (m: ReturnType<typeof machine>, user: string, token = TOKEN, deadline = 30_000) =>
  spawnSync('bash', ['-c', 'source "$1"; install_claude_token "$2"', '_', join(m.s, 'lib.sh'), user], { encoding: 'utf8', input: `${token}\n`, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: m.T, ...clockShift }, timeout: deadline });

test("install_claude_token: the token in that user's own credentials file at 0600 (its dir 0700), the file's other entries kept, a year long, as that user under timeout, never echoed", { skip: !posix }, () => {
  const m = machine();
  const u = 'wl-beta-agent';
  const r = install(m, u);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const c = JSON.parse(readFileSync(m.cred(u), 'utf8')) as { claudeAiOauth: { accessToken: string; expiresAt: number }; other: number };
  assert.equal(c.claudeAiOauth.accessToken, TOKEN);
  assert.equal(c.other, 1, "the file's other entries kept");
  assert.ok(c.claudeAiOauth.expiresAt > Date.now() + 300 * 86_400_000, 'a year');
  assert.equal(statSync(m.cred(u)).mode & 0o777, 0o600);
  assert.equal(statSync(join(m.T, 'homes', u, '.claude')).mode & 0o777, 0o700);
  // As that user, bounded (#613); the token is on stdin, never on its command line.
  assert.equal(m.calls().filter((x) => x.startsWith('sudo ')).length, 1, 'one step, as that user');
  assert.match(m.calls().find((x) => x.startsWith('sudo '))!, new RegExp(`^sudo -H -u ${u} timeout -k 5 30 \\S*node --input-type=module -e `));
  assert.ok(!leaked(r.stdout + r.stderr + m.calls().join('\n')), 'the token is never echoed');
  // Not a token from claude setup-token: nothing installed.
  const before = readFileSync(m.cred('wl-alpha-agent'), 'utf8');
  assert.equal(install(m, 'wl-alpha-agent', 'sk-ant-api03-not-a-login').status, 1);
  assert.equal(readFileSync(m.cred('wl-alpha-agent'), 'utf8'), before);
});

// The machine's timeout, which the sudo stand-in keeps (macOS has none: those tests are skipped there).
const hasTimeout = posix && spawnSync('sh', ['-c', 'command -v timeout']).status === 0;

/**
 * node as each user, for the token install only: never returns while hang-install-<user> exists; when that file says
 * "ignore TERM", SIGTERM is ignored first (as by node, which has a TERM handler, or a process blocked on a hung
 * mount), so only the kill-after ends it. Everything else is node. The bounds, for this machine: 2 s, then SIGKILL
 * 1 s later.
 */
function hangingHome(m: ReturnType<typeof machine>) {
  writeFileSync(
    join(m.T, 'bin', 'node'),
    `#!/usr/bin/env bash
T=${JSON.stringify(m.T)}
hang() { [ "$(cat "$1")" != "ignore TERM" ] || trap '' TERM; exec sleep 120; }
if [ "$1" = --input-type=module ] && [ -e "$T/hang-install-$USER" ]; then hang "$T/hang-install-$USER"; fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
  );
  chmodSync(join(m.T, 'bin', 'node'), 0o755);
  appendFileSync(join(m.s, 'lib.sh'), 'CLAUDE_TOKEN_INSTALL_SECONDS=2 CLAUDE_LOGIN_SECONDS=2 CLAUDE_KILL_AFTER_SECONDS=1\n');
}

for (const [how, mark] of [
  ['dies on SIGTERM', ''],
  ['ignores SIGTERM (blocked on a hung mount)', 'ignore TERM'],
] as const) {
  test(`issue #613: a token install whose home never answers and ${how} is cut off: it fails, says so, and the user's login is as it was`, { skip: !hasTimeout }, () => {
    const m = machine();
    hangingHome(m);
    writeFileSync(join(m.T, 'hang-install-wl-beta-agent'), mark);
    const before = readFileSync(m.cred('wl-beta-agent'), 'utf8');
    const t0 = performance.now();
    const r = install(m, 'wl-beta-agent');
    assert.equal(r.error, undefined, "the install hung (killed at the test's deadline)");
    assert.ok(performance.now() - t0 < 25_000, 'cut off at the bound and its kill-after');
    assert.ok(r.status === 124 || r.status === 137, `cut off: ${r.status}`);
    assert.match(r.stderr, /^installing the Claude token as wl-beta-agent: cut off after 2 s \(its home didn't answer\)$/m);
    assert.equal(readFileSync(m.cred('wl-beta-agent'), 'utf8'), before, 'its login as it was');
    assert.ok(m.calls().some((c) => /^sudo -H -u wl-beta-agent timeout -k 1 2 \S*node --input-type=module -e /.test(c)), 'bounded');
    assert.ok(!leaked(r.stdout + r.stderr + m.calls().join('\n')));
  });
}

/** claude_login_ok <user>, from the stood-in machine's lib.sh; killed at deadline (r.error set) rather than hanging. */
const loginOk = (m: ReturnType<typeof machine>, user: string) =>
  spawnSync('bash', ['-c', 'source "$1"; claude_login_ok "$2"', '_', join(m.s, 'lib.sh'), user], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: m.T }, timeout: 30_000 });

test('issue #613: claude_login_ok asks claude auth status as that user under timeout 60, with a kill-after', { skip: !posix }, () => {
  const m = machine();
  const r = loginOk(m, 'wl-alpha-agent');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(m.calls(), ['sudo -H -u wl-alpha-agent timeout -k 5 60 claude auth status --json']);
  writeFileSync(join(m.T, 'fail-auth-wl-alpha-agent'), '');
  assert.equal(loginOk(m, 'wl-alpha-agent').status, 1, 'signed out: no');
});

for (const [how, prelude] of [
  ['dies on SIGTERM', ''],
  ['ignores SIGTERM (blocked on a hung mount)', "trap '' TERM; "],
] as const) {
  test(`issue #613: claude_login_ok whose claude never answers and ${how} is cut off: no, with the reason named`, { skip: !hasTimeout }, () => {
    const m = machine();
    writeFileSync(join(m.T, 'bin', 'claude'), `#!/usr/bin/env bash\n${prelude}exec sleep 120\n`);
    appendFileSync(join(m.s, 'lib.sh'), 'CLAUDE_LOGIN_SECONDS=2 CLAUDE_KILL_AFTER_SECONDS=1\n');
    const t0 = performance.now();
    const r = loginOk(m, 'wl-alpha-agent');
    assert.equal(r.error, undefined, "claude_login_ok hung (killed at the test's deadline)");
    assert.ok(performance.now() - t0 < 25_000, 'cut off at the bound and its kill-after');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^claude auth status, as wl-alpha-agent, didn't answer within 2 s \(its home may be on a hung mount\)$/m);
  });
}

test('issue #711: a switch never takes its token from a dashboard: --token-from (what an earlier machine helper passed) is refused before anything runs, and the file is never read', { skip: !posix }, () => {
  const m = machine();
  const dir = join(m.T, 'homes', 'wl-alpha', '.config', 'alpha-secrets');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude-account-token'), TOKEN, { mode: 0o400 });
  for (const args of [['switch', '--json', '--token-from', 'alpha'], ['switch', '--json', '--token-from', 'alpha', '--token-timeout', '1'], ['switch', '--json', '--for', 'alpha']]) {
    const r = m.run(args, '');
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(!leaked(m.outputs(r)));
  }
  assert.deepEqual(m.calls(), [], 'nothing paused, nothing installed');
  assert.ok(m.active('alpha') && m.active('beta'));
  for (const u of ['wl-alpha-agent', 'wl-alpha-eval', 'wl-beta-agent']) assert.equal((JSON.parse(readFileSync(m.cred(u), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken, OLD, u);
});

test("issue #711: any run removes, unread and as the coordinator user, what an earlier dashboard stored for this script, from every *-secrets dir in that user's ~/.config (add-project's token went to the asker's <new>-secrets); regular files only, no link followed", { skip: !posix }, () => {
  const m = machine();
  const cfgA = join(m.T, 'homes', 'wl-alpha', '.config');
  const cfgB = join(m.T, 'homes', 'wl-beta', '.config');
  const dir = join(cfgA, 'alpha-secrets');
  const beta = join(cfgB, 'beta-secrets');
  // Add project "gamma" asked from alpha's dashboard: the dashboard stored the token in alpha's home, under gamma's
  // name (secretsDir(<new instance>, <asking coordinator's home>)), where it stays if add-project stopped first.
  const gamma = join(cfgA, 'gamma-secrets');
  for (const d of [dir, beta, gamma, join(gamma, 'deeper'), join(cfgA, 'notes')]) mkdirSync(d, { recursive: true });
  for (const f of ['claude-account-token', 'claude-profile-token', 'claude-token']) writeFileSync(join(dir, f), TOKEN, { mode: 0o400 });
  writeFileSync(join(gamma, 'claude-token'), TOKEN, { mode: 0o400 });
  writeFileSync(join(beta, 'claude-login-code'), 'abcdefghij0123456789#klmnopqrstuv9876543210', { mode: 0o400 });
  // Kept: another secret; the same name outside a *-secrets dir, or deeper in one.
  writeFileSync(join(beta, 'intake-discord'), 'another secret, kept');
  writeFileSync(join(gamma, 'intake-discord'), 'another secret, kept');
  writeFileSync(join(cfgA, 'notes', 'claude-token'), 'not a secrets dir, kept');
  writeFileSync(join(gamma, 'deeper', 'claude-token'), 'deeper, kept');
  // Links are never followed: a link in one's place, and a *-secrets dir that is a link to a dir elsewhere.
  writeFileSync(join(m.T, 'elsewhere'), 'not ours');
  symlinkSync(join(m.T, 'elsewhere'), join(beta, 'claude-account-token'));
  const outside = join(m.T, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'claude-token'), 'not ours either');
  symlinkSync(outside, join(cfgB, 'linked-secrets'));
  writeFileSync(join(m.T, 'var', 'login-url'), 'https://claude.ai/oauth/authorize?x=1\n');
  const r = m.run(['status', '--json'], '');
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  for (const f of ['claude-account-token', 'claude-profile-token', 'claude-token']) assert.ok(!existsSync(join(dir, f)), f);
  assert.ok(!existsSync(join(gamma, 'claude-token')), "add-project's token, in the asker's <new>-secrets: removed");
  assert.ok(!existsSync(join(beta, 'claude-login-code')));
  assert.equal(readFileSync(join(beta, 'claude-account-token'), 'utf8'), 'not ours', 'a link is not a regular file: left, and its target untouched');
  assert.equal(readFileSync(join(outside, 'claude-token'), 'utf8'), 'not ours either', 'a linked *-secrets dir is never entered');
  for (const f of [join(beta, 'intake-discord'), join(gamma, 'intake-discord')]) assert.equal(readFileSync(f, 'utf8'), 'another secret, kept', 'only those four names');
  assert.equal(readFileSync(join(cfgA, 'notes', 'claude-token'), 'utf8'), 'not a secrets dir, kept');
  assert.equal(readFileSync(join(gamma, 'deeper', 'claude-token'), 'utf8'), 'deeper, kept');
  assert.ok(!existsSync(join(m.T, 'var', 'login-url')));
  assert.ok(m.calls().some((c) => c.startsWith(`sudo -H -u wl-alpha find -P ${cfgA} `)), 'as that coordinator user, never as root');
  assert.ok(m.calls().some((c) => c.startsWith(`sudo -H -u wl-beta find -P ${cfgB} `)));
  assert.match(r.stderr, new RegExp(`removed ${join(gamma, 'claude-token').replace(/[.*+?^$()|[\]\\]/g, '\\$&')}, unread`));
  // None of them was read into a login.
  for (const u of ['wl-alpha-agent', 'wl-beta-agent']) assert.equal((JSON.parse(readFileSync(m.cred(u), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken, OLD, u);
  assert.ok(!leaked(m.outputs(r)));
});

test('status names each agent user\'s account, token id and expiry, and fails while one is signed out', { skip: !posix }, () => {
  const m = machine();
  const r = m.run(['status']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.lines.length, 3);
  assert.match(r.lines[0]!, /^alpha +wl-alpha-agent +signed in +old@example\.com \(Example\) +token [0-9a-f]{8} +expires \d{4}-\d\d-\d\d$/);
  assert.match(r.lines[2]!, /^beta +wl-beta-agent +signed in/);
  // claude auth status, as each user; and the login's proof, one minimal real call as each user (#463).
  const claudeCalls = readFileSync(join(m.T, 'claude-calls'), 'utf8').trim().split('\n');
  assert.deepEqual(claudeCalls.filter((c) => c.includes(' auth status')), AGENTS.map((u) => `${u} auth status --json`));
  assert.deepEqual(claudeCalls.filter((c) => c.includes(' -p ')), AGENTS.map((u) => `${u} -p Reply with the single word: ok --model haiku --max-turns 1 --max-budget-usd 0.05 --output-format json`));
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

test('issue #463: a login the API refuses: status records the refusal with Claude\'s words, redacted (and fails), and the first-run step reads it', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'refuse-api-wl-beta-agent'), '');
  const st = m.run(['status', '--json']);
  assert.equal(st.status, 1, 'status fails while the API refuses a login');
  const users = (JSON.parse(st.stdout) as { users: { user: string; logged_in: boolean; api_ok: boolean | null; api_error: string | null }[] }).users;
  assert.deepEqual(users.map((u) => [u.user, u.logged_in, u.api_ok]), [['wl-alpha-agent', true, true], ['wl-alpha-eval', true, true], ['wl-beta-agent', true, false]]);
  assert.match(users[2]!.api_error!, /^HTTP 401: Invalid API key · Please run \/login \(sk-\[REDACTED\]\)$/);
  const rec = readAccountStatus(join(m.T, 'var'))!.users.find((u) => u.user === 'wl-beta-agent')!;
  assert.deepEqual([rec.loggedIn, rec.apiOk], [true, false]);
  assert.match(rec.error!, /the API refused the login/);
  assert.ok(!m.outputs(st).includes(OLD), 'never the token');
});

test('bad arguments are refused before anything runs', { skip: !posix }, () => {
  const m = machine();
  for (const a of [[], ['swap'], ['switch', '--timeout', 'x'], ['switch', 'Bad'], ['switch', '--token-from', 'a;b'], ['switch', '--token-from', 'alpha'], ['login', 'work', '--for', 'alpha'], ['status', 'Bad'], ['switch', '--nope']]) {
    const r = m.run(a);
    assert.equal(r.status, 2, JSON.stringify(a));
  }
  assert.deepEqual(m.calls(), []);
});

test('issue #736: switch, profile-add, confirm-profile, use, remove and failover are no commands: refused before anything runs, nothing read or written', { skip: !posix }, () => {
  const m = machine();
  const before = AGENTS.map((u) => readFileSync(m.cred(u), 'utf8'));
  for (const a of [['switch'], ['switch', '--json'], ['profile-add', 'work'], ['confirm-profile', 'work'], ['use', 'work'], ['use', 'default', 'alpha'], ['remove', 'work'], ['failover', 'default+work', 'back'], ['failover', 'off', 'stay'], ['use', 'work', '--for', 'alpha']]) {
    const r = m.run(a);
    assert.equal(r.status, 2, `${a.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^usage: claude-account\.sh status .*\| uninstall/m, a.join(' '));
    assert.ok(!leaked(m.outputs(r)));
  }
  assert.deepEqual(m.calls(), [], 'nothing paused, nothing installed, no call as any user');
  assert.ok(m.active('alpha') && m.active('beta'));
  assert.deepEqual(AGENTS.map((u) => readFileSync(m.cred(u), 'utf8')), before, 'every login as it was');
  assert.deepEqual(readdirSync(join(m.T, 'var')), [], 'no file written');
});

test('issue #736: uninstall removes what profiles, failover and the switch left (each user\'s ~/.claude-profiles as that user, never through a link), keeps status.json and every login, and is a root admin\'s only', { skip: !posix }, () => {
  const m = machine();
  const v = join(m.T, 'var');
  for (const f of ['profiles.json', 'profile-ops.jsonl', 'switch.jsonl', 'paused']) writeFileSync(join(v, f), '{}\n');
  writeFileSync(join(v, 'status.json'), '{"at":"x","users":[]}\n');
  const pdir = (u: string) => join(m.T, 'homes', u, '.claude-profiles');
  mkdirSync(join(pdir('wl-alpha-agent'), 'work'), { recursive: true });
  writeFileSync(join(pdir('wl-alpha-agent'), 'work', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }), { mode: 0o600 });
  // A link in one's place: removed as a link, its target untouched.
  const outside = join(m.T, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'not ours');
  symlinkSync(outside, pdir('wl-beta-agent'));
  const before = AGENTS.map((u) => readFileSync(m.cred(u), 'utf8'));
  for (const a of [['uninstall', '--for', 'alpha'], ['uninstall', 'alpha'], ['uninstall', 'x', 'y'], ['uninstall', '--json']]) assert.equal(m.run(a).status, 2, a.join(' '));
  // A coordinator user, through a sudo of its own: refused.
  const asCoordinator = spawnSync('bash', [join(m.s, 'claude-account.sh'), 'uninstall'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: m.T, SUDO_USER: 'wl-alpha' } });
  assert.equal(asCoordinator.status, 2, asCoordinator.stderr);
  assert.match(asCoordinator.stderr, /uninstall is a root admin's: not wl-alpha's/);
  assert.ok(existsSync(join(v, 'profiles.json')), 'refused: nothing removed');
  assert.ok(existsSync(pdir('wl-alpha-agent')));
  const r = m.run(['uninstall']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ['profiles.json', 'profile-ops.jsonl', 'switch.jsonl', 'paused']) assert.ok(!existsSync(join(v, f)), f);
  assert.ok(existsSync(join(v, 'status.json')), 'status.json is status\'s, kept');
  for (const u of ['wl-alpha-agent', 'wl-beta-agent']) assert.ok(!existsSync(pdir(u)) && !lstatExists(pdir(u)), u);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'not ours', 'the link was never followed');
  assert.ok(m.calls().includes(`sudo -H -u wl-alpha-agent rm -rf -- ${pdir('wl-alpha-agent')}`), 'as that user, never as root');
  assert.deepEqual(AGENTS.map((u) => readFileSync(m.cred(u), 'utf8')), before, 'every login as it was');
  assert.ok(!leaked(m.outputs(r)));
  // Again: nothing left, nothing to do.
  const again = m.run(['uninstall']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /nothing left/);
});

test("issue #736: uninstall can't remove a user's ~/.claude-profiles: it says so, exits 1 and removes none of root's files, so an instance that was on another profile stays refused", { skip: !posix }, () => {
  const m = machine();
  const v = join(m.T, 'var');
  const files = ['profiles.json', 'profile-ops.jsonl', 'switch.jsonl', 'paused'];
  for (const f of files) writeFileSync(join(v, f), '{}\n');
  const pdir = (u: string) => join(m.T, 'homes', u, '.claude-profiles');
  for (const u of ['wl-alpha-agent', 'wl-beta-agent']) mkdirSync(join(pdir(u), 'work'), { recursive: true });
  // beta's agent dir can't be removed (its rm fails, as on a mount or an immutable file); alpha's can.
  writeFileSync(join(m.T, 'fail-rm-wl-beta-agent'), '');
  const r = m.run(['uninstall']);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, new RegExp(`couldn't remove ${pdir('wl-beta-agent').replace(/[.*+?^$()|[\]\\]/g, '\\$&')} \\(beta, agent user\\)`));
  assert.match(r.stderr, /nothing else removed/);
  for (const f of files) assert.ok(existsSync(join(v, f)), `${f} kept`);
  assert.ok(existsSync(pdir('wl-beta-agent')), "the dir it couldn't remove is there");
  assert.ok(m.calls().includes(`sudo -H -u wl-beta-agent rm -rf -- ${pdir('wl-beta-agent')}`), 'tried as that user');
  assert.deepEqual(m.calls().filter((c) => /^(logger|systemd-run|journalctl) /.test(c)), [], 'no host tool reached');
  // Fixed: a rerun removes the rest.
  rmSync(join(m.T, 'fail-rm-wl-beta-agent'));
  assert.equal(m.run(['uninstall']).status, 0);
  for (const f of files) assert.ok(!existsSync(join(v, f)), f);
  assert.ok(!lstatExists(pdir('wl-beta-agent')));
});

test('issue #736: uninstall removes a link inside ~/.claude-profiles as a link: what it points to, outside, is untouched', { skip: !posix }, () => {
  const m = machine();
  const pdir = join(m.T, 'homes', 'wl-alpha-agent', '.claude-profiles');
  mkdirSync(pdir, { recursive: true });
  // Outside the profiles dir: a dir with a login in it, and a file; a profile linked to each.
  const outside = join(m.T, 'outside-dir');
  mkdirSync(outside);
  writeFileSync(join(outside, '.credentials.json'), 'not ours');
  writeFileSync(join(m.T, 'outside-file'), 'not ours either');
  symlinkSync(outside, join(pdir, 'work'));
  symlinkSync(join(m.T, 'outside-file'), join(pdir, 'spare'));
  writeFileSync(join(m.T, 'var', 'profiles.json'), '{}\n');
  const r = m.run(['uninstall']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!lstatExists(pdir), 'the profiles dir and the links in it are gone');
  assert.equal(readFileSync(join(outside, '.credentials.json'), 'utf8'), 'not ours', 'the linked dir is never entered');
  assert.equal(readFileSync(join(m.T, 'outside-file'), 'utf8'), 'not ours either', 'the linked file is never removed');
  assert.deepEqual(m.calls().filter((c) => /^(logger|systemd-run|journalctl) /.test(c)), [], 'no host tool reached');
});

/** Whether anything (a link too) is at this path. */
function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
