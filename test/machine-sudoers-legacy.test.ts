// Issue #902 round 9: an instance made before machine and console were reserved (round 8) keeps every OFF and removal
// path, and never goes back into the machine helper's rule.
//   - Root's `policy set <n> auto_merge off`, and a coordinator's set-policy through the helper, reach it; a root policy
//     under such a name only tightens.
//   - Its instance.yaml loads, so instance-remove.sh exports it and goes on past the export.
//   - Every list instance-remove.sh, add-project, a rename and --check pass to machine-helper.sh holds only names it
//     takes: the legacy coordinator is left out of the rule (a narrowing), so removing another instance gets past the
//     rule step and --check's printed command passes the helper's checks.
//   - The removal's rule step is decided under add-project's lock, and a `remove` is checked again under the rule's
//     lock: a rule another writer changed meanwhile is never taken away whole (the round-8 delta check's race).
//   - N2: the group wl-<n>-work and the sudoers file worklane-<n> count as traces of an instance (not new).
//   - N3: instance-remove.sh's PATH is lib.sh's ROOT_PATH, and every host tool it reaches here is a stand-in.
// The machine is test/sudoers-machine-fixture.ts; each test adds its own stand-ins to its lib.sh (host tools as
// functions, which no PATH reset drops, and an install that writes only inside the test's temp dir), so no run here
// reaches a host tool or a path outside its temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { initInstance, loadInstance } from '../src/instance.js';
import { autoMergeKilled } from '../src/policy-kill.js';
import { setPolicyRootUid } from '../src/policy-gate.js';
import { ownPolicy, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';
import { SYSTEM_ROOT_VAR, TEST_MACHINE_VAR, TEST_TOKEN_VAR } from '../src/os/system-paths.js';
import { engineCli, exampleProject, repoRoot } from './helpers.js';
import { machine } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
const linux = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc/self/fd)';
type M = ReturnType<typeof machine>;
const setupDir = join(repoRoot, 'scripts', 'setup');
const helper = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-machine.cjs`)) as { coordinatorInstance: (u: string) => string | null; policyInstance?: (u: string) => string | null };
const me = posix ? process.getuid!() : 0;
const TOOLS = ['sudo', 'visudo', 'id', 'useradd', 'usermod', 'userdel', 'groupadd', 'groupdel', 'getent', 'chown', 'systemctl', 'systemd-run', 'journalctl', 'launchctl', 'loginctl', 'gh', 'docker', 'tailscale', 'claude', 'setfacl', 'pgrep', 'pkill', 'findmnt', 'losetup', 'mount', 'umount'];
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

/**
 * This test's stand-ins, added to the fixture's lib.sh: every host tool a function that records and fails (a PATH reset
 * can't drop a function), an install that writes only inside the temp dir, the sudoers writers into it, and node.
 */
function standIns(m: M, file = join(m.s, 'lib.sh')) {
  appendFileSync(file, `
