// Issue #902 round 10: an instance made before machine and console were reserved keeps its OFF and cleanup paths in the
// root helpers the updater installs, never costs another instance its own user namespace, and its root policy is never
// taken over looser.
//   - worklane-exp's stop, wipe, prune, check and version, and worklane-testrun's wipe, check and version, take such a
//     name; every verb that makes something keeps the strict rule.
//   - is_test_user (the test-run helper's and test-user.sh's, word for word) counts wl-test-console as a test user, as
//     main did, so the wrapper's ACL that test-user.sh install wrote with it is no problem for another instance's run
//     (#545: a problem there sends every run to the host's user namespace).
//   - `policy own <n> --retake` and `--accept-loose` are refused under such a name: root's policy stays the one it wrote.
// The helpers are never run whole here: each is cut right after its name check (nothing past it runs), and the
// functions are taken out of the files and run in bash against a temp BASE, as test/testrun-network.test.ts does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import * as names from '../src/instance-name.js';
import { ownCommand, setPolicyRootUid } from '../src/policy-gate.js';
import { ownPolicy, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';
import { repoRoot } from './helpers.js';
import { keptProblems, REFUSED_NAMES } from './legacy-kept-names.js';

const posix = process.platform !== 'win32';
const linux = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc/self/fd)';
const machineDir = join(repoRoot, 'scripts', 'machine');
const exp = join(machineDir, `${BRAND.cli}-exp.sh`);
const testrun = join(machineDir, `${BRAND.cli}-testrun.sh`);
const testUser = join(repoRoot, 'scripts', 'setup', 'test-user.sh');
const lib = join(repoRoot, 'scripts', 'setup', 'lib.sh');
const later = (names as { LATER_RESERVED?: readonly string[] }).LATER_RESERVED ?? ['machine', 'console'];

