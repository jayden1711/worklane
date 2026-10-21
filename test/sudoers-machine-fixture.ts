// A machine in a temp dir for the machine helper's sudoers rule (#898), shared by test/machine-sudoers-rerun.test.ts
// and test/machine-sudoers-narrow.test.ts. Every setup script add-project runs is stood in for (as in
// add-project.test.ts), the paths point into the temp dir, and every host tool the scripts might reach (sudo, visudo,
// id, systemctl, ...) is a recording stand-in first on PATH that exits 1, so a test can assert none was called.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const setupDir = join(repoRoot, 'scripts', 'setup');
export const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
const TOKEN = `sk-ant-oat01-${'Q'.repeat(40)}`;
const HOST_TOOLS = ['sudo', 'visudo', 'id', 'useradd', 'usermod', 'groupadd', 'getent', 'install', 'chown', 'systemctl', 'systemd-run', 'journalctl', 'launchctl', 'loginctl', 'gh', 'docker', 'tailscale', 'claude', 'setfacl'];

export type Step = { step: string; state: string; detail: string; retry?: string };

/**
 * The real add-project.sh and machine-helper.sh sit beside a lib.sh that sources the real one and points its paths,
 * user and unit checks into the temp dir; sudo's version comes from <root>/sudo-version. The stand-in machine-helper.sh
 * writes what the real one writes: the helper's bytes, and printf '%s\n' of machine_sudoers for the instances it is
 * given (install_sudoers' format), taking --replace-sudoers as its first argument the way the real one does. "old" is
 * on the machine already, in the rule (unless `rule` is false) and the hub.
 */
