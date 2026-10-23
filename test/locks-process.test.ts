// #960: scratch lock records only. Process/place changes are recorded fixtures, never host namespace changes.
// The FIFO regression runs only in a child with a hard timeout, including against the old implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryLock } from '../src/locks.js';
import { processIdentity, processIdentityInPlace, processPlace, UNKNOWN_IDENTITY } from '../src/os/index.js';

const here = processPlace();
const identity = processIdentity(process.pid);
const known = !!(here.host && here.boot && here.pidns && identity && identity !== UNKNOWN_IDENTITY);
const linuxIdentity = { skip: !known && 'known process place and start time required' };
const fixture = () => join(mkdtempSync(join(tmpdir(), 'lock960-')), 'x.lock');
const stale = () => ({ pid: 2147483646, owner: 'gone', acquiredAt: 'then', place: here, identity });
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const busy = (path: string) => assert.ok(!('lock' in tryLock(path, 'contender')), 'existing lock remains busy');
const claimFor = (path: string, text: string) => `${path}.${createHash('sha256').update(text).digest('hex').slice(0, 16)}.claim`;

test('#960: the OS adapter recognises only a start identity belonging to a known process place', () => {
  assert.equal(processIdentityInPlace(identity, here), known);
  for (const candidate of [null, undefined, 12, {}, UNKNOWN_IDENTITY, '', `${here.boot}:`, `${here.boot}:1junk`, 'another-boot:123']) {
    assert.equal(processIdentityInPlace(candidate, here), false);
  }
  assert.equal(processIdentityInPlace(identity, { ...here, boot: null }), false);
  assert.equal(processIdentityInPlace(identity, { ...here, pidns: null }), false);
  assert.equal(processIdentityInPlace(identity, { ...here, host: '' }), false);
});

test('#960: a new lock records its process place and identity, and a live holder stays exclusive', () => {
  const path = fixture();
  const first = tryLock(path, 'holder');
  assert.ok('lock' in first);
  const info = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(info.place, here);
  assert.equal(info.identity, identity);
  busy(path);
  first.lock.release();
  assert.equal(existsSync(path), false);
});

test('#960: dead pids in another host, boot or pid namespace are never taken over', linuxIdentity, () => {
  for (const key of ['host', 'boot', 'pidns'] as const) {
    const path = fixture();
    save(path, { ...stale(), place: { ...here, [key]: 'somewhere-else' } });
    const text = readFileSync(path, 'utf8');
    busy(path);
    assert.equal(readFileSync(path, 'utf8'), text, key);
  }
});

test('#960: legacy, unknown, malformed and invalid-pid records cannot prove staleness', () => {
  for (const record of [
    { pid: 2147483646, owner: 'legacy', acquiredAt: 'then' },
    { ...stale(), place: { ...here, boot: null } },
    { ...stale(), place: { ...here, host: '' } },
    { ...stale(), identity: UNKNOWN_IDENTITY },
    { ...stale(), identity: null },
    { ...stale(), identity: 'not-a-process-identity' },
    { ...stale(), identity: `${here.boot}:123junk` },
    { ...stale(), identity: 'another-boot:123' },
    { ...stale(), pid: -1 },
    { ...stale(), pid: Number.MAX_SAFE_INTEGER },
    { ...stale(), pid: '2147483646' },
    null,
    [],
  ]) {
    const path = fixture();
    save(path, record);
    const text = readFileSync(path, 'utf8');
    busy(path);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
  const path = fixture();
  writeFileSync(path, '{broken');
  busy(path);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
});

test('#960: a dead holder in the known same place is taken over through the claim', linuxIdentity, () => {
  const path = fixture();
  save(path, stale());
  let inspected = 0;
  let taking = 0;
  const got = tryLock(path, 'new', { inspected: () => inspected++, taking: () => taking++ });
  assert.ok('lock' in got);
  assert.equal(inspected, 1);
  assert.equal(taking, 1);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).owner, 'new');
  got.lock.release();
});

