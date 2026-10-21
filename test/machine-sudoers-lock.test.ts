// Issue #898, #902 round 7 (the second adversarial review of 72119b1a, and CI's wizard job):
//   - CI: a machine's first rule is written. The run installs the helper before it writes the rule, so the first
//     install is read at the first check and carried to the write-time one, never read again there.
//   - F1: the lock every writer of the rule holds sits in a directory only root can enter, and a run without flock, or
//     with that directory anything else, refuses instead of writing unlocked.
//   - F2: every machine-helper.sh command the engine prints without a pin carries --may-add=, so a later paste is
//     checked against the rule as it is then and puts back no user root took out.
//   - F3: for a wider rule the updater's incident fix is --check (the whole diff and its pinned command together),
//     never a pinned command beside a diff cut to fit.
//   - F4: the bytes install_sudoers moves into place are the bytes the checks judged.
// The machine is test/sudoers-machine-fixture.ts, with recording stand-ins for every host tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';
import { machine, withCommand } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
type M = ReturnType<typeof machine>;
/** Host tools reached, but for the install stand-in a real setup script stops at (it refuses, changing nothing). */
const otherHostCalls = (calls: string) => calls.split('\n').filter((l) => l && !l.startsWith('install ')).join('\n');
const lib = (m: M, script: string, env: Record<string, string> = m.env) => spawnSync('/bin/bash', ['-c', `source "$1"; ${script}`, '_', join(m.s, 'lib.sh')], { encoding: 'utf8', env });

test('#902 round 7 (CI): a first install, read at the first check, still holds at write time after the run installs the helper', { skip: !posix }, () => {
  const m = machine('1.9.15', false);
  rmSync(join(m.T, 'helper'), { force: true });
  // The first check: no rule, no helper, no rules record. Then the run installs the helper, and comes to its write.
  const r = lib(m, 'rule="$(machine_sudoers wl-old)"; seen="$(sudoers_state "$MACHINE_SUDOERS")"; first=0; if [ "$seen" = absent ] && machine_helper_never_set_up; then first=1; fi; touch "$MACHINE_HELPER"; rc=0; machine_sudoers_commit_ok "$seen" "" "$rule" "$first" || rc=$?; echo "first=$first rc=$rc"');
  assert.match(r.stdout, /first=1 rc=0$/m, r.stdout + r.stderr);
  // A machine that had the helper and lost its rule is no first install, there or later.
  const later = lib(m, 'rule="$(machine_sudoers wl-old)"; seen="$(sudoers_state "$MACHINE_SUDOERS")"; first=0; if [ "$seen" = absent ] && machine_helper_never_set_up; then first=1; fi; rc=0; machine_sudoers_commit_ok "$seen" "" "$rule" "$first" || rc=$?; echo "first=$first rc=$rc"');
  assert.match(later.stdout, /first=0 rc=3$/m, later.stdout + later.stderr);
  assert.equal(m.hostCalls(), '');
});

test('#902 round 7 F1: the lock sits in a directory only root can enter; without flock, or with that directory loose, a run refuses', { skip: !posix }, () => {
  const m = machine();
  // As lib.sh has it on a machine: a directory of its own under /run, never the world-writable /run/lock.
  const src = readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8');
  assert.match(src, /^MACHINE_SUDOERS_LOCK=\/run\/worklane-machine\/sudoers\.lock /m);
  assert.match(src, /^MACHINE_SUDOERS_LOCK_UID=0$/m);
  // It makes that directory its owner's, 0700, and takes the lock.
  const ok = lib(m, 'machine_sudoers_lock; echo locked');
  assert.match(ok.stdout, /locked/, ok.stderr);
  const d = statSync(join(m.T, 'locks'));
  assert.equal(d.mode & 0o777, 0o700);
  assert.equal(d.uid, process.getuid!());
  // A directory anyone else could enter: refused, never locked or written through.
  chmodSync(join(m.T, 'locks'), 0o755);
  const loose = lib(m, 'machine_sudoers_lock; echo locked');
  assert.equal(loose.status, 1);
  assert.doesNotMatch(loose.stdout, /locked/);
  assert.match(loose.stderr, /is not root's 0700 directory/);
  // No flock on PATH: refused, never skipped.
  const empty = join(m.T, 'no-flock');
  mkdirSync(empty);
  const none = lib(m, 'machine_sudoers_lock; echo locked', { ...m.env, PATH: empty });
  assert.equal(none.status, 1);
  assert.doesNotMatch(none.stdout, /locked/);
  assert.match(none.stderr, /needs flock/);
  // Both writers take it, by that one function.
  assert.match(readFileSync(join(repoRoot, 'scripts', 'setup', 'machine-helper.sh'), 'utf8'), /\nmachine_sudoers_lock\n/);
  assert.match(readFileSync(join(repoRoot, 'scripts', 'setup', 'instance-remove.sh'), 'utf8'), /\n\s*machine_sudoers_lock\n\s*remove_sudoers worklane-machine/);
  assert.equal(m.hostCalls(), '');
});

test('#902 round 7 F2: the step-alone retry and --check\'s stale command carry --may-add=, so a later paste puts back no user root took out', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  // A stale rule (a retired command), so the step reruns; machine-helper.sh fails on it (any exit but 3).
  m.setSudoers(withCommand(m.expected('alpha', 'old'), `${m.T}/helper claude-account switch`));
  writeFileSync(join(m.s, 'machine-helper.sh'), '#!/usr/bin/env bash\necho "it went wrong" >&2\nexit 1\n');
  const r = m.run();
  assert.equal(r.status, 1, r.stderr);
  const failed = r.events.find((e) => e.step === 'machine-helper' && e.state === 'failed')!;
  const alone = `sudo bash ${m.s}/machine-helper.sh --may-add= alpha old`;
  assert.ok(failed.retry!.endsWith(`or this step alone: ${alone}`), failed.retry);
  // Root takes wl-old out by hand; then pastes that retry (the real machine-helper.sh): it waits, nothing put back.
  const narrowed = m.expected('alpha');
  m.setSudoers(narrowed);
  const pasted = m.helper('--may-add=', 'alpha', 'old');
  assert.equal(pasted.status, 3, pasted.stdout + pasted.stderr);
  assert.equal(m.sudoers(), narrowed);
  // --check's stale command is the same form.
  m.setSudoers(withCommand(m.expected('alpha', 'old'), `${m.T}/helper claude-account switch`));
  const c = m.check();
  assert.equal(c.status, 3);
  assert.ok(c.stdout.trimEnd().endsWith(`rewrite it, as root: sudo bash ${m.real}/machine-helper.sh --may-add= alpha old`), c.stdout);
  assert.equal(otherHostCalls(m.hostCalls()), '');
});

