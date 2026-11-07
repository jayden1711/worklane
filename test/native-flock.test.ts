import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryLock } from '../src/locks.js';
import { darwinFlockFilesystemSupported, darwinProcessIdentity, nativeFlockInvocation, processIdentity, processPlace, UNKNOWN_IDENTITY } from '../src/os/index.js';

test('Darwin identities use stored UTC start times; malformed/hidden output never proves death', () => {
  const boot = 'boot';
  const identity = 'boot:1792749600000';
  assert.equal(darwinProcessIdentity('S  Fri Oct 23 10:00:00 2026\n', boot), identity);
  assert.equal(darwinProcessIdentity('SX Fri Oct 23 10:00:00 2026\n', boot), identity, 'tracing is not death');
  assert.equal(darwinProcessIdentity('SE Fri Oct 23 10:00:00 2026\n', boot), identity, 'exiting is not death');
  assert.equal(darwinProcessIdentity('Z  Fri Oct 23 10:00:00 2026\n', boot), null);
  for (const value of ['', 'S -', 'S Fri Oct 23 10:00:00 2026\nS Fri Oct 23 10:00:00 2026', 'S not a date']) {
    assert.equal(darwinProcessIdentity(value, boot), UNKNOWN_IDENTITY);
  }
});

test('Darwin filesystem selection checks structured local flags and exact names', () => {
  const record = (name: string, flags = 0x1000) => {
    const bytes = Buffer.alloc(20); bytes.writeUInt32LE(flags); bytes.write(name, 4); return bytes;
  };
  for (const name of ['apfs', 'hfs']) assert.equal(darwinFlockFilesystemSupported(record(name)), true);
  for (const name of ['nfs', 'smbfs', 'fuse', 'apfsX', '']) assert.equal(darwinFlockFilesystemSupported(record(name)), false);
  assert.equal(darwinFlockFilesystemSupported(record('apfs', 0)), false);
  assert.equal(darwinFlockFilesystemSupported(Buffer.alloc(19)), false);
  assert.equal(darwinFlockFilesystemSupported(Buffer.alloc(21)), false);
  const highBit = record('apfs'); highBit[4] = 0xe1;
  assert.equal(darwinFlockFilesystemSupported(highBit), false, 'high bits cannot be masked into an allowed name');
  const trailing = record('apfs'); trailing[19] = 1;
  assert.equal(darwinFlockFilesystemSupported(trailing), false);
});

test('native helpers share parent descriptor ownership, retain it after helper exit, and agree on contention', { timeout: 15000 }, () => {
  if (!['linux', 'darwin'].includes(process.platform)) {
    assert.throws(() => nativeFlockInvocation(process.platform), /supported POSIX/);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'native-flock-'));
  const path = join(dir, 'x.lock');
  const here = processPlace();
  assert.ok(here.boot && here.host && here.pidns, 'this platform must provide a known process place');
  assert.notEqual(processIdentity(process.pid), UNKNOWN_IDENTITY);
  let fd: number | undefined;
  let held: ReturnType<typeof tryLock> | undefined;
  const run = (platform: NodeJS.Platform) => {
    const helper = nativeFlockInvocation(platform);
    return spawnSync(helper.command, helper.args, { stdio: ['ignore', 'ignore', 'pipe', fd!], timeout: 5000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  };
  try {
    held = tryLock(path, 'parent');
    assert.ok('lock' in held);
    fd = openSync(join(dir, '.x.lock.flock'), 'r');
    // The Darwin helper's native-flock primitive is also executable on Linux; no fcntl emulation is allowed.
    assert.equal(run('darwin').status, 75, 'an independent open cannot take the live parent lock');
    held.lock.release();
    assert.equal(run('darwin').status, 0);
    assert.ok(!('lock' in tryLock(path, 'contender')), 'helper exit did not release the parent descriptor lock');
    closeSync(fd); fd = undefined;
    held = tryLock(path, 'successor');
    assert.ok('lock' in held);
    held.lock.release();
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (held && 'lock' in held) held.lock.release();
    rmSync(dir, { recursive: true, force: true });
  }
});
