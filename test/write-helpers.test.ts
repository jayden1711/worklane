// The other writers in src/os/index.ts write as writeOwnerOnly does (#1062, after #950): writeExecutable,
// writeGroupOnly and writeAgentReadable never write through, or set the mode or group of, a link planted beside the
// file they write (at the file, at the old guessable temp name, or swapped in mid-write by a racer who lists the
// directory); a staging file swapped mid-write is refused; and each sets exactly its mode. Server init's record is
// opened to the coordinator's group through the staging file's descriptor before it is published, never by name
// after. Fixture files in temp dirs only; the group comes from a stand-in getent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { writeServerInitState, type InitState } from '../src/init.js';
import { writeAgentReadable, writeExecutable, writeGroupOnly } from '../src/os/index.js';
import { coordinatorUser } from '../src/setup/app-manifest.js';
import { hostToolStandIns, onStandIns } from './host-tools.js';

const POSIX = process.platform !== 'win32';
const noLinks = !POSIX && 'symlinks need privileges on Windows';
const mode = (p: string) => lstatSync(p).mode & 0o777;
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

/** Run `fn` under `umask` (POSIX), restored after. */
function underUmask<T>(umask: number, fn: () => T): T {
  if (!POSIX) return fn();
  const before = process.umask(umask);
  try {
    return fn();
  } finally {
    process.umask(before);
  }
}

interface Writer {
  name: string;
  write: (file: string, data: string) => void;
  /** The mode the file written has (umask 022, replacing a 0640 file). */
  mode: number;
}

const WRITERS: Writer[] = [
  { name: 'writeExecutable (0755)', write: (f, d) => writeExecutable(f, d, 0o755), mode: 0o755 },
  { name: 'writeExecutable (0700)', write: (f, d) => writeExecutable(f, d, 0o700), mode: 0o700 },
  { name: 'writeGroupOnly', write: (f, d) => writeGroupOnly(f, d), mode: 0o660 },
  { name: 'writeAgentReadable', write: (f, d) => writeAgentReadable(f, d, POSIX ? process.getgid!() : 0), mode: 0o640 },
];

/** A directory holding the file to write (old content, 0640) and a victim file the writer can also write (0600). */
function fixture(): { dir: string; file: string; victim: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wh-'));
  const file = join(dir, 'state.json');
  const victim = join(dir, 'victim.key');
  writeFileSync(file, 'OLD\n', { mode: 0o640 });
  writeFileSync(victim, 'THE KEY', { mode: 0o600 });
  return { dir, file, victim };
}

/** The victim is as it was: its data, its mode and its group. */
function victimUntouched(victim: string, gid: number): void {
  assert.equal(readFileSync(victim, 'utf8'), 'THE KEY', 'the data went into the link');
  assert.equal(mode(victim), 0o600, "the link's target had its mode changed");
  assert.equal(statSync(victim).gid, gid, "the link's target had its group changed");
}

