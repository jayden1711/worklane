import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { machineStats, parseLoadavg, parseMeminfo, parseSystemctlShow } from '../src/os/stats.js';

const MEMINFO = `MemTotal:       32768000 kB
MemFree:         1024000 kB
MemAvailable:   20480000 kB
Buffers:          512000 kB
SwapCached:            0 kB
SwapTotal:       8388604 kB
SwapFree:        8000000 kB
`;

const SHOW = `MemoryCurrent=3758096384
MemoryMax=10737418240
MemorySwapCurrent=0
CPUUsageNSec=912345678901
ActiveState=active
`;

test('meminfo: total, available and swap, in bytes; incomplete input is null', () => {
  assert.deepEqual(parseMeminfo(MEMINFO), { totalBytes: 32768000 * 1024, availableBytes: 20480000 * 1024, swapTotalBytes: 8388604 * 1024, swapFreeBytes: 8000000 * 1024 });
  assert.equal(parseMeminfo('MemTotal: 1 kB\n'), null);
  assert.equal(parseMeminfo(''), null);
});

test('loadavg: the 1, 5 and 15 minute averages; malformed is null', () => {
  assert.deepEqual(parseLoadavg('0.52 1.10 2.05 2/1234 56789\n'), [0.52, 1.1, 2.05]);
  assert.equal(parseLoadavg('garbage'), null);
  assert.equal(parseLoadavg(''), null);
});

test('systemctl show: memory, limit, swap and CPU; unset, infinity and the not-accounted sentinel are null', () => {
  assert.deepEqual(parseSystemctlShow('svc.service', SHOW), { unit: 'svc.service', memoryCurrent: 3758096384, memoryMax: 10737418240, memorySwapCurrent: 0, cpuUsageNSec: 912345678901, activeState: 'active' });
  const idle = parseSystemctlShow('idle.service', 'MemoryCurrent=[not set]\nMemoryMax=infinity\nMemorySwapCurrent=18446744073709551615\nCPUUsageNSec=[not set]\nActiveState=inactive\n');
  assert.deepEqual(idle, { unit: 'idle.service', memoryCurrent: null, memoryMax: null, memorySwapCurrent: null, cpuUsageNSec: null, activeState: 'inactive' });
  assert.equal(parseSystemctlShow('x', 'MemoryCurrent=12\r\n').memoryCurrent, 12, 'CRLF');
});

test('machine stats on Linux: /proc and an unprivileged systemctl show per unit, disk per path', () => {
  const execs: string[][] = [];
  const s = machineStats(
    { units: ['a.service', 'bad name;rm -rf /', 'gone.service'], paths: ['/srv', '/missing'] },
    {
      platform: 'linux',
      readFile: (p) => (p === '/proc/meminfo' ? MEMINFO : '1.00 2.00 3.00 1/2 3\n'),
      exec: (file, args) => {
        execs.push([file, ...args]);
        if (args[1] === 'gone.service') throw new Error('Unit gone.service could not be found.');
        return SHOW;
      },
      statfs: (p) => {
        if (p === '/missing') throw new Error('ENOENT: no such file or directory');
        return { blocks: 1000, bsize: 4096, bavail: 250 };
      },
      now: () => new Date('2026-10-10T00:00:00Z'),
    },
  );
  assert.equal(s.at, '2026-10-10T00:00:00.000Z');
  assert.equal(s.memory!.availableBytes, 20480000 * 1024);
  assert.deepEqual(s.load, [1, 2, 3]);
  assert.deepEqual(execs, [
    ['systemctl', 'show', 'a.service', '-p', 'MemoryCurrent,MemoryMax,MemorySwapCurrent,CPUUsageNSec,ActiveState'],
    ['systemctl', 'show', 'gone.service', '-p', 'MemoryCurrent,MemoryMax,MemorySwapCurrent,CPUUsageNSec,ActiveState'],
  ], 'never runs a name that is not a unit name');
  assert.equal((s.units![0] as { memoryCurrent: number }).memoryCurrent, 3758096384);
  assert.deepEqual(s.units![1], { unit: 'bad name;rm -rf /', error: 'not a unit name' });
  assert.match((s.units![2] as { error: string }).error, /could not be found/);
  assert.deepEqual(s.disks[0], { path: '/srv', freeBytes: 250 * 4096, totalBytes: 1000 * 4096 });
  assert.match((s.disks[1] as { error: string }).error, /ENOENT/);
  assert.deepEqual(s.unavailable, []);
});

test('machine stats elsewhere: memory, load and units are not measured; disk still is', () => {
  for (const platform of ['darwin', 'win32']) {
    const s = machineStats({ units: ['a.service'], paths: ['x'] }, { platform, readFile: () => assert.fail('no /proc'), exec: () => assert.fail('no systemctl'), statfs: () => ({ blocks: 10, bsize: 1, bavail: 5 }) });
    assert.deepEqual([s.memory, s.load, s.units], [null, null, null], platform);
    assert.deepEqual(s.disks, [{ path: 'x', freeBytes: 5, totalBytes: 10 }]);
    assert.match(s.unavailable.join(), new RegExp(`not measured on ${platform}`));
  }
});

test('machine stats never throw: unreadable /proc is null with the reason', () => {
  const s = machineStats({}, { platform: 'linux', readFile: () => { throw new Error('EACCES: permission denied'); } });
  assert.deepEqual([s.memory, s.load], [null, null]);
  assert.deepEqual(s.unavailable, ['memory: EACCES: permission denied', 'load: EACCES: permission denied']);
  const garbled = machineStats({}, { platform: 'linux', readFile: () => 'nonsense' });
  assert.deepEqual(garbled.unavailable, ['memory: unreadable', 'load: unreadable']);
});

test('machine stats on this machine, for real: no throw, the shape is right', () => {
  const s = machineStats({ units: ['no-such-unit-here.service'], paths: [tmpdir()] });
  assert.equal(s.platform, process.platform);
  assert.ok('freeBytes' in s.disks[0]!, JSON.stringify(s.disks[0]));
  if (process.platform === 'linux') assert.ok(s.memory === null || s.memory.totalBytes > 0);
  else assert.equal(s.memory, null);
});
