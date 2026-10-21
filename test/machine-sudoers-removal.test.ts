// Issue #898, #902 round 8: what a revocation leaves, and what the dashboard is shown.
//   - A1: a coordinator root took out of the machine helper's rule and deleted by hand, with its agent user, its
//     checkout root or its hub entry left, is no new instance: the real instance.sh, run again by add-project, doesn't
//     put it on root's list, so its next add waits for --replace-sudoers. Only an instance nothing of which is on the
//     machine is marked.
//   - A2: add-project's JSON output (the waiting detail the dashboard stores and shows, with no diff beside it) never
//     carries a --replace-sudoers pin; the pinned command is on stderr, right after the diff it was printed for.
//   - A3: instance-remove.sh never waits on a widening: on an older engine's rule it goes on, and machine-helper.sh
//     --drop=<name> takes that one coordinator out of the installed rule and changes nothing else. Only a rule outside
//     the engine's own shape stops it. Its rule step comes before any user of the instance is deleted.
// The machine is test/sudoers-machine-fixture.ts, with recording stand-ins for every host tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';
import { machine, withoutCommand } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
type M = ReturnType<typeof machine>;
const RERUN = "rerun as root with --replace-sudoers to install the engine's rule: ";
const marked = (m: M) => (existsSync(join(m.T, 'add-project-new')) ? readFileSync(join(m.T, 'add-project-new'), 'utf8').split('\n').filter(Boolean) : []);

/** add-project's instance step runs the real instance.sh: its users, groups, directory and sudoers file stood in. */
function realInstanceScript(m: M) {
  const dir = join(m.T, 'real-instance', 'scripts', 'setup');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(repoRoot, 'scripts', 'setup', 'instance.sh'), join(dir, 'instance.sh'));
  writeFileSync(join(dir, 'lib.sh'), `source ${JSON.stringify(join(m.s, 'lib.sh'))}
ensure_user() { touch "$T/users/$1"; }
ensure_group() { :; }
ensure_member() { :; }
install() { mkdir -p "$T/srv/$name"; }
loginctl() { :; }
install_sudoers() { echo "$1" >> "$T/instance-sudoers"; }
`);
  writeFileSync(join(m.s, 'instance.sh'), `#!/usr/bin/env bash\nset -euo pipefail\necho "instance $*" >> ${JSON.stringify(join(m.T, 'calls'))}\nexec bash ${JSON.stringify(join(dir, 'instance.sh'))} "$@"\n`);
}

/** lib.sh's new_instance_mark_if_new for <name> on this machine; whether it marked it. */
function markIfNew(m: M, name: string): boolean {
  const r = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; new_instance_mark_if_new "$2"; if new_instance_marked "$2"; then echo yes; else echo no; fi', '_', join(m.s, 'lib.sh'), name], { encoding: 'utf8', env: m.env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() === 'yes';
}

test('#902 round 8 A1: a coordinator root took out of the rule and deleted, its agent user, checkout and hub entry left, is not re-marked new; its next add waits', { skip: !posix }, () => {
  const m = machine();
  realInstanceScript(m);
  // A new instance: nothing of alpha on the machine, so the real instance.sh marks it and its first add needs no flag.
  const first = m.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.deepEqual(marked(m), [], 'off the list once the rule names it');
  // Root revokes: wl-alpha out of the rule, and the user deleted by hand. Its agent user, its checkout root and the
  // hub's entry for it stay.
  m.setSudoers(m.expected('old'));
  rmSync(join(m.T, 'users', 'wl-alpha'));
  assert.ok(existsSync(join(m.T, 'users', 'wl-alpha-agent')) && existsSync(join(m.T, 'srv', 'alpha')));
  assert.match(readFileSync(join(m.T, 'hub.service'), 'utf8'), /--hub [^ ]*alpha=/);
  // The coordinator's add-project alpha: the instance step runs the real instance.sh again, which makes wl-alpha anew.
  const again = m.run();
  assert.equal(again.status, 3, again.stderr);
  assert.ok(existsSync(join(m.T, 'users', 'wl-alpha')), 'instance.sh made wl-alpha again');
  assert.deepEqual(marked(m), [], 'and did not mark it new');
  assert.equal(m.sudoers(), m.expected('old'), 'wl-alpha is not put back without root');
  assert.ok(again.events.some((e) => e.step === 'machine-helper' && e.state === 'waiting'), again.stdout);
  assert.ok(again.stderr.includes(RERUN), again.stderr);
});

