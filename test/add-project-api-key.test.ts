// Issue #897: an agent that bills to an Anthropic API key (credentials.sh <name> api-key) is a first-class login for
// scripts/setup/add-project.sh's claude-token step. The step counts as done when credentials.yaml names the key file
// (read as the coordinator user), the file is the agent user's own and open to nobody else (checked as that user),
// and claude, as the agent user, reports an API-key login; anything less still waits for root. Its waiting message
// names both routes. Every setup script and host tool is a stand-in here: no sudo, no claude, no systemd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RUNTIME_LOGINS } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
const KEY = `sk-ant-api03-${'K'.repeat(40)}`;
/** Host tools add-project or lib.sh could reach: each a recording stand-in that fails, so none of the real ones runs. */
const HOST_TOOLS = ['sudo', 'claude', 'systemctl', 'loginctl', 'launchctl', 'id', 'getent', 'useradd', 'usermod', 'gh', 'docker', 'tailscale', 'timeout'];

type Step = { step: string; state: string; detail: string; retry?: string };

/**
 * A machine in a temp dir where instance <name>'s users, home and GitHub App are in place already (those steps done),
 * add-project.sh beside a lib.sh that sources the real one with its paths, users and run_as pointed into the temp dir,
 * and stand-ins for every later step's script. What claude auth status says as a user is <root>/claude-status-<user>.
 */
