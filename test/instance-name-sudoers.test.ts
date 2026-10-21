// Issue #902 round 8: no instance name gives an instance a sudoers file that is the machine's own. instance.sh writes
// its coordinator's rule to /etc/sudoers.d/<cli>-<name> with no lock, check or pin, so an instance named machine would
// overwrite the machine helper's rule (and one named console the owner console's). Every copy of the name rules refuses
// both (lib.sh, the testrun and experiments helpers' copies, the machine helper, the engine), the coordinator's
// add-project route among them, and every fixed sudoers file the setup scripts write is one of src/instance-name.ts
// ENGINE_NAMES, whose test (test/instance-name.test.ts) then refuses any name that would collide with it. An instance
// made under such a name before is still removable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ENGINE_NAMES, instanceNameProblem } from '../src/instance-name.js';
import { addProjectNameOk } from '../src/machine.js';
import { repoRoot } from './helpers.js';
import { machine } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
const machineDir = join(repoRoot, 'scripts', 'machine');
const helper = createRequire(import.meta.url)(join(machineDir, `${BRAND.cli}-machine.cjs`)) as { instanceNameProblem: (s: unknown) => string | null; parseAddProject: (a: string[]) => unknown };

/** instance_name_problem in this shell file, for each name. */
function shell(file: string, names: string[]): string[] {
  const fn = /^instance_name_problem\(\) \{\n[\s\S]*?\n\}\n/m.exec(readFileSync(file, 'utf8'))?.[0];
  assert.ok(fn, file);
  const r = spawnSync('bash', ['-c', `eval "$1"; shift; for n in "$@"; do printf '%s\\x1e' "$(instance_name_problem "$n")"; done`, '_', fn, ...names], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\x1e').slice(0, -1);
}

/** The fixed sudoers file names the setup scripts and machine helpers write or remove: <cli>-<word> with no variable. */
function fixedSudoersNames(): string[] {
  const out = new Set<string>();
  const re = new RegExp(`(?:sudoers\\.d/|install_sudoers "?|remove_sudoers "?)(${BRAND.cli}-[a-z0-9-]+)(?![a-z0-9$<{-])`, 'g');
  for (const d of [setupDir, machineDir]) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (!statSync(p).isFile()) continue;
      for (const m of readFileSync(p, 'utf8').matchAll(re)) out.add(m[1]!);
    }
  }
  return [...out].sort();
}

test('#902 round 8: machine and console, whose sudoers files are the machine\'s own, are no instance\'s name anywhere', { skip: !posix }, () => {
  const names = ['machine', 'console'];
  const files = [join(setupDir, 'lib.sh'), join(machineDir, `${BRAND.cli}-testrun.sh`), join(machineDir, `${BRAND.cli}-exp.sh`)];
  for (const f of files) {
    shell(f, names).forEach((why, i) => assert.equal(why, `/etc/sudoers.d/${BRAND.cli}-${names[i]} is the machine's own sudoers file`, `${f}: ${names[i]}`));
  }
  for (const n of names) {
    assert.equal(instanceNameProblem(n), `/etc/sudoers.d/${BRAND.cli}-${n} is the machine's own sudoers file`);
    assert.equal(helper.instanceNameProblem(n), instanceNameProblem(n));
    assert.equal(addProjectNameOk(n), false);
    assert.equal(helper.parseAddProject(['add-project', n, 'example/shop']), null, `the coordinator's add-project ${n}`);
  }
  assert.notEqual(helper.parseAddProject(['add-project', 'shop', 'example/shop']), null);
});

test('#902 round 8: every fixed sudoers file the scripts write is in ENGINE_NAMES, and no instance name maps onto one', () => {
  const fixed = fixedSudoersNames();
  assert.ok(fixed.includes(`${BRAND.cli}-machine`) && fixed.includes(`${BRAND.cli}-console`), fixed.join(' '));
  const listed = new Set(ENGINE_NAMES.map((e) => e.pattern));
  assert.ok(listed.has(`/etc/sudoers.d/${BRAND.cli}-<n>`), 'an instance\'s own sudoers file is listed');
  for (const f of fixed) {
    assert.ok(listed.has(`/etc/sudoers.d/${f}`), `${f} is in ENGINE_NAMES`);
    const word = f.slice(BRAND.cli.length + 1);
    assert.notEqual(instanceNameProblem(word), null, `an instance named ${word} would write /etc/sudoers.d/${f}`);
  }
});

test('#902 round 8: add-project.sh and instance.sh refuse machine before anything; instance-remove.sh still takes an existing instance machine', { skip: !posix }, () => {
  const m = machine();
  copyFileSync(join(setupDir, 'instance.sh'), join(m.s, 'instance-real.sh'));
  for (const [script, args] of [['add-project.sh', ['machine', 'example/shop']], ['instance-real.sh', ['machine']]] as const) {
    const r = spawnSync('bash', [join(m.s, script), ...args], { encoding: 'utf8', input: '', env: m.env });
    assert.equal(r.status, 2, `${script}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /machine: \/etc\/sudoers\.d\/\S+-machine is the machine's own sudoers file/);
  }
  assert.equal(existsSync(join(m.T, 'users', 'wl-machine')), false);
  // machine-helper.sh takes no --may-add=machine either.
  const h = m.helper('--may-add=machine', 'old');
  assert.equal(h.status, 2, h.stdout + h.stderr);
  // An instance machine made before the name was reserved: instance-remove.sh takes it (it notes the name), and its
  // machine helper step is left to the registry's sudoers item (the shared file), so it never refuses over that file.
  copyFileSync(join(setupDir, 'instance-remove.sh'), join(m.s, 'instance-remove.sh'));
  chmodSync(join(m.s, 'instance-remove.sh'), 0o644);
  writeFileSync(join(m.s, 'instance-records.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(join(m.T, 'reached'))}, 'instance-records ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(1);\n`);
  for (const u of ['wl-machine', 'wl-machine-agent']) writeFileSync(join(m.T, 'users', u), '');
  // The file holds instance machine's own coordinator rule (instance.sh wrote it last): outside the helper's shape.
  m.setSudoers('Defaults:wl-machine !use_pty\nwl-machine ALL=(wl-machine-agent) NOPASSWD: ALL\n');
  const r = spawnSync('bash', [join(m.s, 'instance-remove.sh'), 'machine', '--yes'], { encoding: 'utf8', input: '', env: m.env });
  assert.match(r.stderr, /note: machine is a name the instance-name rules refuse now/);
  assert.doesNotMatch(r.stdout + r.stderr, /is not removed|--replace-sudoers/, r.stdout + r.stderr);
  assert.ok(/needs node on root's PATH/.test(r.stderr) || /^instance-records plan machine$/m.test(existsSync(join(m.T, 'reached')) ? readFileSync(join(m.T, 'reached'), 'utf8') : ''), r.stderr);
  const src = readFileSync(join(setupDir, 'instance-remove.sh'), 'utf8');
  assert.match(src, /if \[ "\$w" = worklane-machine \]; then\n(\s*#.*\n)*\s*machine_sudoers_lock\n\s*remove_sudoers "\$w"/, 'the shared file goes under the rule\'s lock');
});
