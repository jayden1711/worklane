// Issue #898: the machine helper's sudoers rule follows the engine. add-project's machine-helper step is done only
// when the installed rule is byte for byte what machine-helper.sh writes for these instances (machine_sudoers): the
// helper's bytes alone (which the updater keeps in step) never make it done. A rerun then rewrites the rule through
// machine-helper.sh, so it can only ever end up equal to that script's output, never wider. `machine-helper.sh --check`
// says whether the rule is current, changing nothing, and the updater names a stale one with the exact command.
//
// Every setup script add-project runs is stood in for (as in add-project.test.ts), the paths point into a temp dir,
// and every host tool the scripts might reach (sudo, visudo, id, systemctl, ...) is a recording stand-in first on PATH
// that exits 1: the test asserts none was called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KINDS } from '../src/watchdog/index.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
const TOKEN = `sk-ant-oat01-${'Q'.repeat(40)}`;
const HOST_TOOLS = ['sudo', 'visudo', 'id', 'useradd', 'usermod', 'groupadd', 'getent', 'install', 'chown', 'systemctl', 'systemd-run', 'journalctl', 'launchctl', 'loginctl', 'gh', 'docker', 'tailscale', 'claude', 'setfacl'];

type Step = { step: string; state: string; detail: string; retry?: string };

/**
 * A machine in a temp dir. The real add-project.sh and machine-helper.sh sit beside a lib.sh that sources the real
 * one and points its paths, user and unit checks into the temp dir; sudo's version comes from <root>/sudo-version.
 * The stand-in machine-helper.sh writes what the real one writes: the helper's bytes, and printf '%s\n' of
 * machine_sudoers for the instances it is given (install_sudoers' format). "old" is on the machine already.
 */
