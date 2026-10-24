// writeOwnerOnly never writes through, or sets the mode of, a link planted beside the file it writes (#950): not one
// planted before the write at the old guessable temp name, and not one swapped in for its temp file mid-write by a
// racer who lists the directory. Fixture files in temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { writeOwnerOnly } from '../src/os/index.js';

const POSIX = process.platform !== 'win32';
const mode = (p: string) => lstatSync(p).mode & 0o777;

/** A directory holding the file to write (with old content) and a victim file the writer can also write. */
function fixture(): { dir: string; file: string; victim: string } {
  const dir = mkdtempSync(join(tmpdir(), 'woo-'));
  const file = join(dir, 'token');
  const victim = join(dir, 'victim.key');
  writeFileSync(file, 'OLD\n', { mode: 0o600 });
  writeFileSync(victim, 'THE KEY', { mode: 0o644 });
  return { dir, file, victim };
}

test('writeOwnerOnly never writes through a link planted at the old guessable temp name <file>.<pid>.tmp', { skip: !POSIX && 'symlinks need privileges on Windows' }, () => {
  const { dir, file, victim } = fixture();
  const planted = `${file}.${process.pid}.tmp`;
  symlinkSync(victim, planted);
  writeOwnerOnly(file, 'NEW SECRET\n');
  assert.equal(readFileSync(victim, 'utf8'), 'THE KEY', 'the data went into the planted link');
  assert.equal(mode(victim), 0o644, 'the planted link target was chmod-ed');
  assert.ok(lstatSync(file).isFile(), 'the file is a regular file, not the planted link');
  assert.equal(readFileSync(file, 'utf8'), 'NEW SECRET\n');
  assert.equal(mode(file), 0o600);
  assert.ok(lstatSync(planted).isSymbolicLink(), 'the planted link is left as it was');
  assert.deepEqual(readdirSync(dir).sort(), [basename(file), basename(planted), basename(victim)].sort(), 'no staging name left behind');
});

test('writeOwnerOnly never sets the mode of a link swapped in for its temp file mid-write', { skip: !POSIX && 'symlinks need privileges on Windows' }, () => {
  const { dir, file, victim } = fixture();
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const real = { writeFileSync: fs.writeFileSync, writeSync: fs.writeSync };
  const swapped: string[] = [];
  /** The racer: after the data is written, every name beside the file but its own becomes a link to the victim. */
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
  fs.writeFileSync = ((...a: Parameters<typeof fs.writeFileSync>) => {
    real.writeFileSync(...a);
    if (dirname(String(a[0])) === dir || typeof a[0] === 'number') race();
  }) as typeof fs.writeFileSync;
  fs.writeSync = ((...a: Parameters<typeof fs.writeSync>) => {
    const n = (real.writeSync as (...x: unknown[]) => number)(...a);
    race();
    return n;
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  let err: unknown = null;
  try {
    writeOwnerOnly(file, 'NEW SECRET\n');
  } catch (e) {
    err = e;
  } finally {
    Object.assign(fs, real);
    syncBuiltinESMExports();
  }
  assert.ok(swapped.length > 0, 'the racer found the temp file and swapped it');
  assert.equal(mode(victim), 0o644, 'the swapped-in link target was chmod-ed to 0600');
  assert.equal(readFileSync(victim, 'utf8'), 'THE KEY', 'the data went into the swapped-in link');
  assert.ok(lstatSync(file).isFile(), 'the swapped-in link was published as the file');
  assert.match(String(err), /replaced/, 'the write is refused, not published');
  assert.equal(readFileSync(file, 'utf8'), 'OLD\n', 'the file is left as it was');
  assert.deepEqual(readdirSync(dir).sort(), [basename(file), basename(victim)].sort(), 'no staging name (or swapped link) left behind');
});