/** The helper cut right after its name check: it prints `passed <name> <cmd>` there, and nothing after it runs. */
function upToNameCheck(file: string, next: string) {
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf(`\n${next}\n`);
  assert.ok(at > 0, `${file}: ${next}`);
  const dir = mkdtempSync(join(tmpdir(), 'helper-cut-'));
  const cut = join(dir, 'helper.sh');
  writeFileSync(cut, `${src.slice(0, at)}\necho "passed $name $cmd"\nexit 0\n`);
  return (...args: string[]) => spawnSync('/bin/bash', [cut, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
}

const fnOf = (s: string, name: string) => {
  const at = s.indexOf(`\n${name}() {`);
  assert.ok(at >= 0, `${name} is defined`);
  return s.slice(at + 1, s.indexOf('\n}\n', at) + 3);
};

test('#902 round 10: the experiment and test-run helpers stop, wipe, prune and check an instance named console or machine; nothing is made under one', { skip: !posix && 'bash' }, () => {
  const e = upToNameCheck(exp, 'juser="wl-exp-$name"');
  const t = upToNameCheck(testrun, 'user="wl-test-$name"');
  for (const n of later) {
    for (const cmd of ['stop', 'wipe', 'prune', 'check', 'version']) {
      const r = e(n, cmd, 'job1');
      assert.equal(r.status, 0, `exp ${n} ${cmd}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), `passed ${n} ${cmd}`);
    }
    for (const cmd of ['wipe', 'check', 'version']) {
      const r = t(n, cmd, 'run1');
      assert.equal(r.status, 0, `testrun ${n} ${cmd}: ${r.stderr}`);
    }
    for (const cmd of ['create', 'job', 'eval-put', 'eval-seal']) assert.match(e(n, cmd).stderr, /machine's own sudoers file/, `exp ${n} ${cmd}`);
    for (const cmd of ['create', 'exec', 'fetch', 'db-start', 'store-tips', 'file', 'cache', 'shared']) assert.match(t(n, cmd).stderr, /machine's own sudoers file/, `testrun ${n} ${cmd}`);
  }
  // Every other refused name stays refused for every verb.
  for (const n of ['update', 'test-x', 'dash']) {
    assert.equal(e(n, 'stop', 'job1').status, 2, `exp ${n}`);
    assert.equal(t(n, 'wipe', 'run1').status, 2, `testrun ${n}`);
  }
});

test('#902 round 10: wl-test-console is a test user, so another instance\'s run keeps its own user namespace (#545, as on main)', { skip: !posix && 'bash' }, () => {
  const helper = readFileSync(testrun, 'utf8');
  const tu = readFileSync(testUser, 'utf8');
  assert.equal(fnOf(tu, 'is_test_user'), fnOf(helper, 'is_test_user'), 'the same rule, word for word');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'acl-base-')));
  for (const n of ['alpha', 'console', 'machine', 'agent']) mkdirSync(join(base, n));
  // The ACL test-user.sh install writes on a machine with instances alpha, console and machine.
  const acl = 'user::rwx\nuser:wl-test-alpha:r-x\nuser:wl-test-console:r-x\nuser:wl-test-machine:r-x\ngroup::---\nmask::r-x\nother::---\n';
  const sh = (fns: string, call: string) => spawnSync('bash', ['-c', `set -euo pipefail\nuser=wl-test-alpha\nBASE=${base}\n${fns}${call}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ACL: acl } });
  const helperFns = ['instance_name_problem', 'is_test_user', 'wrapper_acl_problem'].map((n) => fnOf(helper, n)).join('');
  const tuFns = fnOf(readFileSync(lib, 'utf8'), 'instance_name_problem') + ['is_test_user', 'wrapper_acl_problem'].map((n) => fnOf(tu, n)).join('');
  for (const [what, fns] of [['helper', helperFns], ['test-user.sh', tuFns]] as const) {
    for (const u of ['wl-test-console', 'wl-test-machine', 'wl-test-alpha']) assert.equal(sh(fns, `if is_test_user ${u}; then echo yes; else echo no; fi`).stdout.trim(), 'yes', `${what}: ${u}`);
    assert.equal(sh(fns, 'if is_test_user wl-test-agent; then echo yes; else echo no; fi').stdout.trim(), 'no', `${what}: instance test's agent user stays out`);
    const r = sh(fns, 'wrapper_acl_problem "$ACL"');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', `${what}: alpha's run, with the legacy test users on the wrapper's ACL`);
  }
});

test('#902 round 11: the helpers\' kept names are the engine\'s LATER_RESERVED, by behaviour: every refused name through every kept verb and is_test_user', { skip: !posix && 'bash' }, () => {
  assert.deepEqual([...later].sort(), ['console', 'machine']);
  const libText = readFileSync(lib, 'utf8');
  assert.match(libText, new RegExp(`^LATER_RESERVED_NAMES="${later.join(' ')}"$`, 'm'));
  // Each name the list uses is one the instance-name rules refuse (src/instance-name.ts), so none passes by being valid.
  for (const n of [...REFUSED_NAMES, ...later]) assert.notEqual(names.instanceNameProblem(n), null, n);
  const src = { exp: readFileSync(exp, 'utf8'), testrun: readFileSync(testrun, 'utf8'), testUser: readFileSync(testUser, 'utf8'), lib: libText };
  assert.deepEqual(keptProblems(src, later), []);
  // A widened kept set (the round-10 review's mutant: hub kept by the experiment helper, exp-x by the test-run
  // helper's check) is caught, as is one in is_test_user.
  const mutant = {
    ...src,
    exp: src.exp.replace('if [ "$name" = machine ] || [ "$name" = console ]; then why=""', 'if [ "$name" = machine ] || [ "$name" = console ] || [ "$name" = hub ]; then why=""'),
    testrun: src.testrun.replace('case "$cmd" in wipe | check | version) if [ "$name" = machine ] || [ "$name" = console ]; then', 'case "$cmd" in wipe | check | version) if [ "$name" = machine ] || [ "$name" = console ] || [ "$name" = exp-x ]; then'),
  };
  assert.notEqual(mutant.exp, src.exp);
  assert.notEqual(mutant.testrun, src.testrun);
  const caught = keptProblems(mutant, later);
  assert.ok(caught.some((p) => p.startsWith('exp hub stop: taken')) && caught.some((p) => p.startsWith('testrun exp-x check: taken')), caught.join('\n'));
  const tuMutant = { ...src, testUser: src.testUser.replace('[ "$n" = console ] ||', '[ "$n" = console ] || [ "$n" = agent ] ||') };
  assert.notEqual(tuMutant.testUser, src.testUser);
  assert.ok(keptProblems(tuMutant, later).some((p) => p.startsWith('test-user.sh is_test_user wl-test-agent: yes')));
});

test('#902 round 10: under a name reserved since, policy own --retake and --accept-loose are refused: root\'s policy is never taken over looser', { skip: linux }, () => {
  const me = process.getuid!();
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-own-')));
  const dir = join(T, 'home', 'wl-console', '.local', 'state', BRAND.cli, 'instances', 'console');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'policy.yaml');
  writeFileSync(file, 'version: 1\nbudget: { daily_usd: 50 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: false\n', { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === 'wl-console' ? join(T, 'home', 'wl-console') : null), uid: () => me, rootUid: me, rootGid: process.getgid!(), limitsPath: join(T, 'limits.json'), markerDir: join(T, 'markers') };
  setPolicyRootUid(me);
  try {
    ownPolicy('console', deps);
    assert.equal(setPolicy('console', 'budget.daily_usd', '20', null, deps).to, 20);
    assert.throws(() => setPolicy('console', 'budget.daily_usd', '80', null, deps), /only tightens/);
    // Something running as its coordinator puts a looser file in its place: the budget root refused (which --retake
    // alone took over at e3d70d67), or land_mode direct and auto_merge on (--retake --accept-loose).
    const budget = 'version: 1\nbudget: { daily_usd: 80 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: false\n';
    const direct = 'version: 1\nbudget: { daily_usd: 80 }\nagents: { max_workers: 4 }\nland_mode: direct\nauto_merge: true\n';
    // Round 12: --accept-loose alone reaches only a first takeover; a recorded file that changed is refused as for any
    // name, without --retake, which this name never gets.
    for (const [text, flags, why] of [
      [budget, { retake: true }, /console is a name the instance-name rules refuse now/],
      [direct, { retake: true, acceptLoose: true }, /console is a name the instance-name rules refuse now/],
      [direct, { acceptLoose: true }, /isn't what root last wrote/],
    ] as const) {
      writeFileSync(join(dir, '.x'), text, { mode: 0o600 });
      renameSync(join(dir, '.x'), file);
      assert.throws(() => ownPolicy('console', deps, flags), why, JSON.stringify(flags));
    }
    // Root's record still covers only the file it wrote: nothing reads or changes the planted one as root's. The way out
    // it names is the instance's removal, never a --retake that is refused (round 11).
    assert.throws(() => setPolicy('console', 'budget.daily_usd', '10', null, deps), /isn't what root last wrote.*instance-remove\.sh console \(/);
    assert.doesNotMatch(ownCommand('console', '--retake'), /policy own/);
    assert.equal(ownCommand('alpha', '--retake'), `sudo ${BRAND.cli} policy own alpha --retake`);
    assert.equal(ownCommand('console'), `sudo ${BRAND.cli} policy own console`);
  } finally {
    setPolicyRootUid(0);
  }
});