for (const w of WRITERS) {
  test(`${w.name} never writes through a link planted at the file or at the old guessable temp name <file>.<pid>.tmp`, { skip: noLinks }, () => {
    const { dir, file, victim } = fixture();
    const gid = statSync(victim).gid;
    const victim2 = join(dir, 'victim2.key');
    writeFileSync(victim2, 'THE KEY', { mode: 0o600 });
    const planted = `${file}.${process.pid}.tmp`;
    symlinkSync(victim, planted);
    rmSync(file);
    symlinkSync(victim2, file);
    underUmask(0o022, () => w.write(file, 'NEW\n'));
    victimUntouched(victim, gid);
    victimUntouched(victim2, gid);
    assert.ok(lstatSync(file).isFile(), 'the file is a regular file, not the link that was there');
    assert.equal(readFileSync(file, 'utf8'), 'NEW\n');
    assert.ok(lstatSync(planted).isSymbolicLink(), 'the planted link is left as it was');
    assert.deepEqual(readdirSync(dir).sort(), [basename(file), basename(planted), basename(victim), basename(victim2)].sort(), 'no staging name left behind');
  });

  test(`${w.name} never writes through, or sets the mode of, a link swapped in for its temp file mid-write`, { skip: noLinks }, () => {
    const { dir, file, victim } = fixture();
    const gid = statSync(victim).gid;
    const real = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, writeSync: fs.writeSync };
    const swapped: string[] = [];
    /** The racer: once a file beside `file` is opened or written, every other name there becomes a link to the victim. */
    const race = () => {
      if (swapped.length) return;
      for (const name of readdirSync(dir)) {
        if (name === basename(file) || name === basename(victim)) continue;
        const p = join(dir, name);
        rmSync(p, { force: true });
        symlinkSync(victim, p);
        swapped.push(name);
      }
    };
    fs.openSync = ((...a: Parameters<typeof fs.openSync>) => {
      const fd = real.openSync(...a);
      if (dirname(String(a[0])) === dir) race();
      return fd;
    }) as typeof fs.openSync;
    fs.writeFileSync = ((...a: Parameters<typeof fs.writeFileSync>) => {
      real.writeFileSync(...a);
      if (typeof a[0] === 'number' || dirname(String(a[0])) === dir) race();
    }) as typeof fs.writeFileSync;
    fs.writeSync = ((...a: Parameters<typeof fs.writeSync>) => {
      const n = (real.writeSync as (...x: unknown[]) => number)(...a);
      race();
      return n;
    }) as typeof fs.writeSync;
    syncBuiltinESMExports();
    let err: unknown = null;
    try {
      underUmask(0o022, () => w.write(file, 'NEW\n'));
    } catch (e) {
      err = e;
    } finally {
      Object.assign(fs, real);
      syncBuiltinESMExports();
    }
    assert.ok(swapped.length > 0, 'the racer found the temp file and swapped it');
    victimUntouched(victim, gid);
    assert.ok(lstatSync(file).isFile(), 'the swapped-in link was published as the file');
    assert.match(String(err), /replaced/, 'the write is refused, not published');
    assert.equal(readFileSync(file, 'utf8'), 'OLD\n', 'the file is left as it was');
    assert.deepEqual(readdirSync(dir).sort(), [basename(file), basename(victim)].sort(), 'no staging name (or swapped link) left behind');
  });

  test(`${w.name} refuses a staging file swapped mid-write for a link to the very file it wrote`, { skip: noLinks }, () => {
    const { dir, file, victim } = fixture();
    const real = fs.writeFileSync;
    const aside = join(mkdtempSync(join(tmpdir(), 'wh-aside-')), 'moved');
    let raced = false;
    fs.writeFileSync = ((...a: Parameters<typeof fs.writeFileSync>) => {
      real(...a);
      if (raced || typeof a[0] !== 'number') return;
      raced = true;
      const names = readdirSync(dir).filter((n) => n !== basename(file) && n !== basename(victim));
      assert.equal(names.length, 1, `one staging name beside the file: ${names.join(', ')}`);
      renameSync(join(dir, names[0]!), aside);
      symlinkSync(aside, join(dir, names[0]!));
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => underUmask(0o022, () => w.write(file, 'NEW\n')), /replaced/, 'a link at the staging name is refused, even to the file written');
    } finally {
      fs.writeFileSync = real;
      syncBuiltinESMExports();
    }
    assert.ok(raced, 'the data went through a descriptor of its own');
    assert.ok(lstatSync(file).isFile(), 'the link was published as the file');
    assert.equal(readFileSync(file, 'utf8'), 'OLD\n', 'the file is left as it was');
    assert.deepEqual(readdirSync(dir).sort(), [basename(file), basename(victim)].sort(), 'nothing left beside it');
  });

  test(`${w.name} leaves the file exactly its mode, whatever the umask`, { skip: !POSIX && 'POSIX modes' }, () => {
    const { file } = fixture();
    underUmask(0o022, () => w.write(file, 'NEW\n'));
    assert.equal(mode(file), w.mode);
    assert.equal(readFileSync(file, 'utf8'), 'NEW\n');
    if (w.name === 'writeGroupOnly') return;
    rmSync(file);
    underUmask(0o277, () => w.write(file, 'NEWER\n'));
    assert.equal(mode(file), w.mode);
    assert.equal(readFileSync(file, 'utf8'), 'NEWER\n');
  });
}

test('writeGroupOnly keeps a 0600 file 0600 and opens any other to 0660, as groupOnly does', { skip: !POSIX && 'POSIX modes' }, () => {
  const { file } = fixture();
  underUmask(0o022, () => writeGroupOnly(file, 'NEW\n'));
  assert.equal(mode(file), 0o660, 'a 0640 file becomes 0660');
  rmSync(file);
  underUmask(0o007, () => writeGroupOnly(file, 'NEW\n'));
  assert.equal(mode(file), 0o660, 'a new file is 0660');
  rmSync(file);
  writeFileSync(file, 'OLD\n', { mode: 0o600 });
  underUmask(0o022, () => writeGroupOnly(file, 'NEW\n'));
  assert.equal(mode(file), 0o600, 'a 0600 file stays 0600');
  assert.equal(readFileSync(file, 'utf8'), 'NEW\n');
});