function machine(sudoVersion = '1.9.15', rule = true) {
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
  // The real machine-helper.sh, for --check, in a tree of its own with the same lib.
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
install_claude_token() {
  mkdir -p "$T/homes/$1/.claude"
  { printf '{"claudeAiOauth":{"accessToken":"'; cat; printf '"}}'; } > "$T/homes/$1/.claude/.credentials.json"
}
SRV_ROOT="$T/srv" ENGINE_CLI="$T/bin/worklane" MACHINE_HELPER="$T/helper" MACHINE_SUDOERS="$T/sudoers-machine" HUB_UNIT="$T/hub.service" ADD_PROJECT_LOCK="$T/lock"
SETUP_POLL_SECONDS=0
`;
  writeFileSync(join(s, 'lib.sh'), lib);
  writeFileSync(join(real, 'lib.sh'), lib);
  const stub = (file: string, step: string, body: string) => {
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\nT=${JSON.stringify(T)}\necho "${step} $*" >> "$T/calls"\n${body}\n`);
    chmodSync(file, 0o755);
  };
  // Every host tool: recorded, and refused.
  for (const tool of HOST_TOOLS) {
    writeFileSync(join(T, 'host-bin', tool), `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(join(T, 'host-calls'))}\nexit 1\n`);
    chmodSync(join(T, 'host-bin', tool), 0o755);
  }
  stub(join(s, 'instance.sh'), 'instance', 'touch "$T/users/wl-$1" "$T/users/wl-$1-agent"; mkdir -p "$T/srv/$1"');
  stub(join(T, 'bin', 'worklane'), 'app', `[ "$1" = app-manifest ] || exit 2
d="$T/homes/wl-$2/.local/state/worklane/instances/$2"; printf 'version: 1\\ngithub:\\n  kind: app\\n  app_id: 91\\n' > "$d/credentials.yaml"
mkdir -p "$T/homes/wl-$2/.config/$2-app"; echo key > "$T/homes/wl-$2/.config/$2-app/private-key.pem"`);
  stub(join(s, 'checkout.sh'), 'checkout', 'mkdir -p "$T/srv/$1/${2#*/}/.git" "$T/srv/$1/${2#*/}/.worklane"; printf "suites: {}\\n" > "$T/srv/$1/${2#*/}/.worklane/tests.yaml"');
  stub(join(s, 'service.sh'), 'service', 'touch "$T/active/worklane-$1.service"');
  stub(join(s, 'test-user.sh'), 'test-user', ':');
  stub(join(s, 'machine-helper.sh'), 'machine-helper', `cp "$T/scripts/machine/worklane-machine.cjs" "$T/helper"
source "$T/scripts/setup/lib.sh"
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
  // The machine's rule before alpha: what machine-helper.sh wrote for old.
  if (rule) writeFileSync(join(T, 'sudoers-machine'), expected('old'));
  copyFileSync(helperSrc, join(T, 'helper'));
  const run = () => {
    const r = spawnSync('bash', [join(s, 'add-project.sh'), 'alpha', 'example/alpha'], { encoding: 'utf8', input: `${TOKEN}\n`, env });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { ...r, events: lines.map((l) => JSON.parse(l) as Step) };
  };
  const check = () => spawnSync('bash', [join(real, 'machine-helper.sh'), '--check'], { encoding: 'utf8', env });
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
  const hostCalls = () => (existsSync(join(T, 'host-calls')) ? readFileSync(join(T, 'host-calls'), 'utf8') : '');
  const helperRuns = () => calls().filter((c) => c.startsWith('machine-helper ')).length;
  const step = (r: { events: Step[] }) => r.events.find((e) => e.step === 'machine-helper' && e.state === 'done');
  return { T, s, real, env, expected, sudoers, run, check, calls, hostCalls, helperRuns, step };
}

/** An older engine's rule for these users: the same shape, one command fewer (the newest one it lacks). */
function olderRule(current: string) {
  const lines = current.split('\n');
  const i = lines.findIndex((l) => /^ {4}\S/.test(l));
  return [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n');
}

test('#898: a rerun after an upgrade rewrites a machine helper rule that differs from what machine-helper.sh writes, though the helper\'s bytes match and the instance is listed', { skip: !posix }, () => {
  const m = machine();
  const first = m.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(m.helperRuns(), 1);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'), 'the first run installs exactly machine-helper.sh\'s rule');

  // An older engine wrote the rule; the updater has since put the helper's bytes in step (it never touches sudoers).
  writeFileSync(join(m.T, 'sudoers-machine'), olderRule(m.expected('alpha', 'old')));
  assert.notEqual(m.sudoers(), m.expected('alpha', 'old'));
  const again = m.run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(m.helperRuns(), 2, 'the machine-helper step ran again: the bytes matching and the instance listed are not enough');
  assert.ok(m.calls().filter((c) => c.startsWith('machine-helper ')).every((c) => c === 'machine-helper alpha old'), m.calls().join('\n'));
  assert.equal(m.sudoers(), m.expected('alpha', 'old'), 'byte for byte what machine-helper.sh writes for these instances');

  // Current now: the next rerun skips it, and says why.
  const third = m.run();
  assert.equal(third.status, 0, third.stderr);
  assert.equal(m.helperRuns(), 2, 'a current rule is not rewritten');
  assert.match(m.step(third)!.detail, /what machine-helper\.sh writes/);
  assert.equal(m.hostCalls(), '', 'no host tool was reached');
});

test('#898: a rule wider than machine-helper.sh\'s is rewritten to exactly its output, never kept', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  writeFileSync(join(m.T, 'sudoers-machine'), `${m.expected('alpha', 'old')}wl-alpha ALL=(root) NOPASSWD: ALL\n`);
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(m.helperRuns(), 2);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.ok(!m.sudoers().includes('NOPASSWD: ALL\n'), 'the added line is gone');
  // A rule that names an instance whose user is gone is not current either: the rerun names only the ones there.
  writeFileSync(join(m.T, 'sudoers-machine'), m.expected('alpha', 'old').replace('wl-alpha, wl-old ALL=', 'wl-alpha, wl-gone, wl-old ALL='));
  assert.equal(m.run().status, 0);
  assert.equal(m.helperRuns(), 3);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.equal(m.hostCalls(), '');
});

test('#898: a sudo upgraded past 1.9.10 since the rule was written: the rerun installs the pattern rules it now can', { skip: !posix }, () => {
  const m = machine('1.9.9');
  assert.equal(m.run().status, 0);
  assert.ok(!m.sudoers().includes('^add-project'), 'an older sudo: no pattern rules');
  writeFileSync(join(m.T, 'sudo-version'), '1.9.15\n');
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(m.helperRuns(), 2);
  assert.ok(m.sudoers().includes('^add-project'), 'the pattern rules, now that sudo reads them');
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
});

test('#898: machine-helper.sh --check says absent, current or stale (with the exact command that rewrites it), and changes nothing', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'users', 'wl-alpha'), '');
  const snapshot = () => readdirSync(m.T, { recursive: true }).map(String).sort().map((f) => {
    const st = statSync(join(m.T, f));
    return `${f} ${st.mode} ${st.isFile() ? readFileSync(join(m.T, f), 'utf8') : ''}`;
  });
  const fix = `sudo bash ${m.real}/machine-helper.sh alpha old`;
  const file = join(m.T, 'sudoers-machine');

  writeFileSync(file, m.expected('alpha', 'old'));
  let before = snapshot();
  let r = m.check();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `current: ${file} is what machine-helper.sh writes for alpha old\n`);
  assert.deepEqual(snapshot(), before, 'nothing written');

  writeFileSync(file, olderRule(m.expected('alpha', 'old')));
  before = snapshot();
  r = m.check();
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, new RegExp(`^stale: ${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is not what machine-helper\\.sh writes for alpha old`));
  assert.ok(r.stdout.trimEnd().endsWith(`rewrite it, as root: ${fix}`), r.stdout);
  assert.deepEqual(snapshot(), before, 'nothing written');

  // Wider than its output: stale too.
  writeFileSync(file, `${m.expected('alpha', 'old')}wl-alpha ALL=(root) NOPASSWD: ALL\n`);
  r = m.check();
  assert.equal(r.status, 3);
  assert.ok(r.stdout.trimEnd().endsWith(fix));

  // No user left for any instance it names: the command removes it, as instance-remove.sh does for the last one.
  writeFileSync(file, m.expected('alpha', 'old').replace('wl-alpha, wl-old ALL=', 'wl-gone ALL='));
  r = m.check();
  assert.equal(r.status, 3);
  assert.ok(r.stdout.trimEnd().endsWith(`sudo rm -f ${file}`), r.stdout);

  const absent = machine('1.9.15', false);
  r = absent.check();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^absent: /);
  assert.ok(!existsSync(join(absent.T, 'sudoers-machine')), 'not created');
  assert.equal(m.hostCalls(), '');
  assert.equal(absent.hostCalls(), '');
});

type Check = { state: string; detail: string; fix?: string } | null;
const updater = () =>
  createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
    machineSudoersCheck(engineDir: string, exec?: typeof execFileSync): Check;
    run(deps: Record<string, unknown>): Promise<string>;
    SUDOERS_INCIDENT: string;
  };

test('#898: the updater reads machine-helper.sh --check of the installed engine: a stale rule with its exact fix command', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'users', 'wl-alpha'), '');
  const engine = join(m.T, 'real');
  // The check's own PATH, with the host tools' stand-ins first.
  const exec = ((file: string, args: string[], o: Record<string, unknown>) =>
    execFileSync(file, args, { ...o, env: { ...(o.env as Record<string, string>), PATH: `${join(m.T, 'host-bin')}:${(o.env as Record<string, string>).PATH}` } })) as unknown as typeof execFileSync;
  writeFileSync(join(m.T, 'sudoers-machine'), olderRule(m.expected('alpha', 'old')));
  const stale = updater().machineSudoersCheck(engine, exec)!;
  assert.equal(stale.state, 'stale');
  assert.equal(stale.fix, `sudo bash ${engine}/scripts/setup/machine-helper.sh alpha old`);
  assert.match(stale.detail, /is not what machine-helper\.sh writes for alpha old/);
  writeFileSync(join(m.T, 'sudoers-machine'), m.expected('alpha', 'old'));
  assert.equal(updater().machineSudoersCheck(engine, exec)!.state, 'current');
  // An engine with no machine-helper.sh: nothing to say.
  assert.equal(updater().machineSudoersCheck(join(m.T, 'no-engine'), exec), null);
  assert.equal(m.hostCalls(), '');
});

test('#898: every updater run, updates on or off, names a stale rule in the journal and as an incident with the fix; a current one closes it', async () => {
  const u = updater();
  const warned: string[] = [];
  const raised: string[][] = [];
  const resolved: string[][] = [];
  let answer: Check = { state: 'stale', detail: 'stale: /etc/sudoers.d/worklane-machine is not what machine-helper.sh writes for alpha; rewrite it, as root: sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh alpha', fix: 'sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh alpha' };
  const deps = {
    config: () => null,
    sudoersCheck: () => answer,
    warn: (l: string) => warned.push(l),
    raiseIncident: (...a: string[]) => raised.push(a),
    resolveIncident: (...a: string[]) => resolved.push(a),
    log: () => {},
  };
  assert.equal(await u.run(deps), 'disabled');
  assert.equal(warned.length, 1);
  assert.ok(warned[0]!.includes('sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh alpha'), warned[0]);
  assert.deepEqual(raised, [[u.SUDOERS_INCIDENT, 'machine-helper', answer!.detail, answer!.fix!]]);
  answer = { state: 'current', detail: 'current: ...' };
  await u.run(deps);
  assert.deepEqual(resolved, [[u.SUDOERS_INCIDENT, 'machine-helper']]);
  assert.equal(warned.length, 1, 'nothing said when it is current');
  // A check that throws never stops the run.
  const throwing = { ...deps, sudoersCheck: () => { throw new Error('boom'); } };
  assert.equal(await u.run(throwing), 'disabled');
  assert.match(warned.at(-1)!, /couldn't check the machine helper's sudoers rule: boom/);
  assert.deepEqual(KINDS[u.SUDOERS_INCIDENT as keyof typeof KINDS], { title: "The machine helper's sudoers rule is out of date", severity: 'amber' });
});
