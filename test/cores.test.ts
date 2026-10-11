import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestsConfig } from '../src/config/schema.js';
import { coreShare, currentCoreShare, envWithCores, withCores } from '../src/cores.js';
import { cpuCount } from '../src/os/index.js';

test('a task\'s share is the cores split over the agents running, rounded down so they never oversubscribe', () => {
  assert.equal(coreShare({ cores: 16, running: 1 }), 16);
  assert.equal(coreShare({ cores: 16, running: 2 }), 8);
  assert.equal(coreShare({ cores: 16, running: 3 }), 5);
  for (let running = 1; running <= 16; running++) {
    assert.ok(coreShare({ cores: 16, running }) * running <= 16, `${running} agents never ask for more than 16 cores`);
  }
  assert.equal(coreShare({ cores: 16, running: 0 }), 16, 'the task itself counts when no slot is held yet');
});

test('the reserve is kept back, and the share stays within min..max', () => {
  assert.equal(coreShare({ cores: 16, running: 2, budget: { reserve: 2, min: 1 } }), 7);
  assert.equal(coreShare({ cores: 16, running: 1, budget: { reserve: 0, min: 1, max: 6 } }), 6);
  assert.equal(coreShare({ cores: 4, running: 8, budget: { reserve: 0, min: 2 } }), 2, 'never below min');
  assert.equal(coreShare({ cores: 2, running: 1, budget: { reserve: 8, min: 1 } }), 1, 'a reserve above the machine leaves one core');
});

test('{cores} is filled in in env values and commands, nothing else is touched', () => {
  assert.deepEqual(envWithCores({ WORKERS: '{cores}', OTHER: 'x', BOTH: '-n {cores} --dist={cores}' }, 5), { WORKERS: '5', OTHER: 'x', BOTH: '-n 5 --dist=5' });
  assert.equal(withCores('npm test -- --maxWorkers={cores}', 3), 'npm test -- --maxWorkers=3');
  assert.equal(withCores('make -j{cores} test', 8), 'make -j8 test');
  assert.equal(withCores('make test', 8), 'make test');
  assert.deepEqual(envWithCores(undefined, 4), {});
});

test('the current share counts the live agent slots on the machine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slots-'));
  const cores = cpuCount();
  assert.equal(currentCoreShare(undefined, dir), cores, 'no agents running: the whole machine');
  // Two live agents (this process's pid is alive), one stale (a pid that isn't).
  writeFileSync(join(dir, 'agent-0.lock'), JSON.stringify({ pid: process.pid, owner: 'a', acquiredAt: new Date().toISOString() }));
  writeFileSync(join(dir, 'agent-1.lock'), JSON.stringify({ pid: process.pid, owner: 'b', acquiredAt: new Date().toISOString() }));
  writeFileSync(join(dir, 'agent-2.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, owner: 'gone', acquiredAt: new Date().toISOString() }));
  assert.equal(currentCoreShare(undefined, dir), Math.max(1, Math.floor(cores / 2)));
});

test('tests.yaml takes a core budget, with safe defaults', () => {
  const base = { version: 1, runner: { kind: 'command', changed: 'make test-fast', full: 'make test-full' } };
  assert.deepEqual(TestsConfig.parse(base).cores, { reserve: 0, min: 1 });
  assert.deepEqual(TestsConfig.parse({ ...base, cores: { reserve: 2, max: 6 } }).cores, { reserve: 2, min: 1, max: 6 });
  assert.throws(() => TestsConfig.parse({ ...base, cores: { min: 4, max: 2 } }), /max must be at least min/);
  assert.throws(() => TestsConfig.parse({ ...base, cores: { workers: 3 } }));
});
