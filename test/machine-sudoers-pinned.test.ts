// Issue #898, #902 round 6 (the adversarial re-review):
//   - B2: a printed --replace-sudoers command is pinned to the rule it showed (--replace-sudoers=<sha256>). Pasted after
//     the engine's rule changed (a release landed, say), it refuses, shows the new diff and the new pinned command, and
//     writes nothing.
//   - B1: machine-helper.sh is the one check, at write time. add-project passes it only the user it may add
//     (--may-add=), never its trust in every name. A user root took out meanwhile stays out. And right before its write
//     it checks again that the rule is what its first check read.
// The machine is test/sudoers-machine-fixture.ts, with recording stand-ins for every host tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';
import { machine, withCommand, withoutCommand } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
const RERUN = "rerun as root with --replace-sudoers to install the engine's rule: ";
/** Host tools reached, but for the install stand-in a real setup script stops at (it refuses, changing nothing). */
const otherHostCalls = (calls: string) => calls.split('\n').filter((l) => l && !l.startsWith('install ')).join('\n');
const pinIn = (out: string) => /--replace-sudoers=([0-9a-f]{64})/.exec(out)?.[1];

test('#902 round 6 B2: the printed --replace-sudoers command is pinned to the rule it showed; pasted after that rule changed, it refuses and writes nothing', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  const narrower = withoutCommand(m.expected('alpha', 'old')).rule;
  m.setSudoers(narrower);
  const waits = m.run();
  assert.equal(waits.status, 3, waits.stderr);
  const shown = pinIn(waits.stderr);
  assert.ok(shown, `a pinned command: ${waits.stderr.slice(-600)}`);
  // A release lands before root pastes it: the engine's rule now grants more than the diff root read.
  for (const lib of [join(m.s, 'lib.sh'), join(m.real, 'lib.sh')]) appendFileSync(lib, "ADD_PROJECT_SUDOERS_ARGS='^add-project .*$'\n");
  const pasted = m.run([`--replace-sudoers=${shown}`]);
  assert.equal(pasted.status, 3, pasted.stderr);
  assert.equal(m.sudoers(), narrower, 'nothing written');
  assert.match(pasted.stderr, /^\+.*\^add-project \.\*\$/m, 'the new diff is shown');
  const fresh = pinIn(pasted.stderr.slice(pasted.stderr.lastIndexOf(RERUN)));
  assert.ok(fresh && fresh !== shown, pasted.stderr.slice(-600));
  assert.ok(pasted.stderr.includes(`${RERUN}sudo bash ${m.s}/add-project.sh alpha example/alpha --replace-sudoers=${fresh}\n`), pasted.stderr);
  // machine-helper.sh by hand holds the pin the same way.
  writeUser(m, 'wl-alpha');
  const h = m.helper(`--replace-sudoers=${shown}`, 'alpha', 'old');
  assert.equal(h.status, 3, h.stdout + h.stderr);
  assert.ok(h.stdout.includes(`${RERUN}sudo bash ${m.real}/machine-helper.sh --replace-sudoers=${fresh} alpha old\n`), h.stdout);
  assert.equal(m.sudoers(), narrower);
  // The pinned command it printed then installs exactly that rule.
  const ok = m.run([`--replace-sudoers=${fresh}`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(m.sudoers(), /\^add-project \.\*\$/);
  // A bare flag is refused outright.
  const bare = m.run(['--replace-sudoers']);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--replace-sudoers=<sha256>/);
  assert.equal(otherHostCalls(m.hostCalls()), '');
});

function writeUser(m: ReturnType<typeof machine>, u: string) {
  appendFileSync(join(m.T, 'users', u), '');
}

test('#902 round 6 B1: add-project passes machine-helper.sh only the user it may add, so a user root took out meanwhile is not put back', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  // The rule names alpha and old, with one retired command: stale, so the step reruns.
  m.setSudoers(withCommand(m.expected('alpha', 'old'), `${m.T}/helper claude-account switch`));
  // The real machine-helper.sh in place of the stand-in; and root's own change (wl-alpha taken out) lands right after
  // add-project's own check, as the review's probe placed it.
  copyFileSync(join(repoRoot, 'scripts', 'setup', 'machine-helper.sh'), join(m.s, 'machine-helper.sh'));
  const rootsRule = m.expected('old');
  appendFileSync(join(m.s, 'lib.sh'), `eval "real_$(declare -f sudoers_unified_diff)"
sudoers_unified_diff() { real_sudoers_unified_diff "$@"; if [ -e "$T/root-now" ]; then rm -f "$T/root-now"; cat "$T/roots-rule" > "$MACHINE_SUDOERS"; fi; }
`);
  appendFileSync(join(m.T, 'roots-rule'), rootsRule);
  appendFileSync(join(m.T, 'root-now'), '');
  const r = spawnSync('bash', [join(m.s, 'add-project.sh'), 'alpha', 'example/alpha'], { encoding: 'utf8', input: '', env: m.env });
  assert.equal(r.status, 3, r.stderr.slice(-1500));
  assert.equal(m.sudoers(), rootsRule, 'root\'s rule stands: wl-alpha is not put back');
  assert.equal(otherHostCalls(m.hostCalls()), '');
});