type Check = { state: string; detail: string; fix?: string } | null;

test('#902 round 7 F3: on v0.5.2\'s rule the incident\'s fix is --check, never a pinned command beside a diff cut to fit', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'users', 'wl-alpha'), '');
  m.setSudoers(readFileSync(join(repoRoot, 'test', 'fixtures', 'machine-sudoers-v0.5.2.txt'), 'utf8').split('/usr/local/libexec/worklane-machine').join(`${m.T}/helper`));
  const engine = join(m.T, 'real');
  const exec = ((file: string, args: string[], o: Record<string, unknown>) =>
    execFileSync(file, args, { ...o, env: { ...(o.env as Record<string, string>), PATH: `${join(m.T, 'host-bin')}:${(o.env as Record<string, string>).PATH}` } })) as unknown as typeof execFileSync;
  const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as { machineSudoersCheck(dir: string, exec: typeof execFileSync, owner: number, top: string): Check };
  const r = u.machineSudoersCheck(engine, exec, process.getuid!(), m.T)!;
  assert.equal(r.state, 'wider');
  assert.equal(r.fix, `sudo bash ${engine}/scripts/setup/machine-helper.sh --check`);
  assert.match(r.detail, /\(5 lines added, 8 dropped\)/);
  assert.doesNotMatch(r.detail + r.fix, /--replace-sudoers=/);
  // That fix prints the whole diff (every set-policy line) and the pinned command, together.
  const c = m.check();
  assert.equal(c.status, 4);
  assert.equal(c.stdout.split('\n').filter((l) => /^\+.*set-policy/.test(l)).length, 4);
  assert.match(c.stdout.trimEnd().split('\n').pop()!, /--replace-sudoers=[0-9a-f]{64} alpha old$/);
  assert.equal(m.hostCalls(), '');
});

test('#902 round 7 F4: right before its move, install_sudoers\' last check refuses a temp file that isn\'t byte for byte the rule checked', { skip: !posix }, () => {
  const m = machine();
  m.setSudoers(m.expected('alpha', 'old'));
  writeFileSync(join(m.T, 'users', 'wl-alpha'), '');
  writeFileSync(join(m.T, 'tmp-same'), m.expected('alpha', 'old'));
  // What a second machine_sudoers can yield, say once sudo -V answers differently mid-run: more than was checked.
  writeFileSync(join(m.T, 'tmp-more'), m.expected('alpha', 'old').replace('wl-alpha, wl-old ALL=', 'wl-alpha, wl-beta, wl-old ALL='));
  const run = (tmp: string) => lib(m, `rule="$(machine_sudoers wl-alpha wl-old)"; seen="$(sudoers_state "$MACHINE_SUDOERS")"; rc=0; machine_sudoers_precommit "$T/${tmp}" "$seen" "" "$rule" 0 wl-alpha wl-old || rc=$?; echo "rc=$rc"`);
  assert.match(run('tmp-same').stdout, /rc=0$/m);
  const more = run('tmp-more');
  assert.match(more.stdout, /rc=3$/m, more.stdout + more.stderr);
  assert.match(more.stdout, /the rule about to be written is not the rule checked/);
  assert.ok(existsSync(join(m.T, 'sudoers-machine')));
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.equal(m.hostCalls(), '');
});
