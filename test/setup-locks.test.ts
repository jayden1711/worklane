// Issue #945: the setup scripts' machine-wide locks (add-project's, shared with instance-remove and instance-rename,
// and tailscale's) sat in /run/lock, which is 1777: any user could pre-create the file, so root's open failed under
// protected_regular, or open it read-only and hold a flock on it, so root's run was blocked. Now every one of them,
// and the machine helper's rule's (#902), is taken by lib.sh's machine_lock, in a directory only root can enter, and
// a run without flock refuses instead of going on unlocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
const libSh = join(setupDir, 'lib.sh');
const uid = () => process.getuid!();

/** machine_lock <fd> <lock> <wait> <held>, as root would run it but with this user standing in for root. */
const lock = (path: string, o: { owner?: number; env?: Record<string, string> } = {}) => {
  const r = spawnSync('/bin/bash', ['-c', 'source "$1"; MACHINE_LOCK_UID=$2; rc=0; machine_lock 9 "$3" 0 "held by another run" || rc=$?; echo "rc=$rc why=$MACHINE_LOCK_WHY"', '_', libSh, String(o.owner ?? uid()), path], { encoding: 'utf8', env: o.env ?? process.env });
  return { out: r.stdout.trim(), err: r.stderr };
};

test('#945: every setup lock is in the root-only directory, none in the world-writable /run/lock', { skip: !posix }, () => {
  const src = readFileSync(libSh, 'utf8');
  for (const name of ['ADD_PROJECT_LOCK', 'TAILSCALE_LOCK', 'MACHINE_SUDOERS_LOCK']) {
    const m = new RegExp(`^${name}=(\\S+)`, 'm').exec(src);
    assert.ok(m, `${name} is set in lib.sh`);
    assert.match(m[1]!, /^\/run\/worklane-machine\/[a-z-]+\.lock$/, `${name}=${m[1]}`);
  }
  assert.match(src, /^MACHINE_LOCK_UID=0$/m);
});

