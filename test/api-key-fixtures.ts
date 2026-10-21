// Shared stand-ins for the API-key login tests (#897, #904): an add-project machine in a temp dir, an instance home the
// engine's CLI runs against (with a user database stand-in), and a server instance's setup steps as its coordinator
// user sees them. Every host tool is a stand-in: no sudo, no claude, no systemd, no real user database.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { checkSetup, type InstanceFacts, type MachinePaths, type SetupContext, type SetupProbe, type SetupView } from '../src/setup-steps.js';
import { engineCli, exampleProject, repoRoot } from './helpers.js';

export const posix = process.platform !== 'win32';
/** A directory mode 000 hides what is in it from this user, unless this user is root. */
export const canHide = posix && process.getuid?.() !== 0;
export const setupDir = join(repoRoot, 'scripts', 'setup');
export const KEY = `sk-ant-api03-${'K'.repeat(40)}`;
/**
 * Host tools add-project or lib.sh could reach: each a recording stand-in that fails, so none of the real ones runs.
 * Not `timeout`: lib.sh bounds the agent-run checks with it (#904), and it runs nothing of the machine's.
 */
const HOST_TOOLS = ['sudo', 'claude', 'systemctl', 'loginctl', 'launchctl', 'id', 'getent', 'useradd', 'usermod', 'gh', 'docker', 'tailscale'];

export type Step = { step: string; state: string; detail: string; retry?: string };
export const tokenStep = (events: Step[]) => events.filter((e) => e.step === 'claude-token').at(-1)!;

/**
 * A machine in a temp dir where instance <name>'s users, home and GitHub App are in place already (those steps done),
 * add-project.sh beside a lib.sh that sources the real one with its paths, users and run_as pointed into the temp dir,
 * and stand-ins for every later step's script. What claude auth status says as a user is <root>/claude-status-<user>.
 */
