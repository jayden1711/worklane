// scripts/setup/claude-account.sh, with the machine stood in for (the real one runs in CI's "add-project (real
// systemd)" job): stand-ins for sudo (it runs the command with that user's home), systemctl (units that drain a few
// polls after SIGTERM, or never) and claude (signed in when its user's credentials hold a setup token). The real
// install_claude_token writes each user's login. Checked: the pause and the wait with its timeout, the token for every
// agent and eval user at 0600 and in no output, `claude auth status` as each user, an instance whose check fails left
// paused, the rerun, never a token from a dashboard (#711), status, and the account Claude Code cached for the old
// login dropped with each token installed (#341).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAccountStatus, readSwitchLines, switchedOnto, switchView } from '../src/claude-account.js';
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
  // claude auth status, as each user; and the login's proof, one minimal real call as each user (#463).
  const claudeCalls = readFileSync(join(m.T, 'claude-calls'), 'utf8').trim().split('\n');
  assert.deepEqual(claudeCalls.filter((c) => c.includes(' auth status')).slice(0, 3), AGENTS.map((u) => `${u} auth status --json`));
  assert.deepEqual(claudeCalls.filter((c) => c.includes(' -p ')), AGENTS.map((u) => `${u} -p Reply with the single word: ok --model haiku --max-turns 1 --max-budget-usd 0.05 --output-format json`));
  assert.match(r.events.find((e) => e.step === 'check' && e.user === 'wl-beta-agent')!.detail, /the API answered a minimal call/);
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
  assert.deepEqual([v.status, v.waitingForToken], ['done', false]);
  assert.deepEqual(v.instances.map((i) => [i.name, i.users.map((u) => u.user), i.resume?.state]), [['alpha', ['wl-alpha-agent', 'wl-alpha-eval'], 'done'], ['beta', ['wl-beta-agent'], 'done']]);
});

test('issue #341: a switch drops the account cached for the old login, as each user, keeping every other key, so status never names the old account as current', { skip: !posix }, () => {
  const m = machine();
  const home = (u: string) => join(m.T, 'homes', u);
  // Before: status names the old account (it is the one signed in).
  assert.match(m.run(['status']).lines[0]!, /signed in +old@example\.com/);
  // A cache in the login's own config dir (CLAUDE_CONFIG_DIR, as runs and profiles ask claude) is dropped too.
  writeFileSync(join(home('wl-beta-agent'), '.claude', '.claude.json'), JSON.stringify(CACHE), { mode: 0o600 });
  const r = m.run(['switch', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const u of AGENTS) {
    const f = join(home(u), '.claude.json');
    const { oauthAccount, ...rest } = CACHE;
    assert.equal(oauthAccount.emailAddress, 'old@example.com');
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), rest, `${u}: the old account dropped, every other key kept`);
    assert.equal(statSync(f).mode & 0o777, 0o600, `${u}: its mode kept`);
    assert.ok(!lstatSync(f).isSymbolicLink());
    assert.match(r.events.find((e) => e.step === 'install' && e.user === u)!.detail, /the account cached for the previous login dropped/);
    // Written as that user (sudo -u), never as root.
    assert.ok(readFileSync(join(m.T, 'calls'), 'utf8').split('\nsudo ').some((c) => c.startsWith(`-H -u ${u} `) && c.includes('oauthAccount')), `${u}: as that user`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(home('wl-beta-agent'), '.claude', '.claude.json'), 'utf8')), (({ oauthAccount: _, ...rest }) => rest)(CACHE));
  assert.ok(!readdirSync(home('wl-beta-agent')).some((f) => f.includes('.tmp')), 'no temp file left');
  // After: the switch's own check and status name the new account, never the old one as current.
  assert.match(r.events.find((e) => e.step === 'check' && e.user === 'wl-alpha-agent')!.detail, /signed in as new@example\.com/);
  const st = m.run(['status', '--json']);
  assert.equal(st.status, 0, st.stderr);
  const users = (JSON.parse(st.stdout) as { users: { user: string; account: string | null }[] }).users;
  assert.deepEqual(users.map((u) => [u.user, u.account]), AGENTS.map((u) => [u, 'new@example.com']));
  assert.ok(!m.run(['status']).stdout.includes('old@example.com'));
  // The account dropped (kept in memory for a rollback) is in no output, progress line or command line.
  const all = m.outputs(r) + r.stdout + r.stderr;
  assert.ok(!all.includes('old@example.com') && !all.includes('"a-1"'), 'the dropped account is never shown');
});

