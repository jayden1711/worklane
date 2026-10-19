// writeSlotFile (#661), the one way to write a file in the slot dir: whole or not at all, over a 0444 file, and
// nothing left behind. test/slot-dir-writes.test.ts checks that nothing else writes there.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeSlotFile } from '../src/slot-file.js';
import './helpers.js';

const skip = process.platform === 'win32' ? 'file modes' : process.getuid?.() === 0 ? 'root ignores file modes' : false;

/** A fresh dir inside the test's own (temporary) AGENT_SLOTS_DIR. */
const slotDir = () => mkdtempSync(join(process.env.AGENT_SLOTS_DIR!, 'slot-file-'));

const temps = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

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

test('writeSlotFile into a missing directory throws and creates nothing', () => {
  const dir = slotDir();
  assert.throws(() => writeSlotFile(join(dir, 'missing', 'x.json'), 'x'), { code: 'ENOENT' });
  assert.equal(existsSync(join(dir, 'missing')), false);
  assert.deepEqual(readdirSync(dir), []);
});
