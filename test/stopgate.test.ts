import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryLock } from '../src/locks.js';
import { runStopGate, type GateOptions } from '../src/stopgate.js';

function setup(doneWhen: unknown[], over: Partial<GateOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const taskFile = join(dir, 'task.json');
  writeFileSync(taskFile, JSON.stringify({ id: 'issue-7', done_when: doneWhen }));
  const opts: GateOptions = { cwd: dir, stateDir: join(dir, 'state'), taskFile, timeoutS: 30, lockWaitS: 0, busyPatterns: [], ...over };
  return { dir, opts };
}

const records = (stateDir: string) =>
  readFileSync(join(stateDir, 'stopgate.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { outcome: string; unavailable: boolean });

test('regression: the Stop gate blocks (never skips) when another gate run holds the lock', async () => {
  const { opts } = setup([{ command: 'node -e "process.exit(0)"' }]);
  const held = tryLock(join(opts.stateDir, 'stopgate-issue-7.lock'), 'another gate run');
  assert.ok('lock' in held);
  try {
    const r = await runStopGate(opts);
    assert.equal(r.outcome, 'block');
    assert.equal(r.unavailable, true);
    assert.match(r.reason, /busy.*not skipping/);
    const last = records(opts.stateDir).at(-1)!;
    assert.equal(last.outcome, 'block');
    assert.equal(last.unavailable, true);
  } finally {
    held.lock.release();
  }
  assert.equal((await runStopGate(opts)).outcome, 'pass', 'passes once the lock is free');
});

test('regression: the Stop gate blocks when the test runner reports it is busy', async () => {
  const { opts } = setup([{ command: `node -e "console.log('another full run is active'); process.exit(0)"` }], { busyPatterns: ['another full run is active'] });
  const r = await runStopGate(opts);
  assert.equal(r.outcome, 'block');
  assert.equal(r.unavailable, true);
  assert.match(r.reason, /COULD NOT RUN/);
});

test('Stop gate blocks on timeout and kills the check', async () => {
  const { opts } = setup([{ command: 'node -e "setTimeout(()=>{}, 60000)"', timeout_s: 1 }]);
  const started = Date.now();
  const r = await runStopGate(opts);
  assert.equal(r.outcome, 'block');
  assert.match(r.reason, /timed out/);
  assert.ok(Date.now() - started < 15_000);
});

test('Stop gate blocks with output on a failing check and passes when all pass', async () => {
  const fail = await runStopGate(setup([{ command: 'node -e "process.exit(0)"' }, { command: `node -e "console.error('assertion x failed'); process.exit(3)"` }]).opts);
  assert.equal(fail.outcome, 'block');
  assert.equal(fail.unavailable, false);
  assert.match(fail.reason, /FAILED.*exit 3[\s\S]*assertion x failed/);

  const ok = await runStopGate(setup([{ command: 'node -e "process.exit(0)"' }, { manual: 'screenshot reviewed' }]).opts);
  assert.equal(ok.outcome, 'pass');
  assert.deepEqual(ok.manual, ['screenshot reviewed']);
});

test('Stop gate blocks on a missing or invalid task file, and on a test check with no runner', async () => {
  const { opts } = setup([]);
  writeFileSync(opts.taskFile!, '{not json');
  assert.equal((await runStopGate(opts)).outcome, 'block');
  assert.equal((await runStopGate({ ...opts, taskFile: join(opts.cwd, 'missing.json') })).outcome, 'block');
  const noRunner = await runStopGate(setup([{ test: 'test/a.test.js' }]).opts);
  assert.equal(noRunner.outcome, 'block');
  assert.match(noRunner.reason, /runner\.one/);
});

test('Stop gate records sessions without a task instead of passing silently', async () => {
  const { opts } = setup([]);
  const r = await runStopGate({ ...opts, taskFile: undefined });
  assert.equal(r.outcome, 'no_task');
  assert.equal(records(opts.stateDir).at(-1)!.outcome, 'no_task');
});