test('issue #341: a cached profile that is a link, a fifo or not JSON is never followed or rewritten; the switch says its account name may be the old one', { skip: !posix }, () => {
  const m = machine();
  const elsewhere = join(m.T, 'elsewhere.json');
  writeFileSync(elsewhere, JSON.stringify(CACHE));
  const linked = join(m.T, 'homes', 'wl-alpha-agent', '.claude.json');
  rmSync(linked);
  symlinkSync(elsewhere, linked);
  const broken = join(m.T, 'homes', 'wl-beta-agent', '.claude.json');
  writeFileSync(broken, '{ not json', { mode: 0o600 });
  // A fifo in place of one is never waited on (the switch would hang there, as root).
  const fifo = join(m.T, 'homes', 'wl-alpha-eval', '.claude', '.claude.json');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const r = m.run(['switch', '--json']);
  assert.equal(r.status, 0, 'the token is in and works: a stale name does not fail the switch');
  assert.equal(readFileSync(elsewhere, 'utf8'), JSON.stringify(CACHE), 'the link is never followed');
  assert.ok(lstatSync(linked).isSymbolicLink(), 'nor replaced');
  assert.equal(readFileSync(broken, 'utf8'), '{ not json', 'left as it was');
  assert.ok(lstatSync(fifo).isFIFO());
  for (const [u, why] of [['wl-alpha-agent', 'a link'], ['wl-beta-agent', 'not JSON'], ['wl-alpha-eval', 'not a plain file']] as const) {
    assert.match(r.events.find((e) => e.step === 'install' && e.user === u)!.detail, new RegExp(`couldn't drop the account cached for the previous login in \\S*\\.claude\\.json \\(${why}\\): claude auth status may still name the previous account`), u);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(m.T, 'homes', 'wl-alpha-eval', '.claude.json'), 'utf8')), (({ oauthAccount: _, ...rest }) => rest)(CACHE), "the user's other profile still dropped");
});