test('#902 round 8 A1: new_instance_mark_if_new marks only an instance nothing of which is on the machine', { skip: !posix }, () => {
  const cases: [string, (m: M) => void, boolean][] = [
    ['nothing of it', () => {}, true],
    ['its coordinator user', (m) => writeFileSync(join(m.T, 'users', 'wl-beta'), ''), false],
    ['its agent user alone', (m) => writeFileSync(join(m.T, 'users', 'wl-beta-agent'), ''), false],
    ['its eval user alone', (m) => writeFileSync(join(m.T, 'users', 'wl-beta-eval'), ''), false],
    ['its checkout root alone', (m) => mkdirSync(join(m.T, 'srv', 'beta')), false],
    ['a hub entry alone', (m) => writeFileSync(join(m.T, 'hub.service'), readFileSync(join(m.T, 'hub.service'), 'utf8').replace('--hub old=', `--hub beta=${m.T}/homes/wl-beta/state,old=`)), false],
    ['a place in the machine helper\'s rule alone', (m) => m.setSudoers(m.expected('beta', 'old')), false],
  ];
  for (const [what, plant, want] of cases) {
    const m = machine();
    plant(m);
    assert.equal(markIfNew(m, 'beta'), want, what);
  }
  // And the real instance.sh marks through it, before it makes any user.
  const src = readFileSync(join(repoRoot, 'scripts', 'setup', 'instance.sh'), 'utf8');
  assert.match(src, /\nnew_instance_mark_if_new "\$name"\n/);
  assert.ok(src.indexOf('new_instance_mark_if_new "$name"') < src.indexOf('ensure_user "$coord"'));
  assert.doesNotMatch(src, /\bnew_instance_mark "/, 'no unconditional mark');
});

test('#902 round 8 A2: add-project\'s JSON output carries no pin; the pinned command is on stderr, after its diff', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  const { rule } = withoutCommand(m.expected('alpha', 'old'));
  m.setSudoers(rule);
  const r = m.run();
  assert.equal(r.status, 3, r.stderr);
  assert.doesNotMatch(r.stdout, /--replace-sudoers=|[0-9a-f]{64}/, r.stdout);
  const wait = r.events.find((e) => e.step === 'machine-helper' && e.state === 'waiting')!;
  assert.match(wait.detail, /at a root shell, rerun sudo bash \S+\/add-project\.sh alpha example\/alpha, or run sudo bash \S+\/machine-helper\.sh --check; either prints the whole diff and the command pinned to it$/);
  const pinned = `${RERUN}sudo bash ${m.s}/add-project.sh alpha example/alpha --replace-sudoers=${m.pin('alpha', 'old')}`;
  const at = r.stderr.indexOf(`\n${pinned}\n`);
  assert.ok(at > 0, r.stderr);
  assert.ok(r.stderr.lastIndexOf('+++ engine (machine-helper.sh)\n', at) > 0, 'the diff comes before it');
  // A pin that no longer matches waits the same way: the JSON names no pin.
  const stale = m.run([`--replace-sudoers=${'0'.repeat(64)}`]);
  assert.equal(stale.status, 3, stale.stderr);
  assert.doesNotMatch(stale.stdout, /--replace-sudoers=|[0-9a-f]{64}/, stale.stdout);
  assert.equal(m.sudoers(), rule);
});

/** The real machine-helper.sh writes into the temp machine: install_sudoers as the real one, without visudo. */
function helperWrites(m: M) {
  appendFileSync(join(m.real, 'lib.sh'), `install_sudoers() {
  local tmp="$T/.sudoers-machine.tmp"
  sudoers_bytes "$2" > "$tmp"
  if [ -n "$SUDOERS_PRECOMMIT" ] && ! "$SUDOERS_PRECOMMIT" "$tmp"; then rm -f "$tmp"; echo "sudoers $1: not installed (above)" >&2; exit 3; fi
  mv -f "$tmp" "$MACHINE_SUDOERS"
  echo "installed $1"
}
`);
}