export function machine(name = 'alpha') {
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
# lib.sh's run_as_bounded runs for real; only who it runs as is stood in (this user, that user's HOME, a claude
# stand-in for it first on PATH, AGENT_SIDE marking its processes). Root's timeout stays outside it, as with sudo.
as_user_argv() { echo "run_as $1" >> "$T/calls"; AS_USER=(env HOME="$T/homes/$1" PATH="$T/agent-bin:$PATH" AGENT_SIDE="$T"); }
claude_status_json() { cat "$T/claude-status-$1" 2>/dev/null || true; }
claude_login_ok() { :; }
install_claude_token() { cat > /dev/null; echo "install_claude_token $1" >> "$T/calls"; }
# The policy step's root ownership (#726), stood in as test/add-project.test.ts does: no sudo -V, no engine CLI.
sudo_regex_ok() { :; }
own_policy() { touch "$T/owned-$1"; }
policy_root_ok() { [ -e "$T/owned-$1" ]; }
POLICY_ROOT_DIR="$T/policy-root"
# #902's machine-wide files (unused before it lands): into the temp dir, never /var/lib or /etc.
ADD_PROJECT_NEW="$T/add-project-new" ADD_PROJECT_NEW_UID=${process.getuid?.() ?? 0} HELPER_RULES="$T/helper-rules.json"
SRV_ROOT="$T/srv" ENGINE_CLI="$T/bin/worklane" MACHINE_HELPER="$T/helper" MACHINE_SUDOERS="$T/sudoers-machine" HUB_UNIT="$T/hub.service" ADD_PROJECT_LOCK="$T/lock"
SETUP_POLL_SECONDS=0 SETUP_WAIT_SECONDS=0
`,
  );
  const stub = (file: string, step: string, body: string) => {
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\nT=${JSON.stringify(T)}\necho "${step} $*" >> "$T/calls"\n${body}\n`);
    chmodSync(file, 0o755);
  };
  // The engine's CLI: its own `instance agent-api-key-of` (the parse add-project relies on, #904) runs for real.
  stub(join(T, 'bin', 'worklane'), 'worklane', `if [ "$1 $2" = "instance agent-api-key-of" ]; then exec ${JSON.stringify(process.execPath)} ${JSON.stringify(engineCli)} "$@"; fi\nexit 2`);
  // claude as the agent user sees it: what <root>/claude-status-<user> says, or nothing.
  mkdirSync(join(T, 'agent-bin'));
  writeFileSync(join(T, 'agent-bin', 'claude'), `#!/bin/sh\ncat ${JSON.stringify(T)}/claude-status-"$(basename "$HOME")" 2>/dev/null || true\n`);
  chmodSync(join(T, 'agent-bin', 'claude'), 0o755);
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
  // As setGithubApp writes it (the engine's schema needs every field: #904 has add-project read it through the engine).
  writeFileSync(creds, `version: 1\ngithub:\n  kind: app\n  app_id: 91\n  installation_id: 4242\n  key_path: ${join(T, 'homes', coord, '.config', `${name}-app`, 'private-key.pem')}\n`);
  mkdirSync(join(T, 'homes', coord, '.config', `${name}-app`), { recursive: true });
  writeFileSync(join(T, 'homes', coord, '.config', `${name}-app`, 'private-key.pem'), 'key');
  mkdirSync(join(T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub'), { recursive: true });
  writeFileSync(join(T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub', 'dashboard-token'), 't');

  const agentHome = join(T, 'homes', agent);
  const settings = join(agentHome, '.claude', 'settings.json');
  const keyFile = join(agentHome, '.config', `${name}-claude-key`, 'api_key');
  /**
   * What credentials.sh <name> api-key leaves: the key file (0400, in a 0700 dir), its line in credentials.yaml, the
   * agent's own settings.json apiKeyHelper (`cat -- <helper>`, default the key file; null: no settings), and claude's answer.
   */
  const keyed = (o: { mode?: number; line?: string | null; helper?: string | null; auth?: object | null; file?: string } = {}) => {
    const file = o.file ?? keyFile;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, KEY);
    chmodSync(file, o.mode ?? 0o400);
    if (o.line !== null) writeFileSync(creds, `${readFileSync(creds, 'utf8')}${o.line ?? `agent_api_key: ${file}`}\n`);
    if (o.helper !== null) {
      mkdirSync(dirname(settings), { recursive: true, mode: 0o700 });
      writeFileSync(settings, `${JSON.stringify({ theme: 'dark', apiKeyHelper: `cat -- ${o.helper ?? file}` }, null, 2)}\n`, { mode: 0o600 });
    }
    const auth = o.auth === undefined ? { loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' } : o.auth;
    if (auth) writeFileSync(join(T, `claude-status-${agent}`), JSON.stringify(auth, null, 2));
  };
  /** add-project, with no stdin (as the machine helper runs it), stopped by the test after `timeoutMs` if still running. */
  const run = (args: string[] = [name, 'example/alpha'], timeoutMs = 120_000) => {
    const started = Date.now();
    const r = spawnSync('bash', [join(s, 'add-project.sh'), ...args], { encoding: 'utf8', input: '', timeout: timeoutMs, killSignal: 'SIGKILL', env: { PATH: `${host}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: T } });
    const lines = (r.stdout ?? '').split('\n').filter(Boolean);
    return { ...r, ms: Date.now() - started, events: lines.map((l) => JSON.parse(l) as Step) };
  };
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8') : '');
  const hostCalls = () => (existsSync(join(T, 'host-calls')) ? readFileSync(join(T, 'host-calls'), 'utf8') : '');
  /** Another file of the agent user's own, private (0600), not empty: the kind a forged agent_api_key would name. */
  const privateFile = (rel: string) => {
    const f = join(agentHome, rel);
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f, 'not a key: a private file of the agent user\n', { mode: 0o600 });
    chmodSync(f, 0o600);
    return f;
  };
  return { T, s, run, keyed, keyFile, settings, creds, calls, hostCalls, agent, coord, agentHome, privateFile };
}

/**
 * An instance home for this user, in a temp instances dir, and the engine's CLI `instance set-agent-api-key` run
 * against it, with a stand-in for the user database (`getent passwd`) first on PATH: wl-alpha-agent's home is
 * `passwdHome` (null: no such user). instance.yaml's run_as names `yamlHome` as the agent's home (default the same;
 * the coordinator user writes that file, so it may name another); runAs false leaves run_as out.
 */
export function engineInstance(o: { runAs?: boolean; passwdHome?: string | null; yamlHome?: string } = {}) {
  const T = mkdtempSync(join(tmpdir(), 'set-agent-key-'));
  const dir = join(T, 'instances', 'alpha');
  mkdirSync(dir, { recursive: true });
  const agentHome = join(T, 'agent-home');
  const passwdHome = o.passwdHome === undefined ? agentHome : o.passwdHome;
  const runAs = o.runAs === false ? '' : `run_as:\n  agent_user: wl-alpha-agent\n  agent_home: ${o.yamlHome ?? agentHome}\n`;
  writeFileSync(join(dir, 'instance.yaml'), `version: 1\nname: alpha\nrepos:\n  - path: x\n    repo: example/alpha\n${runAs}`);
  /** Where credentials.sh <name> api-key installs the key: the agent's home, .config/<name>-claude-key/api_key. */
  const installed = join(agentHome, '.config', 'alpha-claude-key', 'api_key');
  mkdirSync(dirname(installed), { recursive: true });
  const bin = join(T, 'passwd-bin');
  mkdirSync(bin);
  const line = passwdHome === null ? 'exit 2' : `[ "$1" = passwd ] && [ "$2" = wl-alpha-agent ] && { echo "wl-alpha-agent:x:4242:4242::${passwdHome}:/bin/sh"; exit 0; }; exit 2`;
  writeFileSync(join(bin, 'getent'), `#!/bin/sh\n${line}\n`);
  chmodSync(join(bin, 'getent'), 0o755);
  const creds = join(dir, 'credentials.yaml');
  const text = 'version: 1\n# the App\ngithub:\n  kind: app\n  app_id: 91\n  installation_id: 4242\n  key_path: /x/private-key.pem\n';
  writeFileSync(creds, text, { mode: 0o600 });
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [engineCli, 'instance', 'set-agent-api-key', 'alpha', ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: T, [`${BRAND.envPrefix}_STATE_DIR`]: join(T, 'state'), [`${BRAND.envPrefix}_INSTANCES_DIR`]: join(T, 'instances') },
    });
  return { T, creds, text, cli, agentHome, installed };
}

/** Root's claude-account record of shop's agent user, signed in with an API key, the API taking it. */
export const AGENT = { instance: 'shop', kind: 'agent', user: 'wl-shop-agent', stored: false, logged_in: true, auth_method: 'api_key_helper', api_ok: true };

/**
 * A server instance (shop) whose agent_api_key is in its agent user's home, as its coordinator user sees the setup
 * steps: that home (the user database's, facts.agentHome) hidden from this user while checked, unless `visible`, and
 * root's account record. `key` picks agent_api_key in that home (default the installed key); agentHome false: no home known.
 */
export function coordinatorView(record: object | null, o: { key?: (agentHome: string) => string; agentHome?: boolean; visible?: boolean } = {}) {
  const { dir } = exampleProject();
  const m = mkdtempSync(join(tmpdir(), 'other-keys-machine-'));
  const machinePaths: MachinePaths = {
    enginePackage: join(m, 'package.json'),
    engine: join(m, 'opt-current'),
    helper: join(m, 'helper'),
    machineOwners: join(m, 'machine-owners.json'),
    updatesConfig: join(m, 'updates.json'),
    allowedSigners: join(m, 'allowed_signers'),
    hubUnitFile: join(m, 'hub.service'),
    fullRunLock: join(m, 'full-run.lock'),
    claudeAccountDir: join(m, 'claude-account'),
  };
  if (record) {
    mkdirSync(machinePaths.claudeAccountDir, { recursive: true });
    writeFileSync(join(machinePaths.claudeAccountDir, 'status.json'), JSON.stringify({ at: '2026-10-20T10:00:00Z', users: [record] }));
  }
  const home = mkdtempSync(join(tmpdir(), 'other-keys-instance-'));
  const agentHome = join(home, 'agent-home');
  const installed = join(agentHome, '.config', 'shop-claude-key', 'api_key');
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(installed, KEY, { mode: 0o400 });
  const key = o.key ? o.key(agentHome) : installed;
  const facts: InstanceFacts = { home, credentials: { github: { kind: 'app', key_path: join(home, 'app.pem') }, agent_api_key: key }, ...(o.agentHome === false ? {} : { agentHome }) };
  const ctx: SetupContext = { mode: 'server', root: dir, repo: 'example-org/example-shop', instance: 'shop', stateDir: projectStateDir(dir), policyFile: join(home, 'policy.yaml'), openQuestions: 0, setupPr: null, machine: machinePaths, instanceFacts: () => facts };
  const probe: SetupProbe = {
    which: (c) => `/stand-in/${c}`,
    serviceManagerEnv: () => ({ env: {} }),
    run: () => ({ status: 1, stdout: '', stderr: 'no stand-in' }),
    serviceRunning: () => false,
    systemUnitActive: () => false,
    linger: () => null,
  };
  const step = (v: SetupView) => v.groups.flatMap((g) => g.steps).find((s) => s.id === 'other-keys')!;
  const check = () => {
    if (o.visible) return step(checkSetup(ctx, probe));
    chmodSync(agentHome, 0o000);
    try {
      return step(checkSetup(ctx, probe));
    } finally {
      chmodSync(agentHome, 0o700);
    }
  };
  return { key, installed, agentHome, check };
}