test('issue #341: profile-add into a dir left from an earlier profile drops the account cached there, so its check (and confirm-profile) names the new one', { skip: !posix }, () => {
  const m = machine();
  const d = join(m.T, 'homes', 'wl-beta-agent', '.claude-profiles', 'work');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(d, '.claude.json'), JSON.stringify(CACHE), { mode: 0o600 });
  const r = m.run(['profile-add', 'work', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.lines.some((l) => /"step":"install","state":"done".*the account cached there for an earlier login dropped/.test(l)), r.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(d, '.claude.json'), 'utf8')), (({ oauthAccount: _, ...rest }) => rest)(CACHE));
  const p = JSON.parse(readFileSync(join(m.T, 'var', 'profiles.json'), 'utf8')) as { profiles: { work: { users: Record<string, { account: string }> } } };
  assert.equal(p.profiles.work.users['wl-beta-agent']!.account, 'new@example.com', 'the account its check recorded is the new token\'s');

  // One that can't be dropped (a link) refuses the profile: nothing added, the link never followed.
  const m2 = machine();
  const d2 = join(m2.T, 'homes', 'wl-beta-agent', '.claude-profiles', 'work');
  mkdirSync(d2, { recursive: true, mode: 0o700 });
  writeFileSync(join(m2.T, 'elsewhere.json'), JSON.stringify(CACHE));
  symlinkSync(join(m2.T, 'elsewhere.json'), join(d2, '.claude.json'));
  const r2 = m2.run(['profile-add', 'work', '--json']);
  assert.equal(r2.status, 1, r2.stdout);
  assert.ok(r2.lines.some((l) => /"step":"install","state":"failed".*couldn't drop the account cached in .*\(a link\)/.test(l)), r2.stdout);
  assert.equal(readFileSync(join(m2.T, 'elsewhere.json'), 'utf8'), JSON.stringify(CACHE));
  assert.ok(!existsSync(d2), 'the half-added profile dir removed');
  assert.ok(!leaked(m2.outputs(r2)) && !leaked(r.stdout + r.stderr));
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

// The machine's timeout, which the sudo stand-in keeps (macOS has none: those tests are skipped there).
const hasTimeout = posix && spawnSync('sh', ['-c', 'command -v timeout']).status === 0;

test('issue #613: each token install runs as its user under timeout, as every other step a switch runs as an agent user', { skip: !posix }, () => {
  const m = machine();
  const r = m.run(['switch', '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // The install's sudo line (its script follows -e, on the next lines of the log); the token is on stdin, never here.
  const installs = m.calls().filter((c) => c.startsWith('sudo ') && c.includes('--input-type=module'));
  assert.equal(installs.length, AGENTS.length, installs.join('\n'));
  for (const [i, u] of AGENTS.entries()) assert.match(installs[i]!, new RegExp(`^sudo -H -u ${u} timeout -k 5 30 \\S*node --input-type=module -e `), u);
  assert.ok(!leaked(m.outputs(r)));
});

/**
 * node as each user, for the token install and its rollback only: never returns while hang-install-<user> or
 * hang-restore-<user> exists; when that file says "ignore TERM", SIGTERM is ignored first (as by node, which has a
 * TERM handler, or a process blocked on a hung mount), so only the kill-after ends it. Everything else is node. The
 * bounds, for this machine: 2 s, then SIGKILL 1 s later.
 */
function hangingHome(m: ReturnType<typeof machine>) {
  writeFileSync(
    join(m.T, 'bin', 'node'),
    `#!/usr/bin/env bash
T=${JSON.stringify(m.T)}
hang() { [ "$(cat "$1")" != "ignore TERM" ] || trap '' TERM; exec sleep 120; }
if [ "$1" = --input-type=module ] && [ -e "$T/hang-install-$USER" ]; then hang "$T/hang-install-$USER"; fi
if [ "$1" = -e ] && [[ "$2" == *'const prev = readFileSync(0'* ]] && [ -e "$T/hang-restore-$USER" ]; then hang "$T/hang-restore-$USER"; fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
  );
  chmodSync(join(m.T, 'bin', 'node'), 0o755);
  appendFileSync(join(m.s, 'lib.sh'), 'CLAUDE_TOKEN_INSTALL_SECONDS=2 CLAUDE_LOGIN_SECONDS=2 CLAUDE_KILL_AFTER_SECONDS=1\n');
}

test('issue #613: a token install that ignores SIGTERM (blocked on a hung mount) is still cut off, by the kill-after: failed, named, and the switch finishes', { skip: !hasTimeout }, () => {
  const m = machine();
  hangingHome(m);
  writeFileSync(join(m.T, 'hang-install-wl-beta-agent'), 'ignore TERM');
  const t0 = performance.now();
  const r = m.run(['switch', '--json'], `${TOKEN}\n`, 30_000);
  assert.equal(r.error, undefined, `the switch hung (killed at the test's deadline): ${r.stdout}`);
  assert.ok(performance.now() - t0 < 25_000, 'cut off at the bound and its kill-after');
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const mine = r.events.filter((e) => e.user === 'wl-beta-agent');
  assert.deepEqual(mine.map((e) => `${e.step} ${e.state}`), ['install failed']);
  assert.match(mine[0]!.detail, /^couldn't store the token in .*\/\.credentials\.json: cut off after 2 s \(its home didn't answer\)$/);
  assert.deepEqual(r.events.filter((e) => e.step === 'resume').map((e) => [e.instance, e.state]), [['alpha', 'done'], ['beta', 'failed']]);
  assert.equal(readFileSync(join(m.T, 'var', 'paused'), 'utf8'), 'beta\n');
  assert.ok(!leaked(m.outputs(r)));
});

test('issue #613: a rollback that never returns (the API refused the new login; TERM ignored) is cut off: that user named, the switch finishes refused, its instance left paused', { skip: !hasTimeout }, () => {
  const m = machine();
  hangingHome(m);
  writeFileSync(join(m.T, 'refuse-new'), '');
  writeFileSync(join(m.T, 'hang-restore-wl-beta-agent'), 'ignore TERM');
  const t0 = performance.now();
  const r = m.run(['switch', '--json'], `${TOKEN}\n`, 30_000);
  assert.equal(r.error, undefined, `the switch hung (killed at the test's deadline): ${r.stdout}`);
  assert.ok(performance.now() - t0 < 25_000, 'cut off at the bound and its kill-after');
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const mine = r.events.filter((e) => e.user === 'wl-beta-agent');
  assert.deepEqual(mine.map((e) => `${e.step} ${e.state}`), ['install done', 'check failed', 'install failed']);
  assert.match(mine.at(-1)!.detail, /^the API refused the new login, and putting the previous one back failed: cut off after 2 s \(its home didn't answer\): sign this user in again$/);
  for (const u of ['wl-alpha-agent', 'wl-alpha-eval']) assert.match(r.events.filter((e) => e.user === u && e.step === 'install').at(-1)!.detail, /^rolled back: /, u);
  // The rollback's sudo line carries the bound and its kill-after; the login it puts back is on stdin, never here.
  assert.ok(m.calls().some((c) => /^sudo -H -u wl-beta-agent timeout -k 1 2 \S*node -e $/.test(c)), 'bounded');
  assert.deepEqual(r.events.filter((e) => e.step === 'resume').map((e) => [e.instance, e.state]), [['alpha', 'done'], ['beta', 'failed']]);
  assert.ok(m.active('alpha') && !m.active('beta'));
  assert.equal(readFileSync(join(m.T, 'var', 'paused'), 'utf8'), 'beta\n');
  assert.match(r.events.at(-1)!.detail, /^refused: .*not resumed: beta\. /);
  assert.ok(!leaked(m.outputs(r)) && !m.outputs(r).includes(OLD), 'neither login in any output');
});

test('issue #613: a token install that never returns (a home on a hung mount) is cut off: that user\'s install fails, named, the switch finishes, and its instance is left paused for the rerun', { skip: !hasTimeout }, () => {
  const m = machine();
  hangingHome(m);
  writeFileSync(join(m.T, 'hang-install-wl-beta-agent'), '');
  const before = readFileSync(m.cred('wl-beta-agent'), 'utf8');
  const t0 = performance.now();
  const r = m.run(['switch', '--json'], `${TOKEN}\n`, 30_000);
  assert.equal(r.error, undefined, `the switch hung (killed at the test's deadline): ${r.stdout}`);
  assert.ok(performance.now() - t0 < 25_000, 'cut off at the bound');
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const mine = r.events.filter((e) => e.user === 'wl-beta-agent');
  assert.deepEqual(mine.map((e) => `${e.step} ${e.state}`), ['install failed'], 'no check on a login it could not store');
  assert.match(mine[0]!.detail, /^couldn't store the token in .*\/\.credentials\.json: cut off after 2 s \(its home didn't answer\)$/);
  assert.equal(readFileSync(m.cred('wl-beta-agent'), 'utf8'), before, 'its login as it was');
  for (const u of ['wl-alpha-agent', 'wl-alpha-eval']) assert.deepEqual(r.events.filter((e) => e.user === u).map((e) => `${e.step} ${e.state}`), ['install done', 'check done'], u);
  // The existing "not resumed" path: alpha runs again, beta stays paused and is remembered for the rerun.
  assert.deepEqual(r.events.filter((e) => e.step === 'resume').map((e) => [e.instance, e.state]), [['alpha', 'done'], ['beta', 'failed']]);
  assert.match(r.events.at(-1)!.detail, /^not resumed: beta; fix what each says, then rerun: /);
  assert.ok(m.active('alpha') && !m.active('beta'));
  assert.equal(readFileSync(join(m.T, 'var', 'paused'), 'utf8'), 'beta\n');
  assert.ok(!leaked(m.outputs(r)));

  // The home answers again: the rerun installs it and resumes beta.
  rmSync(join(m.T, 'hang-install-wl-beta-agent'));
  const again = m.run(['switch', '--json'], `${TOKEN}\n`, 60_000);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.deepEqual(again.events.filter((e) => e.step === 'resume').map((e) => [e.instance, e.state]), [['alpha', 'done'], ['beta', 'done']]);
  assert.equal((JSON.parse(readFileSync(m.cred('wl-beta-agent'), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken, TOKEN);
});

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

test('issue #463: the API refuses the new login: the switch is refused, every agent user is put back on its previous login byte for byte, Claude\'s message is shown (never the token), and the instances resume on the old login', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'refuse-new'), '');
  const before = AGENTS.map((u) => readFileSync(m.cred(u), 'utf8'));
  const r = m.run(['switch', '--json']);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  // Each user: installed, then its check failed with Claude's words, then rolled back.
  for (const u of AGENTS) {
    const mine = r.events.filter((e) => e.user === u).map((e) => `${e.step} ${e.state}`);
    assert.deepEqual(mine, ['install done', 'check failed', 'install failed'], u);
    assert.match(r.events.find((e) => e.user === u && e.step === 'check')!.detail, /claude auth status says signed in as new@example\.com, but the API refused the login: HTTP 401: Invalid API key · Please run \/login/);
    assert.match(r.events.filter((e) => e.user === u && e.step === 'install').at(-1)!.detail, /rolled back: the API refused the new login/);
  }
  assert.deepEqual(AGENTS.map((u) => readFileSync(m.cred(u), 'utf8')), before, 'every login exactly as it was');
  for (const u of AGENTS) assert.equal(statSync(m.cred(u)).mode & 0o777, 0o600, u);
  // #341: the account cached for the old login, dropped for the new one, is back with it (every other key kept).
  for (const u of AGENTS) assert.deepEqual(JSON.parse(readFileSync(join(m.T, 'homes', u, '.claude.json'), 'utf8')), CACHE, u);
  assert.match(m.run(['status']).lines[0]!, /signed in +old@example\.com/, 'the old login, named as it is');
  const end = r.events.at(-1)!;
  assert.deepEqual([end.step, end.state], ['switch', 'failed']);
  assert.match(end.detail, /^refused: the API refused the new login \(Claude said: HTTP 401: Invalid API key · Please run \/login .*\)\. Every agent user is back on its previous login\. Make a new token/);
  // Back on the old login, as before the switch: resumed; the coordinator's account-switched hook sees no switch.
  assert.deepEqual(r.events.filter((e) => e.step === 'resume').map((e) => [e.instance, e.state]), [['alpha', 'done'], ['beta', 'done']]);
  assert.ok(m.active('alpha') && m.active('beta'));
  const lines = readSwitchLines(join(m.T, 'var'));
  assert.equal(switchedOnto('alpha', lines), null, 'no account switched');
  assert.equal(switchView(lines)!.status, 'failed');
  // Claude's message is shown; the token (which the stand-in even put in its message and on stderr) is not.
  assert.ok(!leaked(m.outputs(r)), 'the new token is never echoed');
  assert.ok(!m.outputs(r).includes(OLD), 'nor the old one');
});

test('issue #463: with no token, an instance whose current login the API refuses is not resumed; status records the refusal (and fails), and the first-run step reads it', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'refuse-api-wl-beta-agent'), '');
  const r = m.run(['switch', '--json'], '');
  assert.equal(r.status, 1);
  assert.match(r.events.find((e) => e.step === 'check' && e.user === 'wl-beta-agent')!.detail, /but the API refused the login: HTTP 401/);
  assert.deepEqual(r.events.filter((e) => e.step === 'resume').map((e) => [e.instance, e.state]), [['alpha', 'done'], ['beta', 'failed']]);
  assert.ok(!r.events.some((e) => e.step === 'install'), 'nothing installed, nothing rolled back');
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