test('#960: a reused pid with another recorded start identity is stale; the same identity is never stale', linuxIdentity, () => {
  const path = fixture();
  save(path, { ...stale(), pid: process.pid, identity: `${here.boot}:0` });
  const got = tryLock(path, 'new');
  assert.ok('lock' in got, 'the recorded holder is gone despite its reused numeric pid');
  got.lock.release();
  save(path, { ...stale(), pid: process.pid, acquiredAt: '1900-01-01' });
  busy(path);
});

test('#960: an unreadable live process identity is unknown and never proves a lock stale', linuxIdentity, (t) => {
  for (const code of ['ENOENT', 'ESRCH', 'EACCES']) {
    const path = fixture();
    save(path, { ...stale(), pid: process.pid, identity: `${here.boot}:0` });
    const text = readFileSync(path, 'utf8');
    const original = fs.readFileSync;
    const originalExec = childProcess.execFileSync;
    t.mock.method(childProcess, 'execFileSync', (...args: Parameters<typeof originalExec>) => {
      if (args[0] === '/bin/ps') throw Object.assign(new Error('process entry unavailable'), { code });
      return originalExec(...args);
    });
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof original>) => {
      if (args[0] === `/proc/${process.pid}/stat`) throw Object.assign(new Error('process entry unavailable'), { code });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.equal(processIdentity(process.pid), UNKNOWN_IDENTITY, code);
      busy(path);
      assert.equal(readFileSync(path, 'utf8'), text, code);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});

test('#960: symlink, directory and oversized lock records are refused without replacing them', { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
  const link = fixture();
  const target = `${link}.target`;
  save(target, stale());
  symlinkSync(target, link);
  const text = readFileSync(target, 'utf8');
  busy(link);
  assert.equal(readFileSync(target, 'utf8'), text);
  const dir = fixture();
  mkdirSync(dir);
  busy(dir);
  const large = fixture();
  const largeText = JSON.stringify({ ...stale(), owner: 'x'.repeat(8192) });
  writeFileSync(large, largeText);
  busy(large);
  assert.equal(readFileSync(large, 'utf8'), largeText);
});

test('#960: a FIFO lock returns busy promptly (bounded child, including fail-without)', { skip: process.platform === 'win32' && 'POSIX FIFOs' }, () => {
  const path = fixture();
  const made = spawnSync('mkfifo', [path], { timeout: 1000 });
  assert.equal(made.status, 0);
  const script = `const {tryLock}=await import(${JSON.stringify(new URL('../src/locks.js', import.meta.url).href)}); console.log('lock' in tryLock(${JSON.stringify(path)}, 'fifo') ? 'got' : 'busy');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 1500 });
  assert.equal(child.error, undefined, 'lock reader must not wait for a FIFO writer');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'busy');
});

test('#960: unknown, foreign and live takeover claims are never removed, even when old', linuxIdentity, () => {
  for (const claim of [
    { pid: 2147483646, at: 0 },
    { ...stale(), at: 0, place: { ...here, host: 'another-host' } },
    { ...stale(), at: 0, identity: UNKNOWN_IDENTITY },
    { ...stale(), pid: process.pid, at: 0 },
  ]) {
    const path = fixture();
    const text = JSON.stringify(stale());
    writeFileSync(path, text);
    const claimPath = claimFor(path, text);
    save(claimPath, claim);
    const claimText = readFileSync(claimPath, 'utf8');
    busy(path);
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.equal(readFileSync(claimPath, 'utf8'), claimText);
  }
});

test('#960: a known dead takeover claim is cleared and exclusive takeover still works', linuxIdentity, () => {
  const path = fixture();
  const text = JSON.stringify(stale());
  writeFileSync(path, text);
  const claimPath = claimFor(path, text);
  save(claimPath, { ...stale(), at: Date.now() });
  const got = tryLock(path, 'new');
  assert.ok('lock' in got);
  assert.equal(existsSync(claimPath), false);
  got.lock.release();
});
