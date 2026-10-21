// Issue #898, #902 round 5 (the second adversarial review):
//   - A1: a machine helper rule taken away (root revoking it: deleted, or moved aside to a name sudo ignores) is never
//     put back on its own. Only a machine that never had the helper set up (no helper, no rules record) takes a first
//     rule without --replace-sudoers.
//   - A2: --replace-sudoers shows the diff it installs, before writing, in add-project.sh and machine-helper.sh.
//   - The instances a printed command names pass the instance-name rules.
// The machine is test/sudoers-machine-fixture.ts, with recording stand-ins for every host tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { machine } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
const RERUN = "rerun as root with --replace-sudoers to install the engine's rule: ";
/** Host tools reached, but for the install stand-in a real setup script stops at (it refuses, changing nothing). */
const otherHostCalls = (calls: string) => calls.split('\n').filter((l) => l && !l.startsWith('install ')).join('\n');

test('#902 round 5 A1: a rule root took away (deleted, or moved aside) is not put back by an add-project rerun without the flag', { skip: !posix }, () => {
  for (const how of ['deleted', 'moved aside'] as const) {
    const m = machine();
    assert.equal(m.run().status, 0);
    const rule = join(m.T, 'sudoers-machine');
    if (how === 'deleted') rmSync(rule);
    else renameSync(rule, join(m.T, '.sudoers-machine.off'));
    // The coordinator's route: exactly a name and a repo, no stdin.
    const r = spawnSync('bash', [join(m.s, 'add-project.sh'), 'alpha', 'example/alpha'], { encoding: 'utf8', input: '', env: m.env });
    assert.equal(r.status, 3, `${how}: ${r.stderr}`);
    assert.ok(!existsSync(rule), `${how}: the rule stays away`);
    assert.ok(r.stderr.includes(`--- installed ${rule}\n+++ engine (machine-helper.sh)\n`), r.stderr);
    assert.match(r.stderr, /^\+wl-alpha, wl-old ALL=\(root\) NOPASSWD: WORKLANE_MACHINE$/m, 'the whole rule it would add, shown');
    assert.ok(r.stderr.includes(`\n${RERUN}sudo bash ${m.s}/add-project.sh alpha example/alpha --replace-sudoers=${m.pin('alpha', 'old')}\n`), r.stderr);
    assert.doesNotMatch(r.stderr, /grants nothing the installed one doesn't/);
    // machine-helper.sh by hand holds it too.
    const h = m.helper('alpha', 'old');
    assert.equal(h.status, 3, h.stdout + h.stderr);
    assert.ok(!existsSync(rule));
    assert.equal(m.hostCalls(), '');
  }
  // A machine that never had the helper set up (no rule, no helper, no rules record): its first rule needs no flag.
  const fresh = machine('1.9.15', false);
  rmSync(join(fresh.T, 'helper'));
  const first = fresh.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fresh.sudoers(), fresh.expected('alpha', 'old'));
  assert.match(first.stderr, /the machine helper's first rule, for alpha old: this machine never had the helper set up/);
});

test('#902 round 5 A2: --replace-sudoers shows the diff it installs before writing, in add-project.sh and machine-helper.sh', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  m.setSudoers(m.expected('old'));
  const r = m.run([`--replace-sudoers=${m.pin('alpha', 'old')}`]);
  assert.equal(r.status, 0, r.stderr);
  const shown = r.stderr.indexOf(`--- installed ${join(m.T, 'sudoers-machine')}\n+++ engine (machine-helper.sh)\n`);
  const said = r.stderr.indexOf("--replace-sudoers: the machine helper's rule becomes the engine's rule above");
  assert.ok(shown >= 0 && said > shown, r.stderr);
  assert.match(r.stderr, /^\+wl-alpha, wl-old ALL=\(root\) NOPASSWD: WORKLANE_MACHINE$/m);
  // machine-helper.sh --replace-sudoers by hand (here it then stops at its first host step, a refusing stand-in).
  m.setSudoers(m.expected('old'));
  const h = m.helper(`--replace-sudoers=${m.pin('alpha', 'old')}`, 'alpha', 'old');
  assert.ok(h.stdout.startsWith(`--- installed ${join(m.T, 'sudoers-machine')}\n+++ engine (machine-helper.sh)\n`), h.stdout + h.stderr);
  assert.match(h.stdout, /^\+wl-alpha, wl-old ALL=\(root\) NOPASSWD: WORKLANE_MACHINE$/m);
  assert.match(h.stdout, /--replace-sudoers: installing the engine's rule above/);
  assert.equal(otherHostCalls(m.hostCalls()), '');
});

test('#902 round 5: a printed command names only instances machine-helper.sh would take', { skip: !posix }, () => {
  const m = machine();
  // A checkout named for a name the instance-name rules refuse (dash), with a user of that name: never named.
  mkdirSync(join(m.T, 'srv', 'dash'), { recursive: true });
  writeFileSync(join(m.T, 'users', 'wl-dash'), '');
  const r = spawnSync('bash', ['-c', 'source "$1"; machine_instances_here', '_', join(m.s, 'lib.sh')], { encoding: 'utf8', env: m.env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['old']);
});
