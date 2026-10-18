// scripts/setup/claude-account.sh, with the machine stood in for (the real one runs in CI's "add-project (real
// systemd)" job): stand-ins for sudo (it runs the command with that user's home), systemctl (units that drain a few
// polls after SIGTERM, or never) and claude (signed in when its user's credentials hold a setup token). The real
// install_claude_token writes each user's login. Checked: the pause and the wait with its timeout, the token for every
// agent and eval user at 0600 and in no output, `claude auth status` as each user, an instance whose check fails left
// paused, the rerun, the token from a dashboard, status, and the account Claude Code cached for the old login dropped
// with each token installed (#341).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAccountStatus, readSwitchLines, switchedOnto, switchView } from '../src/claude-account.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
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
  assert.deepEqual([v.status, v.waitingForToken, v.tokenFrom], ['done', false, null]);
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
  for (const a of [[], ['swap'], ['switch', '--timeout', 'x'], ['switch', 'Bad'], ['switch', '--token-from', 'a;b'], ['status', 'Bad'], ['switch', '--nope']]) {
    const r = m.run(a);
    assert.equal(r.status, 2, JSON.stringify(a));
  }
  assert.deepEqual(m.calls(), []);
});