export function machine(sudoVersion = '1.9.15', rule = true) {
  const T = mkdtempSync(join(tmpdir(), 'sudoers-rerun-'));
  const s = join(T, 'scripts', 'setup');
  const real = join(T, 'real', 'scripts', 'setup');
  mkdirSync(s, { recursive: true });
  mkdirSync(real, { recursive: true });
  mkdirSync(join(T, 'scripts', 'machine'), { recursive: true });
  mkdirSync(join(T, 'real', 'scripts', 'machine'), { recursive: true });
  for (const d of ['users', 'active', 'homes', 'srv', 'bin', 'host-bin']) mkdirSync(join(T, d), { recursive: true });
  copyFileSync(join(setupDir, 'add-project.sh'), join(s, 'add-project.sh'));
  copyFileSync(helperSrc, join(T, 'scripts', 'machine', 'worklane-machine.cjs'));
  // The real machine-helper.sh, in a tree of its own with the same lib.
  copyFileSync(join(setupDir, 'machine-helper.sh'), join(real, 'machine-helper.sh'));
  copyFileSync(helperSrc, join(T, 'real', 'scripts', 'machine', 'worklane-machine.cjs'));
  writeFileSync(join(T, 'sudo-version'), `${sudoVersion}\n`);
  const lib = `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
as_root() { :; }
home_of() { echo "$T/homes/$1"; }
user_exists() { [ -e "$T/users/$1" ]; }
unit_active() { [ -e "$T/active/$1" ]; }
sudo_version() { cat "$T/sudo-version"; }
run_as() { local user="$1" script="$2"; shift 2; HOME="$T/homes/$user" bash -euo pipefail -c "$script" _ "$@"; }
ensure_instance_home() {
  local d="$T/homes/wl-$1/.local/state/worklane/instances/$1"
  mkdir -p "$d/state"
  printf 'version: 1\\nname: %s\\nrepos:\\n  - path: "x"\\n    repo: %s\\n' "$1" "$2" > "$d/instance.yaml"
  printf 'version: 1\\nbudget: { daily_usd: 20 }\\nagents: { max_workers: 2 }\\nland_mode: pr\\nauto_merge: false\\n' > "$d/policy.yaml"
}
claude_login_ok() { :; }
# The policy step's root ownership (#726), stood in as add-project.test.ts does: root's once owned.
own_policy() { touch "$T/owned-$1"; }
policy_root_ok() { [ -e "$T/owned-$1" ]; }
POLICY_ROOT_DIR="$T/policy-root"
install_claude_token() {
  mkdir -p "$T/homes/$1/.claude"
  { printf '{"claudeAiOauth":{"accessToken":"'; cat; printf '"}}'; } > "$T/homes/$1/.claude/.credentials.json"
}
SRV_ROOT="$T/srv" ENGINE_CLI="$T/bin/worklane" MACHINE_HELPER="$T/helper" MACHINE_SUDOERS="$T/sudoers-machine" HUB_UNIT="$T/hub.service" ADD_PROJECT_LOCK="$T/lock"
ADD_PROJECT_NEW="$T/add-project-new" ADD_PROJECT_NEW_UID=${process.getuid?.() ?? 0}
SETUP_POLL_SECONDS=0
`;
  writeFileSync(join(s, 'lib.sh'), lib);
  writeFileSync(join(real, 'lib.sh'), lib);
  chmodSync(join(real, 'lib.sh'), 0o644);
  chmodSync(join(real, 'machine-helper.sh'), 0o644);
  // The engine's directories as a machine has them (owner's alone, 0755), whatever this process's umask.
  for (const d of [join(T, 'real'), join(T, 'real', 'scripts'), real]) chmodSync(d, 0o755);
  const stub = (file: string, step: string, body: string) => {
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\nT=${JSON.stringify(T)}\necho "${step} $*" >> "$T/calls"\n${body}\n`);
    chmodSync(file, 0o755);
  };
  // Every host tool: recorded, and refused.
  for (const tool of HOST_TOOLS) {
    writeFileSync(join(T, 'host-bin', tool), `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(join(T, 'host-calls'))}\nexit 1\n`);
    chmodSync(join(T, 'host-bin', tool), 0o755);
  }
  // As the real instance.sh: a coordinator it makes goes on root's list of instances being created (#898).
  stub(join(s, 'instance.sh'), 'instance', 'source "$T/scripts/setup/lib.sh"; user_exists "wl-$1" || new_instance_mark "$1"; touch "$T/users/wl-$1" "$T/users/wl-$1-agent"; mkdir -p "$T/srv/$1"');
  stub(join(T, 'bin', 'worklane'), 'app', `[ "$1" = app-manifest ] || exit 2
d="$T/homes/wl-$2/.local/state/worklane/instances/$2"; printf 'version: 1\\ngithub:\\n  kind: app\\n  app_id: 91\\n' > "$d/credentials.yaml"
mkdir -p "$T/homes/wl-$2/.config/$2-app"; echo key > "$T/homes/wl-$2/.config/$2-app/private-key.pem"`);
  stub(join(s, 'checkout.sh'), 'checkout', 'mkdir -p "$T/srv/$1/${2#*/}/.git" "$T/srv/$1/${2#*/}/.worklane"; printf "suites: {}\\n" > "$T/srv/$1/${2#*/}/.worklane/tests.yaml"');
  stub(join(s, 'service.sh'), 'service', 'touch "$T/active/worklane-$1.service"');
  stub(join(s, 'test-user.sh'), 'test-user', ':');
  stub(join(s, 'machine-helper.sh'), 'machine-helper', `cp "$T/scripts/machine/worklane-machine.cjs" "$T/helper"
source "$T/scripts/setup/lib.sh"
if [ "\${1:-}" = --replace-sudoers ]; then shift; fi
users=(); for n in "$@"; do users+=("wl-$n"); done
content="$(machine_sudoers "\${users[@]}")"
printf '%s\\n' "$content" > "$T/sudoers-machine"`);
  stub(join(s, 'dashboards.sh'), 'dashboards', `opts=""; while [ "$#" -gt 0 ] && [ "\${1#--}" != "$1" ]; do opts="$opts $1 $2"; shift 2; done
hub=""; for n in "$@"; do hub="\${hub:+$hub,}$n=$T/homes/wl-$n/state"; touch "$T/active/worklane-dashboard-$n.service"; done
printf '[Service]\\nExecStart=/usr/local/bin/worklane dashboard --hub %s --service%s --signin-dir /x\\n' "$hub" "$opts" > "$T/hub.service"`);
  for (const u of ['wl-old', 'wl-old-agent']) writeFileSync(join(T, 'users', u), '');
  mkdirSync(join(T, 'homes', 'wl-old', '.local', 'state', 'worklane', 'instances', 'old', 'state'), { recursive: true });
  writeFileSync(join(T, 'hub.service'), `[Service]\nExecStart=/usr/local/bin/worklane dashboard --hub old=${T}/homes/wl-old/state --service --client-id Iv1.signin0001 --public-url https://hub.example.test --signin-dir /x\n`);
  const hubTok = join(T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub');
  mkdirSync(hubTok, { recursive: true });
  writeFileSync(join(hubTok, 'dashboard-token'), 't');
  const env = { PATH: `${join(T, 'host-bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: T, LANG: 'C.UTF-8' };
  /** machine_sudoers for these instances, as install_sudoers writes it: the content and one newline. */
  const expected = (...names: string[]) => {
    const r = spawnSync('bash', ['-c', 'source "$1"; shift; c="$(machine_sudoers "$@")"; printf "%s\\n" "$c"', '_', join(s, 'lib.sh'), ...names.map((n) => `wl-${n}`)], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const sudoers = () => readFileSync(join(T, 'sudoers-machine'), 'utf8');
  const setSudoers = (text: string) => writeFileSync(join(T, 'sudoers-machine'), text);
  // The machine's rule before alpha: what machine-helper.sh wrote for old.
  if (rule) setSudoers(expected('old'));
  copyFileSync(helperSrc, join(T, 'helper'));
  const run = (extra: string[] = []) => {
    const r = spawnSync('bash', [join(s, 'add-project.sh'), 'alpha', 'example/alpha', ...extra], { encoding: 'utf8', input: `${TOKEN}\n`, env });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { ...r, events: lines.map((l) => JSON.parse(l) as Step) };
  };
  /** The real machine-helper.sh, with these arguments (--check, or names). */
  const helper = (...args: string[]) => spawnSync('bash', [join(real, 'machine-helper.sh'), ...args], { encoding: 'utf8', env });
  const check = () => helper('--check');
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
  const hostCalls = () => (existsSync(join(T, 'host-calls')) ? readFileSync(join(T, 'host-calls'), 'utf8') : '');
  const helperRuns = () => calls().filter((c) => c.startsWith('machine-helper ')).length;
  const step = (r: { events: Step[] }) => r.events.find((e) => e.step === 'machine-helper' && e.state === 'done');
  return { T, s, real, env, expected, sudoers, setSudoers, run, helper, check, calls, hostCalls, helperRuns, step };
}

/** An older engine's rule for these users: the same shape, one command fewer. Returns the rule and the command. */
export function olderRule(current: string): string {
  return withoutCommand(current).rule;
}
export function withoutCommand(current: string): { rule: string; command: string } {
  const lines = current.split('\n');
  const i = lines.findIndex((l) => /^ {4}\S/.test(l));
  return { rule: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n'), command: lines[i]!.trim().replace(/, \\$/, '') };
}

/** The rule with one more command in its Cmnd_Alias (a command an older engine granted and this one doesn't). */
export function withCommand(current: string, command: string): string {
  const lines = current.split('\n');
  const i = lines.findIndex((l) => l.startsWith('Cmnd_Alias '));
  return [...lines.slice(0, i + 1), `    ${command}, \\`, ...lines.slice(i + 1)].join('\n');
}