ROOT_PATH="$T/host-bin:/usr/bin:/bin" REMOVED_ARCHIVE="$T/removed"
${TOOLS.map((t) => `${t}() { echo "${t} $*" >> "$T/host-calls"; return 1; }`).join('\n')}
node() { ${JSON.stringify(process.execPath)} "$@"; }
install() {
  local d=0 p=() last
  echo "install $*" >> "$T/calls"
  while [ "$#" -gt 0 ]; do case "$1" in -d) d=1; shift ;; -o | -g | -m) shift 2 ;; *) p+=("$1"); shift ;; esac; done
  if [ "$d" = 1 ]; then for last in "\${p[@]}"; do case "$last" in "$T"/*) ;; *) echo "stand-in install: $last is outside the test" >&2; return 1 ;; esac; done; mkdir -p "\${p[@]}"; return 0; fi
  last="\${p[\${#p[@]}-1]}"
  case "$last" in "$T"/*) cp -- "\${p[0]}" "$last" ;; *) echo "stand-in install: $last is outside the test" >&2; return 1 ;; esac
}
instance_in_flight() { :; }
instance_mounts() { :; }
group_exists() { [ -e "$T/groups/$1" ]; }
sudoers_installed() { [ -e "$T/sudoers.d/$1" ]; }
remove_sudoers() { echo "remove_sudoers $1" >> "$T/calls"; if [ "$1" = worklane-machine ]; then rm -f -- "$MACHINE_SUDOERS"; else rm -f -- "$T/sudoers.d/$1"; fi; }
install_sudoers() {
  local tmp="$T/.sudoers.tmp" to="$T/sudoers.d/$1"
  [ "$1" != worklane-machine ] || to="$MACHINE_SUDOERS"
  sudoers_bytes "$2" > "$tmp"
  if [ -n "$SUDOERS_PRECOMMIT" ] && ! "$SUDOERS_PRECOMMIT" "$tmp"; then rm -f "$tmp"; echo "sudoers $1: not installed (above)" >&2; exit 3; fi
  mkdir -p "$T/sudoers.d"; mv -f "$tmp" "$to"; echo "installed $1"
}
`);
}

/** instance-remove.sh in the machine, its registry stood in: `plan` runs `onPlan` (shell), `remove` writes its archive file. */
function removable(m: M, onPlan = '') {
  copyFileSync(join(setupDir, 'instance-remove.sh'), join(m.s, 'instance-remove.sh'));
  chmodSync(join(m.s, 'instance-remove.sh'), 0o644);
  writeFileSync(join(m.s, 'plan-hook.sh'), `T=${JSON.stringify(m.T)}\n${onPlan}\n`);
  writeFileSync(join(m.s, 'instance-records.cjs'), `const fs = require('node:fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(m.T, 'reached'))}, 'instance-records ' + a.join(' ') + '\\n');
if (a[0] === 'plan') require('node:child_process').execFileSync('bash', [${JSON.stringify(join(m.s, 'plan-hook.sh'))}], { stdio: 'inherit' });
if (a[0] === 'hold-slot') console.log(${JSON.stringify(join(m.T, 'slot'))});
if (a[0] === 'remove') fs.writeFileSync(a[2], '{}');
`);
  standIns(m);
  // The machine's isolation, for the engine the export runs (src/os/system-paths.ts): its state stays in the temp dir.
  const iso = Object.fromEntries([SYSTEM_ROOT_VAR, TEST_TOKEN_VAR, TEST_MACHINE_VAR].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
  return (name: string) => spawnSync('bash', [join(m.s, 'instance-remove.sh'), name, '--yes'], { encoding: 'utf8', input: '', env: { ...m.env, ...iso } });
}

/** A stand-in machine-helper.sh that checks its names with lib.sh's rules, as the real one does, then writes the rule. */
function namedHelper(m: M) {
  writeFileSync(join(m.s, 'machine-helper.sh'), `#!/usr/bin/env bash
set -euo pipefail
T=${JSON.stringify(m.T)}
echo "machine-helper $*" >> "$T/calls"
source "$T/scripts/setup/lib.sh"
while [ "\${1#--}" != "\${1:-}" ]; do shift; done
users=(); for n in "$@"; do need_instance_name "$n"; users+=("wl-$n"); done
content="$(machine_sudoers "\${users[@]}")"
printf '%s\\n' "$content" > "$T/sudoers-machine"
`);
}

const user = (m: M, ...us: string[]) => { for (const u of us) writeFileSync(join(m.T, 'users', u), ''); };

test('#902 round 9: root\'s auto_merge off and the helper\'s set-policy reach an instance named console or machine; under such a name a policy only tightens', { skip: linux }, () => {
  for (const name of ['console', 'machine']) {
    const markers = mkdtempSync(join(tmpdir(), 'legacy-kill-'));
    assert.deepEqual(setPolicy(name, 'auto_merge', 'off', null, { markerDir: markers, presence: () => 'exists' }), { key: 'auto_merge', from: null, to: false }, name);
    assert.equal(autoMergeKilled(name, markers), true, `${name}: armed`);
    // The coordinator's set-policy through the helper: its instance from SUDO_USER, any name in the shape.
    assert.equal(helper.policyInstance?.(`wl-${name}`), name, `the helper's set-policy for wl-${name}`);
    assert.equal(helper.coordinatorInstance(`wl-${name}`), null, 'every other helper step keeps the instance-name rules');
  }
  for (const bad of ['wl-Console', 'console', 'wl-', 'wl-a/b']) assert.equal(helper.policyInstance?.(bad) ?? null, null, bad);
  assert.throws(() => setPolicy('Console', 'auto_merge', 'off', null, { markerDir: mkdtempSync(join(tmpdir(), 'legacy-kill-')), presence: () => 'exists' }), /no instance/);

  // Its root policy (made root's before the upgrade, or now): root and its coordinator may tighten it, never loosen it.
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-policy-')));
  const dir = join(T, 'home', 'wl-console', '.local', 'state', BRAND.cli, 'instances', 'console');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 50 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: false\n', { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === 'wl-console' ? join(T, 'home', 'wl-console') : null), uid: () => me, rootUid: me, rootGid: process.getgid!(), limitsPath: join(T, 'limits.json'), markerDir: join(T, 'markers') };
  setPolicyRootUid(me);
  try {
    ownPolicy('console', deps);
    assert.deepEqual(setPolicy('console', 'budget.daily_usd', '30', 'wl-console', deps), { key: 'budget.daily_usd', from: 50, to: 30 });
    assert.deepEqual(setPolicy('console', 'budget.daily_usd', '20', null, deps), { key: 'budget.daily_usd', from: 30, to: 20 });
    assert.throws(() => setPolicy('console', 'budget.daily_usd', '80', null, deps), /would loosen it.*only tightens/);
    assert.throws(() => setPolicy('console', 'auto_merge', 'on', null, deps), /could loosen console/);
  } finally {
    setPolicyRootUid(0);
  }
});

test('#902 round 9: an instance named console loads, and instance-remove.sh exports it and goes on past the export', { skip: !posix }, () => {
  const m = machine();
  user(m, 'wl-console', 'wl-console-agent');
  // Its instance home as `instance init` made it before the name was reserved (made here as shop, then named console).
  const instances = join(m.T, 'homes', 'wl-console', '.local', 'state', BRAND.cli, 'instances');
  mkdirSync(instances, { recursive: true });
  const home = initInstance('shop', exampleProject().dir, 'example-org/example-shop', instances, 'wl-console-agent', join(m.T, 'homes', 'wl-console-agent'));
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\n');
  renameSync(home, join(instances, 'console'));
  const yaml = join(instances, 'console', 'instance.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^name: shop$/m, 'name: console'));
  assert.equal(loadInstance('console', instances).name, 'console');
  // The rule names it, with old: its removal rewrites the rule for old alone.
  m.setSudoers(m.expected('console', 'old'));
  const run = removable(m);
  namedHelper(m);
  writeFileSync(join(m.T, 'bin', 'engine'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(engineCli)} "$@"\n`);
  chmodSync(join(m.T, 'bin', 'engine'), 0o755);
  appendFileSync(join(m.s, 'lib.sh'), 'ENGINE_CLI="$T/bin/engine"\n');
  const r = run('console');
  const out = r.stdout + r.stderr;
  assert.match(r.stderr, /note: console is a name the instance-name rules refuse now/);
  assert.equal(m.sudoers(), m.expected('old'), `the rule, rewritten for old: ${out}`);
  const bundles = existsSync(join(m.T, 'removed')) ? readdirSync(join(m.T, 'removed')).filter((f) => /^console-\d{8}T\d{6}Z\.bundle$/.test(f)) : [];
  assert.equal(bundles.length, 1, `its history exported: ${out}`);
  assert.match(r.stdout, /exported console's history: /);
  assert.match(read(join(m.T, 'reached')), /^instance-records remove console /m, 'past the export: the registry\'s items');
  // Where it stopped here: the unit reload, a stand-in. Every host tool it reached is one, recorded.
  const host = read(join(m.T, 'host-calls')).trim().split('\n').filter(Boolean);
  assert.ok(host.includes('systemctl daemon-reload'), host.join('\n'));
  assert.deepEqual([...new Set(host.map((l) => l.split(' ')[0]))].sort(), ['chown', 'systemctl'], host.join('\n'));
});

test('#902 round 9: removing another instance on a machine with a console instance gets past the rule step, which leaves console out', { skip: !posix }, () => {
  const m = machine();
  user(m, 'wl-alpha', 'wl-alpha-agent', 'wl-console');
  m.setSudoers(m.expected('alpha', 'console', 'old'));
  const run = removable(m);
  namedHelper(m);
  const r = run('alpha');
  assert.match(read(join(m.T, 'calls')), /^machine-helper --may-add= old$/m, r.stdout + r.stderr);
  assert.equal(m.sudoers(), m.expected('old'), 'alpha and console out: a narrowing');
  assert.doesNotMatch(r.stderr, /machine's own sudoers file/);
  assert.match(read(join(m.T, 'calls')), /^install -d /m, `past the rule step: ${r.stdout}${r.stderr}`);
  // It goes on to the unit reload (a stand-in, where it stops here): the one host tool it reached.
  assert.equal(read(join(m.T, 'host-calls')), 'systemctl daemon-reload\n');
});

test('#902 round 9: --check leaves a console coordinator out, and the command it prints passes machine-helper.sh\'s checks', { skip: !posix }, () => {
  const m = machine();
  user(m, 'wl-console');
  standIns(m, join(m.real, 'lib.sh'));
  m.setSudoers(m.expected('console', 'old'));
  const c = m.check();
  assert.equal(c.status, 3, c.stdout + c.stderr);
  const cmd = /^stale: .*: sudo bash (\S+) (.*)$/m.exec(c.stdout);
  assert.ok(cmd, c.stdout);
  assert.equal(cmd[2], '--may-add= old');
  // The printed command: its names pass (no exit 2), it checks the rule and shows its diff, and goes on to the write.
  const h = m.helper(...cmd[2].split(' '));
  assert.notEqual(h.status, 2, h.stdout + h.stderr);
  assert.doesNotMatch(h.stderr, /machine's own sudoers file/);
  assert.match(h.stdout, /^-wl-console, wl-old ALL=\(root\) NOPASSWD: WORKLANE_MACHINE$/m, h.stdout + h.stderr);
  assert.match(h.stdout + h.stderr, /== the helper, root-owned|no \/etc\/worklane; run machine\.sh first/);
  assert.equal(read(join(m.T, 'host-calls')), '');
});

test('#902 round 9: add-project and a rename leave a console coordinator out of the rule they write', { skip: !posix }, () => {
  const m = machine();
  user(m, 'wl-console');
  m.setSudoers(m.expected('console', 'old'));
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'), 'console left out: a narrowing');
  assert.match(r.stderr, /note: console is a name the instance-name rules refuse now/);
  assert.equal(m.hostCalls(), '');
  const rename = readFileSync(join(setupDir, 'instance-rename.sh'), 'utf8');
  assert.match(rename, /names="\$\(\{ helper_instances; echo "\$new"; \} \| sort -u \| while read -r n; do if instance_name_ok "\$n" && user_exists "wl-\$n"; then/);
  assert.match(rename, /for m in \$\(\{ helper_instances; echo "\$new"; \} \| sort -u\); do if \[ "\$m" = "\$new" \] \|\| \{ instance_name_ok "\$m" && user_exists "wl-\$m"; \}; then pre\+=/);
});

test('#902 round 9: a removal decided on a rule another writer changes before its step never takes that rule away whole', { skip: !posix }, () => {
  const m = machine();
  user(m, 'wl-alpha', 'wl-alpha-agent');
  m.setSudoers(m.expected('alpha'));
  const ab = m.expected('alpha', 'beta');
  // In the window: beta's add finishes (its user made, the rule rewritten with it).
  const run = removable(m, `touch "$T/users/wl-beta"; printf '%s' ${JSON.stringify(ab)} > "$T/sudoers-machine"`);
  const r = run('alpha');
  assert.ok(existsSync(join(m.T, 'sudoers-machine')), `the rule is still there: ${r.stdout}${r.stderr}`);
  assert.match(m.sudoers(), /wl-beta/, 'beta keeps its grant');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /changed while this ran/);
  assert.doesNotMatch(read(join(m.T, 'calls')), /^remove_sudoers worklane-machine$/m);
  assert.equal(read(join(m.T, 'host-calls')), '');
  // And the step is decided under add-project's lock, before anything changes.
  const src = readFileSync(join(setupDir, 'instance-remove.sh'), 'utf8');
  const lock = src.indexOf('machine_lock 9 "$ADD_PROJECT_LOCK" 0 ');
  assert.ok(lock > 0 && lock < src.indexOf('helper_step="$(helper_mode)"') && src.indexOf('helper_step="$(helper_mode)"') < src.indexOf('records hold-slot'));
});

test('#902 round 9 N1: a rule outside the engine\'s shape stops the removal of an instance it lists, naming root\'s --replace-sudoers', { skip: !posix }, () => {
  const m = machine();
  user(m, 'wl-alpha', 'wl-alpha-agent');
  m.setSudoers(`${m.expected('alpha', 'old')}wl-alpha ALL=(ALL) ALL\n`);
  const before = m.sudoers();
  const r = removable(m)('alpha');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /isn't in the engine's own shape.*--replace-sudoers=<pin> command printed above/);
  assert.match(r.stdout + r.stderr, /machine-helper\.sh --replace-sudoers=[0-9a-f]{64} old/);
  assert.equal(m.sudoers(), before);
  assert.ok(!existsSync(join(m.T, 'reached')), 'nothing past the rule step');
});

test('#902 round 9 N2: a group wl-<n>-work or a sudoers file worklane-<n> left behind is a trace: the name is not marked new', { skip: !posix }, () => {
  const mark = (plant: (m: M) => void) => {
    const m = machine();
    standIns(m);
    plant(m);
    const r = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; new_instance_mark_if_new beta; if new_instance_marked beta; then echo yes; else echo no; fi', '_', join(m.s, 'lib.sh')], { encoding: 'utf8', env: m.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(join(m.T, 'host-calls')), '');
    return r.stdout.trim();
  };
  assert.equal(mark(() => {}), 'yes', 'nothing of beta: new');
  assert.equal(mark((m) => { mkdirSync(join(m.T, 'groups')); writeFileSync(join(m.T, 'groups', 'wl-beta-work'), ''); }), 'no', 'its group');
  assert.equal(mark((m) => { mkdirSync(join(m.T, 'sudoers.d')); writeFileSync(join(m.T, 'sudoers.d', `${BRAND.cli}-beta`), ''); }), 'no', 'its sudoers file');
});

test('#902 round 9: the names reserved since stay usable where an instance already is, and nowhere it is made', { skip: !posix }, () => {
  const names = ['console', 'machine', 'alpha', 'update', 'test-x', 'dash', 'Bad', ''];
  const r = spawnSync('bash', ['-c', 'source "$1"; shift; for n in "$@"; do printf "%s\\x1e" "$(kept_instance_name_problem "$n")"; done', '_', join(setupDir, 'lib.sh'), ...names], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const kept = r.stdout.split('\x1e').slice(0, -1);
  assert.deepEqual(kept.map((k) => k === ''), [true, true, true, false, false, false, false, false]);
  // Where an instance is served, checked, turned off or removed: the kept rule. Where one is made: the strict one.
  const src = (f: string) => readFileSync(join(setupDir, f), 'utf8');
  assert.match(src('dashboards.sh'), /for name in "\$@"; do\n\s+need_instance_name "\$name" "instance name" kept\n/);
  assert.match(src('test-user.sh'), /if \[ "\$cmd" = check \] \|\| \[ "\$cmd" = remove \]; then need_instance_name "\$name" "the instance name" kept; else\nneed_instance_name "\$name" "the instance name"\n/);
  assert.match(src('experiments.sh'), /\[ "\$sub" = remove \]; \}; then need_instance_name "\$name" "the instance name" kept; else/);
  assert.match(src('testrun-network.sh'), /disable\) kept_instance_name_ok "\$name"/);
  assert.match(src('testrun-gpu.sh'), /disable\) kept_instance_name_ok "\$name"/);
  for (const f of ['instance.sh', 'add-project.sh']) assert.match(src(f), /^need_instance_name "\$name"$/m, f);
  const made = mkdtempSync(join(tmpdir(), 'legacy-init-'));
  assert.throws(() => initInstance('console', exampleProject().dir, 'example-org/x', made, 'wl-console-agent', join(made, 'agent')), /machine's own sudoers file/);
});