test('writeGroupOnly opens a file it replaces to 0660 whatever the umask, unless it was 0600', { skip: !POSIX && 'POSIX modes' }, () => {
  const { file } = fixture();
  for (const [was, umask, want] of [
    [0o660, 0o077, 0o660],
    [0o640, 0o077, 0o660],
    [0o644, 0o277, 0o660],
    [0o600, 0o077, 0o600],
    [0o600, 0o022, 0o600],
    [0o600, 0o000, 0o600],
  ] as const) {
    rmSync(file);
    writeFileSync(file, 'OLD\n', { mode: was });
    fs.chmodSync(file, was);
    underUmask(umask, () => writeGroupOnly(file, 'NEW\n'));
    assert.equal(mode(file), want, `a ${was.toString(8)} file under umask ${umask.toString(8).padStart(3, '0')}`);
    assert.equal(readFileSync(file, 'utf8'), 'NEW\n');
  }
  rmSync(file);
  underUmask(0o077, () => writeGroupOnly(file, 'NEW\n'));
  assert.equal(mode(file), 0o600, 'a new file the umask leaves 0600 stays 0600');
});

test('writeGroupOnly still writes the file where the file system refuses a mode change, as groupOnly did', { skip: !POSIX && 'POSIX modes' }, () => {
  const { dir, file, victim } = fixture();
  const real = fs.fchmodSync;
  let refused = 0;
  fs.fchmodSync = (() => {
    refused++;
    throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), { code: 'EPERM' });
  }) as typeof fs.fchmodSync;
  syncBuiltinESMExports();
  try {
    underUmask(0o022, () => writeGroupOnly(file, 'NEW\n'));
  } finally {
    fs.fchmodSync = real;
    syncBuiltinESMExports();
  }
  assert.ok(refused > 0, 'the mode change was tried');
  assert.equal(readFileSync(file, 'utf8'), 'NEW\n');
  assert.ok(lstatSync(file).isFile());
  assert.deepEqual(readdirSync(dir).sort(), [basename(file), basename(victim)].sort(), 'no staging name left behind');
});

test('writeAgentReadable gives the file its group through the descriptor', { skip: !POSIX && 'POSIX groups' }, () => {
  const { file } = fixture();
  const gid = process.getgid!();
  writeAgentReadable(file, 'NEW\n', gid);
  assert.equal(statSync(file).gid, gid);
  assert.equal(statSync(file).uid, process.getuid!());
  assert.equal(mode(file), 0o640);
});

// ---------------------------------------------------------------------------------------------------------------
// Server init's record, opened to the instance's coordinator group (src/init.ts writeServerInitState).

const INSTANCE = 'shop';
const STATE = { version: 1, mode: 'server', target: 'example-org/shop', repo: 'example-org/shop', instance: INSTANCE, steps: {}, handoff: {} } as unknown as InitState;

/** A stand-in getent on PATH that knows the coordinator's group as this process's own group, for `fn`. */
function withCoordinatorGroup<T>(fn: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), 'wh-bin-'));
  hostToolStandIns(bin, { tools: ['getent'], answers: { getent: { [`group ${coordinatorUser(INSTANCE)}`]: `${coordinatorUser(INSTANCE)}:x:${process.getgid!()}:\n` } } });
  return onStandIns(bin, fn);
}

test("writeServerInitState opens the record to the coordinator's group, read only", { skip: process.platform !== 'linux' && 'Linux only' }, () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wh-init-')), 'init', `${INSTANCE}.json`);
  withCoordinatorGroup(() => writeServerInitState(file, STATE, INSTANCE));
  assert.equal(mode(file), 0o640);
  assert.equal(statSync(file).gid, process.getgid!());
  assert.equal(statSync(file).uid, process.getuid!());
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), STATE);
  assert.deepEqual(readdirSync(dirname(file)), [basename(file)], 'no staging name left behind');
});

test('writeServerInitState leaves the record 0600 when the group is unknown', { skip: !POSIX && 'POSIX modes' }, () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wh-init-')), 'init', `${INSTANCE}.json`);
  const bin = mkdtempSync(join(tmpdir(), 'wh-bin-'));
  hostToolStandIns(bin, { tools: ['getent'] });
  onStandIns(bin, () => writeServerInitState(file, STATE, INSTANCE));
  assert.equal(mode(file), 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), STATE);
});

test('writeServerInitState never changes the group or mode of a link swapped in for the record once it is published', { skip: process.platform !== 'linux' && 'Linux only' }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'wh-init-')), 'init');
  const file = join(dir, `${INSTANCE}.json`);
  const victim = join(dirname(dir), 'victim.key');
  writeFileSync(victim, 'THE KEY', { mode: 0o600 });
  const gid = statSync(victim).gid;
  const real = fs.renameSync;
  let swapped = false;
  fs.renameSync = ((from: string, to: string) => {
    real(from, to);
    if (swapped || String(to) !== file) return;
    swapped = true;
    rmSync(file);
    symlinkSync(victim, file);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    withCoordinatorGroup(() => writeServerInitState(file, STATE, INSTANCE));
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
  assert.ok(swapped, 'the racer saw the record published');
  victimUntouched(victim, gid);
});