function machine(name = 'alpha') {
  const T = mkdtempSync(join(tmpdir(), 'add-project-key-'));
  const s = join(T, 'scripts', 'setup');
  const host = join(T, 'host-bin');
  for (const d of [s, host, join(T, 'scripts', 'machine'), join(T, 'users'), join(T, 'active'), join(T, 'bin'), join(T, 'srv', name)]) mkdirSync(d, { recursive: true });
  copyFileSync(join(setupDir, 'add-project.sh'), join(s, 'add-project.sh'));
  copyFileSync(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs'), join(T, 'scripts', 'machine', 'worklane-machine.cjs'));
  for (const tool of HOST_TOOLS) {
    writeFileSync(join(host, tool), `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(join(T, 'host-calls'))}\nexit 1\n`);
    chmodSync(join(host, tool), 0o755);
  }
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
as_root() { :; }
home_of() { echo "$T/homes/$1"; }
user_exists() { [ -e "$T/users/$1" ]; }
unit_active() { [ -e "$T/active/$1" ]; }
run_as() { local user="$1" script="$2"; shift 2; echo "run_as $user" >> "$T/calls"; HOME="$T/homes/$user" bash -euo pipefail -c "$script" _ "$@"; }
claude_status_json() { cat "$T/claude-status-$1" 2>/dev/null || true; }
claude_login_ok() { :; }
install_claude_token() { cat > /dev/null; echo "install_claude_token $1" >> "$T/calls"; }
SRV_ROOT="$T/srv" ENGINE_CLI="$T/bin/worklane" MACHINE_HELPER="$T/helper" MACHINE_SUDOERS="$T/sudoers-machine" HUB_UNIT="$T/hub.service" ADD_PROJECT_LOCK="$T/lock"
SETUP_POLL_SECONDS=0 SETUP_WAIT_SECONDS=0
`,
  );
  const stub = (file: string, step: string, body: string) => {
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\nT=${JSON.stringify(T)}\necho "${step} $*" >> "$T/calls"\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub(join(T, 'bin', 'worklane'), 'worklane', 'exit 2');
  stub(join(s, 'instance.sh'), 'instance', 'exit 1');
  stub(join(s, 'checkout.sh'), 'checkout', 'mkdir -p "$T/srv/$1/${2#*/}/.git" "$T/srv/$1/${2#*/}/.worklane"');
  stub(join(s, 'service.sh'), 'service', 'touch "$T/active/worklane-$1.service"');
  stub(join(s, 'test-user.sh'), 'test-user', 'exit 1');
  stub(join(s, 'machine-helper.sh'), 'machine-helper', `cp "$T/scripts/machine/worklane-machine.cjs" "$T/helper"
users=""; for n in "$@"; do users="\${users:+$users, }wl-$n"; done
printf 'Cmnd_Alias WORKLANE_MACHINE = x\\n%s ALL=(root) NOPASSWD: WORKLANE_MACHINE\\n' "$users" > "$T/sudoers-machine"`);
  stub(join(s, 'dashboards.sh'), 'dashboards', `while [ "$#" -gt 0 ] && [ "\${1#--}" != "$1" ]; do shift 2; done
hub=""; for n in "$@"; do hub="\${hub:+$hub,}$n=$T/homes/wl-$n/state"; touch "$T/active/worklane-dashboard-$n.service"; done
printf '[Service]\\nExecStart=/usr/local/bin/worklane dashboard --hub %s --service --client-id Iv1.signin0001 --public-url https://hub.example.test\\n' "$hub" > "$T/hub.service"`);
  writeFileSync(join(T, 'hub.service'), '[Service]\nExecStart=/usr/local/bin/worklane dashboard --hub - --service --client-id Iv1.signin0001 --public-url https://hub.example.test\n');
  // The instance and its App, as their steps leave them.
  const coord = `wl-${name}`;
  const agent = `wl-${name}-agent`;
  for (const u of [coord, agent]) writeFileSync(join(T, 'users', u), '');
  const inst = join(T, 'homes', coord, '.local', 'state', 'worklane', 'instances', name);
  mkdirSync(join(inst, 'state'), { recursive: true });
  writeFileSync(join(inst, 'instance.yaml'), `version: 1\nname: ${name}\nrepos:\n  - path: "x"\n    repo: example/alpha\n`);
  const creds = join(inst, 'credentials.yaml');
  writeFileSync(creds, 'version: 1\ngithub:\n  kind: app\n  app_id: 91\n  installation_id: 4242\n');
  mkdirSync(join(T, 'homes', coord, '.config', `${name}-app`), { recursive: true });
  writeFileSync(join(T, 'homes', coord, '.config', `${name}-app`, 'private-key.pem'), 'key');
  mkdirSync(join(T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub'), { recursive: true });
  writeFileSync(join(T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub', 'dashboard-token'), 't');

  const keyFile = join(T, 'homes', agent, '.config', `${name}-claude-key`, 'api_key');
  /** What credentials.sh <name> api-key leaves: the key file (0400, in a 0700 dir), its line in credentials.yaml, and claude's answer. */
  const keyed = (o: { mode?: number; line?: string | null; auth?: object | null } = {}) => {
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, KEY);
    chmodSync(keyFile, o.mode ?? 0o400);
    if (o.line !== null) writeFileSync(creds, `${readFileSync(creds, 'utf8')}${o.line ?? `agent_api_key: ${keyFile}`}\n`);
    const auth = o.auth === undefined ? { loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' } : o.auth;
    if (auth) writeFileSync(join(T, `claude-status-${agent}`), JSON.stringify(auth, null, 2));
  };
  const run = (args: string[] = [name, 'example/alpha']) => {
    const r = spawnSync('bash', [join(s, 'add-project.sh'), ...args], { encoding: 'utf8', input: '', env: { PATH: `${host}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: T } });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { ...r, events: lines.map((l) => JSON.parse(l) as Step) };
  };
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8') : '');
  const hostCalls = () => (existsSync(join(T, 'host-calls')) ? readFileSync(join(T, 'host-calls'), 'utf8') : '');
  return { T, s, run, keyed, keyFile, creds, calls, hostCalls, agent, coord };
}

const tokenStep = (events: Step[]) => events.filter((e) => e.step === 'claude-token').at(-1)!;

test('issue #897: an agent set up with an API key passes the claude-token step, with no token asked for or installed, and the run goes on', { skip: !posix }, () => {
  const m = machine();
  m.keyed();
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  const step = tokenStep(r.events);
  assert.equal(step.state, 'done', step.detail);
  assert.match(step.detail, /^wl-alpha-agent bills to an Anthropic API key \(.+\/\.config\/alpha-claude-key\/api_key, its own, open to nobody else\), and claude reports an API-key login as that user$/);
  assert.ok(!m.calls().includes('install_claude_token'), 'no Claude token installed');
  assert.ok(r.events.some((e) => e.step === 'dashboards' && e.state === 'done'), 'the steps after it ran');
  // credentials.yaml was read as the coordinator user, the key file checked as the agent user: never as root.
  assert.match(m.calls(), /run_as wl-alpha\n/);
  assert.match(m.calls(), /run_as wl-alpha-agent\n/);
  assert.ok(!`${r.stdout}${r.stderr}${m.calls()}`.includes(KEY), 'the key is never read or shown');
  assert.equal(m.hostCalls(), '', 'no host tool was reached');
});