test('#902 round 8 A3: machine-helper.sh --drop takes one coordinator out of an older engine\'s rule and changes nothing else', { skip: !posix }, () => {
  const m = machine();
  helperWrites(m);
  for (const u of ['wl-alpha', 'wl-alpha-agent']) writeFileSync(join(m.T, 'users', u), '');
  const { rule } = withoutCommand(m.expected('alpha', 'old'));
  m.setSudoers(rule);
  const r = m.helper('--drop=alpha');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const want = rule.replace('wl-alpha, wl-old ALL=', 'wl-old ALL=');
  assert.notEqual(want, rule);
  assert.equal(m.sudoers(), want, 'the same rule, wl-alpha out');
  assert.ok(r.stdout.includes(`-wl-alpha, wl-old ALL=(root) NOPASSWD: WORKLANE_MACHINE\n+wl-old ALL=(root) NOPASSWD: WORKLANE_MACHINE\n`), r.stdout);
  assert.doesNotMatch(r.stdout, /--replace-sudoers=/);
  // Out of the engine's shape, a name the rule doesn't hold, or the last user: refused, nothing written.
  for (const [what, installed, name] of [
    ['a line outside the shape', `${rule}wl-alpha ALL=(ALL) ALL\n`, 'alpha'],
    ['a name the rule does not hold', rule, 'beta'],
    ['the last coordinator', m.expected('old'), 'old'],
  ] as const) {
    m.setSudoers(installed);
    const no = m.helper(`--drop=${name}`);
    assert.equal(no.status, 3, `${what}: ${no.stdout}${no.stderr}`);
    assert.equal(m.sudoers(), installed, `${what}: nothing written`);
  }
  // --drop takes nothing else with it.
  assert.equal(m.helper('--drop=alpha', 'old').status, 2);
  assert.equal(m.hostCalls(), '');
});

/** Every file under the machine's temp dir, with its mode and bytes. */
const snapshot = (m: M) => readdirSync(m.T, { recursive: true }).map(String).sort().map((f) => {
  const st = statSync(join(m.T, f));
  return `${f} ${st.mode} ${st.isFile() ? readFileSync(join(m.T, f), 'utf8') : ''}`;
});

test('#902 round 8 A3: instance-remove.sh goes on over an older engine\'s rule; only a rule outside the engine\'s shape stops it, and its rule step comes before any user goes', { skip: !posix }, () => {
  const m = machine();
  copyFileSync(join(repoRoot, 'scripts', 'setup', 'instance-remove.sh'), join(m.s, 'instance-remove.sh'));
  chmodSync(join(m.s, 'instance-remove.sh'), 0o644);
  writeFileSync(join(m.s, 'instance-records.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(join(m.T, 'reached'))}, 'instance-records ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(1);\n`);
  const run = () => spawnSync('bash', [join(m.s, 'instance-remove.sh'), 'alpha', '--yes'], { encoding: 'utf8', input: '', env: m.env });
  for (const u of ['wl-alpha', 'wl-alpha-agent']) writeFileSync(join(m.T, 'users', u), '');
  // An older engine's rule: the engine's for old alone would widen it. No stop: it goes on to its registry.
  m.setSudoers(withoutCommand(m.expected('alpha', 'old')).rule);
  const on = run();
  assert.doesNotMatch(on.stdout + on.stderr, /--replace-sudoers|is not removed/, on.stdout + on.stderr);
  assert.ok(/needs node on root's PATH/.test(on.stderr) || /^instance-records plan alpha$/m.test(existsSync(join(m.T, 'reached')) ? readFileSync(join(m.T, 'reached'), 'utf8') : ''), on.stderr);
  // Outside the engine's shape: stopped, nothing changed.
  rmSync(join(m.T, 'reached'), { force: true });
  m.setSudoers(`${m.expected('alpha', 'old')}wl-alpha ALL=(ALL) ALL\n`);
  const before = snapshot(m);
  const off = run();
  assert.equal(off.status, 1, off.stderr);
  assert.match(off.stderr, /refused: alpha is not removed, nothing changed: the machine helper's rule \(\S+\) isn't in the engine's own shape/);
  assert.deepEqual(snapshot(m), before, 'nothing changed');
  assert.ok(!existsSync(join(m.T, 'reached')), 'it stopped before reading its registry');
  assert.equal(m.hostCalls(), '');
  // The order: the rule (drop, rewrite or remove) before the export, the registry's items and any userdel.
  const src = readFileSync(join(repoRoot, 'scripts', 'setup', 'instance-remove.sh'), 'utf8');
  const step = src.indexOf('bash "$here/machine-helper.sh" "--drop=$name"');
  assert.ok(step > 0);
  for (const later of ['say "export $name\'s history"', 'records remove "$name" "$kept"', 'userdel -r "$w"']) assert.ok(step < src.indexOf(later), later);
  assert.ok(src.indexOf('bash "$here/machine-helper.sh" --may-add= $(helper_others)') < src.indexOf('userdel -r "$w"'));
});
