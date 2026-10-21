// Issue #898, #902 round 4: root's list of instances being created (lib.sh ADD_PROJECT_NEW), which alone lets a
// rewrite of the machine helper's rule add a coordinator without --replace-sudoers.
//   - instance.sh marks a coordinator it makes, so a by-hand instance.sh then add-project needs no flag (CI's
//     add-project job makes gamma that way).
//   - machine-helper.sh drops every name it writes into the rule, so a coordinator root later takes out of the rule is
//     never put back without the flag.
//   - Only a list that is a regular, unlinked file of the expected owner, 0600, marks anything; its temp file is
//     never written through a link.
//   - A refusal's command always names instances, even when the rule's users line can't be read.
// The machine is test/sudoers-machine-fixture.ts, with recording stand-ins for every host tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';
import { machine } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
const RERUN = "rerun as root with --replace-sudoers to install the engine's rule: ";
const list = (T: string) => join(T, 'add-project-new');
/** Host tools reached, but for the install stand-in a real setup script stops at (it refuses, changing nothing). */
const otherHostCalls = (calls: string) => calls.split('\n').filter((l) => l && !l.startsWith('install ')).join('\n');

test('#902 round 4: instance.sh by hand marks the coordinator it makes, so the first add-project after it needs no flag', { skip: !posix }, () => {
  const m = machine();
  // The real instance.sh, its users and groups stood in (its first host step after them, install, is a refusing stand-in).
  const byHand = join(m.T, 'by-hand', 'scripts', 'setup');
  mkdirSync(byHand, { recursive: true });
  copyFileSync(join(repoRoot, 'scripts', 'setup', 'instance.sh'), join(byHand, 'instance.sh'));
  writeFileSync(join(byHand, 'lib.sh'), `source ${JSON.stringify(join(m.real, 'lib.sh'))}\nensure_user() { touch "$T/users/$1"; }\nensure_group() { :; }\nensure_member() { :; }\n`);
  const r = spawnSync('bash', [join(byHand, 'instance.sh'), 'alpha'], { encoding: 'utf8', env: m.env });
  assert.notEqual(r.status, 0, 'it stops at the install stand-in');
  assert.ok(existsSync(join(m.T, 'users', 'wl-alpha')), r.stderr);
  // Then add-project, as init's handoff runs it: the machine-helper step adds wl-alpha without the flag.
  const add = m.run();
  assert.equal(add.status, 0, add.stderr);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.ok(!readFileSync(list(m.T), 'utf8').split('\n').includes('alpha'), 'off the list once the rule names it');
  assert.equal(otherHostCalls(m.hostCalls()), '');
});

test('#902 round 4: machine-helper.sh drops the names it writes, so a coordinator root then takes out is not put back without the flag', { skip: !posix }, () => {
  const m = machine();
  // A first add that stops at the Claude login: alpha is being created, on the list.
  const stopped = spawnSync('bash', [join(m.s, 'add-project.sh'), 'alpha', 'example/alpha'], { encoding: 'utf8', input: '', env: m.env });
  assert.equal(stopped.status, 3, stopped.stderr);
  // Root runs machine-helper.sh with alpha. Here it stops at its first host step (a refusing stand-in) once past its
  // check, so the rule is put as it would have written it.
  m.helper('alpha', 'old');
  m.setSudoers(m.expected('alpha', 'old'));
  // Root takes wl-alpha out by hand; then the coordinator's route reruns add-project (the login installed meanwhile).
  const narrowed = m.expected('old');
  m.setSudoers(narrowed);
  const r = m.run();
  assert.equal(r.status, 3, r.stderr);
  assert.equal(m.sudoers(), narrowed, 'wl-alpha is not put back');
  assert.ok(r.stderr.includes(RERUN), r.stderr);
  assert.equal(otherHostCalls(m.hostCalls()), '');
});

test('#902 round 4: only a regular, unlinked 0600 list of the expected owner marks anything; a link or a 0666 list marks nothing', { skip: !posix }, () => {
  for (const plant of ['symlink', '0666'] as const) {
    const m = machine();
    assert.equal(m.run().status, 0);
    // Root took wl-alpha out of the rule; then someone plants a list naming alpha.
    const narrowed = m.expected('old');
    m.setSudoers(narrowed);
    rmSync(list(m.T), { force: true });
    if (plant === 'symlink') {
      writeFileSync(join(m.T, 'elsewhere'), 'alpha\n', { mode: 0o600 });
      symlinkSync(join(m.T, 'elsewhere'), list(m.T));
    } else {
      writeFileSync(list(m.T), 'alpha\n');
      chmodSync(list(m.T), 0o666);
    }
    const r = m.run();
    assert.equal(r.status, 3, `${plant}: ${r.stderr}`);
    assert.equal(m.sudoers(), narrowed, `${plant}: not put back`);
    assert.equal(m.hostCalls(), '');
  }
  // The temp file is never written through a link: one planted there refuses the mark, and its target is untouched.
  const m = machine();
  writeFileSync(join(m.T, 'victim'), 'keep\n');
  symlinkSync(join(m.T, 'victim'), `${list(m.T)}.tmp`);
  const r = spawnSync('bash', ['-c', 'source "$1"; new_instance_mark alpha; new_instance_marked alpha && echo marked || echo unmarked', '_', join(m.s, 'lib.sh')], { encoding: 'utf8', env: m.env });
  assert.equal(r.stdout.trim(), 'unmarked', r.stderr);
  assert.equal(readFileSync(join(m.T, 'victim'), 'utf8'), 'keep\n');
  assert.match(r.stderr, /its first add will wait for --replace-sudoers/);
});

test('#902 round 4: a rule whose users line can\'t be read gets a command that names the instances, from the hub and the checkouts', { skip: !posix }, () => {
  const m = machine();
  for (const f of ['instance-rename.sh']) {
    copyFileSync(join(repoRoot, 'scripts', 'setup', f), join(m.s, f));
  }
  writeFileSync(join(m.s, 'instance-records.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(join(m.T, 'reached'))}, 'reached\\n');\nprocess.exit(1);\n`);
  const unreadable = m.expected('old').replace('wl-old ALL=', 'wl-old, !wl-old ALL=');
  m.setSudoers(unreadable);
  const r = spawnSync('bash', [join(m.s, 'instance-rename.sh'), 'old', 'beta', '--yes'], { encoding: 'utf8', input: '', env: m.env });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.endsWith(`\n${RERUN}sudo bash ${m.s}/machine-helper.sh --replace-sudoers=${m.pin('old')} old\n`), r.stdout);
  assert.equal(m.sudoers(), unreadable);
  const c = m.check();
  assert.equal(c.status, 4, c.stdout);
  assert.ok(c.stdout.endsWith(`wider: ${RERUN}sudo bash ${m.real}/machine-helper.sh --replace-sudoers=${m.pin('old')} old\n`), c.stdout);
  assert.ok(!existsSync(join(m.T, 'reached')));
  assert.equal(m.hostCalls(), '');
});