test('issue #897: anything short of a working API-key setup still waits for root at the claude-token step', { skip: !posix }, () => {
  const cases: Record<string, (m: ReturnType<typeof machine>) => void> = {
    'credentials.yaml names no key': (m) => m.keyed({ line: null }),
    'the key file is open to others (0644)': (m) => m.keyed({ mode: 0o644 }),
    'the key file is open to its group (0440)': (m) => m.keyed({ mode: 0o440 }),
    'credentials.yaml names a file that is not there': (m) => m.keyed({ line: `agent_api_key: ${join(m.T, 'nowhere', 'api_key')}` }),
    'credentials.yaml names a path apiKeyHelper could not name': (m) => m.keyed({ line: `agent_api_key: "${m.keyFile.replace('api_key', 'api key')}"` }),
    'credentials.yaml names the file by a path not in normal form': (m) => m.keyed({ line: `agent_api_key: ${dirname(m.keyFile)}/../${m.keyFile.split('/').slice(-2).join('/')}` }),
    'credentials.yaml names the key directory, with a trailing slash': (m) => m.keyed({ line: `agent_api_key: ${dirname(m.keyFile)}/` }),
    'the key file is a link': (m) => {
      m.keyed({ line: `agent_api_key: ${join(dirname(m.keyFile), 'link')}` });
      symlinkSync(m.keyFile, join(dirname(m.keyFile), 'link'));
    },
    'credentials.yaml is a link (to a file that names the key)': (m) => {
      m.keyed();
      renameSync(m.creds, `${m.creds}.real`);
      symlinkSync(`${m.creds}.real`, m.creds);
    },
    'claude reports a subscription login': (m) => m.keyed({ auth: { loggedIn: true, authMethod: 'claude.ai' } }),
    'claude reports no login': (m) => m.keyed({ auth: { loggedIn: false, authMethod: 'none' } }),
    'claude gives no answer': (m) => m.keyed({ auth: null }),
  };
  for (const [why, make] of Object.entries(cases)) {
    const m = machine();
    make(m);
    const r = m.run();
    assert.equal(r.status, 3, `${why}: ${r.stderr}`);
    assert.deepEqual([tokenStep(r.events).state, r.events.at(-1)!.step], ['waiting', 'claude-token'], why);
    assert.ok(!r.events.some((e) => e.step === 'checkout'), `${why}: nothing after it started`);
    assert.equal(m.hostCalls(), '', `${why}: no host tool was reached`);
  }
});

test('issue #897: the waiting message names both routes, the API key included, whole within the 400 characters a step line keeps, for the longest instance name', { skip: !posix }, () => {
  const name = 'abcdefghijklmnopqrstu';
  const m = machine(name);
  const r = m.run([name, 'example/alpha']);
  assert.equal(r.status, 3, r.stderr);
  const step = tokenStep(r.events);
  assert.equal(step.state, 'waiting');
  // Whole: nothing of it cut off (the test's temp path is longer than the installed engine's).
  assert.equal(
    step.detail,
    `the agents' Claude login, which only root installs, on this machine: sudo bash ${m.s}/credentials.sh ${name} claude (it asks for the token claude setup-token prints), or the same with api-key for claude (it asks for an Anthropic API key), neither shown; or sudo -u wl-${name}-agent -i claude auth login`,
  );
  assert.ok(m.s.length >= '/opt/worklane/current/scripts/setup'.length, m.s);
});

test("issue #897: lib.sh's API-key logins are the api_key runtime's (src/runner.ts RUNTIME_LOGINS)", { skip: !posix }, () => {
  const r = spawnSync('bash', ['-c', 'source "$1"; printf %s "$CLAUDE_API_KEY_LOGINS"', '_', join(setupDir, 'lib.sh')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split('|'), [...RUNTIME_LOGINS.api_key]);
});