test('#945: no setup script opens or skips a machine lock by itself; each takes it through machine_lock', { skip: !posix }, () => {
  const scripts = readdirSync(setupDir).filter((f) => f.endsWith('.sh'));
  for (const f of scripts) {
    const src = readFileSync(join(setupDir, f), 'utf8');
    assert.doesNotMatch(src, /exec\s+\d+\s*[<>]+\s*"?\$\{?(ADD_PROJECT|TAILSCALE|MACHINE_SUDOERS)_LOCK/, `${f} opens a machine lock outside machine_lock`);
    assert.doesNotMatch(src, /if command -v flock/, `${f} skips its lock when flock is missing`);
  }
  const takes = (f: string, fd: number, v: string) => assert.match(readFileSync(join(setupDir, f), 'utf8'), new RegExp(`machine_lock ${fd} "\\$${v}" `), `${f} takes ${v}`);
  takes('add-project.sh', 9, 'ADD_PROJECT_LOCK');
  takes('instance-remove.sh', 9, 'ADD_PROJECT_LOCK');
  takes('instance-rename.sh', 9, 'ADD_PROJECT_LOCK');
  takes('tailscale.sh', 8, 'TAILSCALE_LOCK');
  takes('lib.sh', 8, 'MACHINE_SUDOERS_LOCK');
});

test('#945: machine_lock makes its directory root\'s 0700 and locks; a lock held through a read-only descriptor is reported held', { skip: !posix }, async () => {
  const T = mkdtempSync(join(tmpdir(), 'setup-locks-'));
  const path = join(T, 'machine', 'add-project.lock');
  assert.equal(lock(path).out, 'rc=0 why=');
  const d = statSync(join(T, 'machine'));
  assert.equal(d.mode & 0o777, 0o700);
  assert.equal(d.uid, uid());
  // Held as #945's reporter held it: opened read-only (flock needs no write), exclusive.
  const holder = spawn('/bin/bash', ['-c', 'exec 7<"$1"; flock -x 7; echo held; sleep 30', '_', path], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
    assert.equal(lock(path).out, 'rc=1 why=held by another run');
  } finally {
    holder.kill('SIGKILL');
  }
});

test('#945: machine_lock refuses, locking nothing, a world-writable parent, a loose or someone else\'s directory, and a link', { skip: !posix }, () => {
  const T = mkdtempSync(join(tmpdir(), 'setup-locks-'));
  // A parent like /run/lock (1777): anyone could plant the directory, so it is never used.
  const shared = join(T, 'shared');
  mkdirSync(shared);
  chmodSync(shared, 0o1777);
  const inShared = lock(join(shared, 'machine', 'x.lock')).out;
  assert.match(inShared, /^rc=2 why=refused: .*shared is not root's, or someone else can write it/);
  assert.ok(!existsSync(join(shared, 'machine')), 'nothing made in it');
  // The directory left 0755: anyone could open the lock in it.
  mkdirSync(join(T, 'loose'), { mode: 0o755 });
  chmodSync(join(T, 'loose'), 0o755);
  assert.match(lock(join(T, 'loose', 'x.lock')).out, /^rc=2 why=refused: .*loose is not root's 0700 directory/);
  assert.ok(!existsSync(join(T, 'loose', 'x.lock')));
  // A directory made by another user (here: owned by anyone but the one machine_lock wants).
  mkdirSync(join(T, 'theirs'), { mode: 0o700 });
  assert.match(lock(join(T, 'theirs', 'x.lock'), { owner: uid() + 1 }).out, /^rc=2 why=refused: /);
  // The directory a link (to a 0700 directory of the right owner): never followed.
  mkdirSync(join(T, 'real'), { mode: 0o700 });
  symlinkSync(join(T, 'real'), join(T, 'link'));
  assert.match(lock(join(T, 'link', 'x.lock')).out, /^rc=2 why=refused: .*link is not root's 0700 directory/);
  assert.ok(!existsSync(join(T, 'real', 'x.lock')));
});

test('#945: machine_lock refuses a pre-created lock that is a link or not a regular file, and never writes through it', { skip: !posix }, () => {
  const T = mkdtempSync(join(tmpdir(), 'setup-locks-'));
  const d = join(T, 'machine');
  mkdirSync(d, { mode: 0o700 });
  writeFileSync(join(T, 'target'), 'untouched\n');
  symlinkSync(join(T, 'target'), join(d, 'linked.lock'));
  assert.match(lock(join(d, 'linked.lock')).out, /^rc=2 why=refused: .*linked\.lock is not root's regular file/);
  assert.equal(readFileSync(join(T, 'target'), 'utf8'), 'untouched\n');
  symlinkSync(join(T, 'nowhere'), join(d, 'dangling.lock'));
  assert.match(lock(join(d, 'dangling.lock')).out, /^rc=2 why=refused: /);
  assert.ok(!existsSync(join(T, 'nowhere')), 'a dangling link is not created through');
  mkdirSync(join(d, 'dir.lock'));
  assert.match(lock(join(d, 'dir.lock')).out, /^rc=2 why=refused: .*dir\.lock is not root's regular file/);
  // A lock file root left there before is fine.
  writeFileSync(join(d, 'old.lock'), '');
  assert.equal(lock(join(d, 'old.lock')).out, 'rc=0 why=');
});

test('#945: without flock a run refuses, never skips the lock', { skip: !posix }, () => {
  const T = mkdtempSync(join(tmpdir(), 'setup-locks-'));
  const empty = join(T, 'no-flock');
  mkdirSync(empty);
  const r = lock(join(T, 'm', 'x.lock'), { env: { ...process.env, PATH: empty } });
  assert.match(r.out, /^rc=2 why=refused: .*needs flock/, r.err);
  assert.ok(!existsSync(join(T, 'm')));
});

test('#945: tailscale.sh refuses a step, starting nothing, when its lock\'s directory is not root\'s 0700', { skip: !posix }, () => {
  const T = mkdtempSync(join(tmpdir(), 'setup-locks-'));
  const s = join(T, 'scripts', 'setup');
  mkdirSync(s, { recursive: true });
  copyFileSync(join(setupDir, 'tailscale.sh'), join(s, 'tailscale.sh'));
  mkdirSync(join(T, 'locks'), { mode: 0o755 });
  chmodSync(join(T, 'locks'), 0o755);
  writeFileSync(join(s, 'lib.sh'), `source ${JSON.stringify(libSh)}
as_root() { :; }
TAILSCALE_DIR=${JSON.stringify(join(T, 'var'))} TAILSCALE_LOCK=${JSON.stringify(join(T, 'locks', 'tailscale.lock'))} MACHINE_LOCK_UID=${uid()}
`);
  const r = spawnSync('/bin/bash', [join(s, 'tailscale.sh'), 'install'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /refused: .*locks is not root's 0700 directory/);
  assert.ok(!existsSync(join(T, 'var')), 'no step started');
});
