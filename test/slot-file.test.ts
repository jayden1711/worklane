// writeSlotFile (#661), the one way to write a file in the slot dir: whole or not at all, over a 0444 file, and
// nothing left behind. test/slot-dir-writes.test.ts checks that nothing else writes there, and records every fs call
// the helper makes.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeSlotFile } from '../src/slot-file.js';
import './helpers.js';

const skip = process.platform === 'win32' ? 'file modes' : process.getuid?.() === 0 ? 'root ignores file modes' : false;

/** A fresh dir inside the test's own (temporary) AGENT_SLOTS_DIR. */
const slotDir = () => mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'slot-file-'));

const temps = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

type Fns = Record<string, (...a: never[]) => unknown>;

/** Run `fn` with some functions of a built-in module replaced (its ESM bindings too, as the helper imports them). */
function patched<T>(mod: 'node:fs' | 'node:crypto', with_: Record<string, (real: (...a: never[]) => unknown) => (...a: never[]) => unknown>, fn: () => T): T {
  const m = createRequire(import.meta.url)(mod) as Fns;
  const saved = new Map(Object.keys(with_).map((n) => [n, m[n]!]));
  for (const [n, make] of Object.entries(with_)) m[n] = make(saved.get(n)!);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    for (const [n, real] of saved) m[n] = real;
    syncBuiltinESMExports();
  }
}

/** A file of the writer's own, outside the slot dir: what a swapped-in symlink would point at. */
function ownFile(): string {
  const f = join(mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'own-')), 'secret');
  writeFileSync(f, 'secret', { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}

test('writeSlotFile replaces a 0444 file, with exactly the mode asked for, and leaves no temp file', { skip }, () => {
  const dir = slotDir();
  const file = join(dir, 'state.json');
  writeSlotFile(file, 'one');
  chmodSync(file, 0o444);
  writeSlotFile(file, 'two', { mode: 0o660, exactMode: true });
  assert.equal(readFileSync(file, 'utf8'), 'two');
  assert.equal(statSync(file).mode & 0o777, 0o660);
  assert.deepEqual(temps(dir), []);
});

test('writeSlotFile with replace false creates a file only when there is none (a lock), and leaves no temp file', { skip }, () => {
  const dir = slotDir();
  const lock = join(dir, 'x.lock');
  writeSlotFile(lock, 'mine', { replace: false });
  assert.equal(readFileSync(lock, 'utf8'), 'mine');
  assert.throws(() => writeSlotFile(lock, 'theirs', { replace: false }), { code: 'EEXIST' });
  assert.equal(readFileSync(lock, 'utf8'), 'mine', 'a lock already there is left as it is');
  assert.deepEqual(temps(dir), []);
});

test('exactMode sets the mode through its own descriptor: a temp file swapped for a symlink before the chmod leaves the link target as it was', { skip }, () => {
  const dir = slotDir();
  const own = ownFile();
  let swapped = 0;
  // The slot dir is group-writable without the sticky bit: another member can replace the temp file's name with a
  // symlink between its creation and its chmod. Whichever call the helper sets the mode with, the swap is done first.
  const swapFirst =
    (real: (...a: never[]) => unknown) =>
    (...a: never[]) => {
      for (const t of temps(dir)) {
        unlinkSync(join(dir, t));
        symlinkSync(own, join(dir, t));
        swapped++;
      }
      return real(...a);
    };
  patched('node:fs', { chmodSync: swapFirst, fchmodSync: swapFirst }, () => writeSlotFile(join(dir, 'github-budget-k.json'), '{}', { mode: 0o660, exactMode: true }));
  assert.equal(swapped, 1, 'the temp file was swapped before its mode was set');
  assert.equal((statSync(own).mode & 0o777).toString(8), '600', "the writer's own file keeps its mode");
  assert.equal(readFileSync(own, 'utf8'), 'secret', 'and its content');
});

test('a temp name that is taken (here a planted symlink) is skipped: never opened, written or removed', { skip }, () => {
  const dir = slotDir();
  const own = ownFile();
  const fixed = Buffer.alloc(8, 0xab);
  const planted = join(dir, `f.json.${process.pid}.${fixed.toString('hex')}.tmp`);
  symlinkSync(own, planted);
  let calls = 0;
  patched('node:crypto', { randomBytes: (real) => (...a: never[]) => (calls++ === 0 ? Buffer.from(fixed) : real(...a)) }, () => writeSlotFile(join(dir, 'f.json'), 'new'));
  assert.equal(calls, 2, 'a second name was drawn');
  assert.equal(readFileSync(join(dir, 'f.json'), 'utf8'), 'new');
  assert.equal(lstatSync(join(dir, 'f.json')).isSymbolicLink(), false);
  assert.equal(lstatSync(planted).isSymbolicLink(), true, 'the planted link is left where it is');
  assert.equal(readFileSync(own, 'utf8'), 'secret', 'and what it points at is not written');
  assert.deepEqual(temps(dir), [planted.slice(dir.length + 1)], 'no temp file of its own left');
});

test('a failed rename or link leaves no temp file', { skip }, () => {
  const dir = slotDir();
  const fail = (code: string) => () => () => {
    throw Object.assign(new Error(`simulated ${code}`), { code });
  };
  patched('node:fs', { renameSync: fail('EXDEV'), linkSync: fail('EPERM') }, () => {
    assert.throws(() => writeSlotFile(join(dir, 'a.json'), 'x'), { code: 'EXDEV' });
    assert.throws(() => writeSlotFile(join(dir, 'b.lock'), 'x', { replace: false }), { code: 'EPERM' });
  });
  assert.deepEqual(readdirSync(dir), []);
});

test('writeSlotFile into a missing directory throws and creates nothing', () => {
  const dir = slotDir();
  assert.throws(() => writeSlotFile(join(dir, 'missing', 'x.json'), 'x'), { code: 'ENOENT' });
  assert.equal(existsSync(join(dir, 'missing')), false);
  assert.deepEqual(readdirSync(dir), []);
});