test('#902 round 6 B1: right before its write, machine-helper.sh refuses if the rule changed since its first check', { skip: !posix }, () => {
  const m = machine();
  writeUser(m, 'wl-alpha');
  m.setSudoers(m.expected('alpha', 'old'));
  const run = (script: string) => spawnSync('bash', ['-c', `source "$1"; ${script}`, '_', join(m.s, 'lib.sh')], { encoding: 'utf8', env: m.env });
  // Unchanged since the check: the write goes ahead.
  const same = run('seen="$(sudoers_state "$MACHINE_SUDOERS")"; machine_sudoers_commit_ok "$seen" "" "$(machine_sudoers wl-alpha wl-old)" 0; echo "rc=$?"');
  assert.match(same.stdout, /rc=0$/m, same.stdout + same.stderr);
  // Root's concurrent change between the check and the write (wl-alpha taken out): refused, exit 3, nothing written.
  appendFileSync(join(m.T, 'roots-rule'), m.expected('old'));
  const changed = run('seen="$(sudoers_state "$MACHINE_SUDOERS")"; cat "$T/roots-rule" > "$MACHINE_SUDOERS"; rc=0; machine_sudoers_commit_ok "$seen" "" "$(machine_sudoers wl-alpha wl-old)" 0 || rc=$?; echo "rc=$rc"');
  assert.match(changed.stdout, /rc=3$/m, changed.stdout + changed.stderr);
  assert.match(changed.stdout, /changed while this ran; nothing written/);
  assert.equal(m.sudoers(), m.expected('old'));
  // Root deletes the rule after the early check and before the write: refused too, and the rule stays away.
  m.setSudoers(m.expected('alpha', 'old'));
  const deleted = run('seen="$(sudoers_state "$MACHINE_SUDOERS")"; rm -f "$MACHINE_SUDOERS"; rc=0; machine_sudoers_commit_ok "$seen" "" "$(machine_sudoers wl-alpha wl-old)" 0 || rc=$?; echo "rc=$rc"');
  assert.match(deleted.stdout, /rc=3$/m, deleted.stdout + deleted.stderr);
  assert.ok(!existsSync(join(m.T, 'sudoers-machine')), 'not put back');
  // And machine-helper.sh writes only through that check: right before install_sudoers, and again inside it, after
  // visudo and right before its move (SUDOERS_PRECOMMIT); a failing check removes the temp file and moves nothing.
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'machine-helper.sh'), 'utf8');
  assert.match(sh, /\nmachine_sudoers_commit_ok "\$seen" "\$pin" "\$rule" "\$first" \$\{may\[@\]\+"\$\{may\[@\]\}"\} \|\| exit 3\nmachine_helper_precommit\(\) \{ machine_sudoers_precommit "\$1" "\$seen" "\$pin" "\$rule" "\$first" \$\{may\[@\]\+"\$\{may\[@\]\}"\}; \}\nSUDOERS_PRECOMMIT=machine_helper_precommit\ninstall_sudoers worklane-machine /);
  const lib = readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8');
  const install = lib.slice(lib.indexOf('install_sudoers() {'), lib.indexOf('\n}\n', lib.indexOf('install_sudoers() {')));
  assert.ok(install.indexOf('visudo -cf') < install.indexOf('"$SUDOERS_PRECOMMIT"') && install.indexOf('"$SUDOERS_PRECOMMIT"') < install.indexOf('mv -f'), install);
  assert.match(install, /! "\$SUDOERS_PRECOMMIT" "\$tmp"; then rm -f "\$tmp";[^\n]*exit 3; fi/);
  assert.match(lib, /^SUDOERS_PRECOMMIT=""$/m, 'set empty by lib.sh itself: never from the environment');
  // The lock every writer takes: machine-helper.sh and instance-remove.sh's removal.
  assert.match(sh, /\nmachine_sudoers_lock\n/);
  assert.match(lib, /\n {2}flock -w 120 8 \|\|/);
  // Round 9: under the lock, the rule is checked again (no other instance in it now) right before it goes.
  assert.match(readFileSync(join(repoRoot, 'scripts', 'setup', 'instance-remove.sh'), 'utf8'), /\n\s*machine_sudoers_lock\n(\s*#[^\n]*\n)*\s*if \[ "\$\(helper_mode\)" != remove \]; then\n\s*exec 8>&-\n\s*refuse [^\n]*\n\s*fi\n\s*remove_sudoers worklane-machine/);
  assert.equal(m.hostCalls(), '');
});
