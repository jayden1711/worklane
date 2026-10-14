// Shutdown on SIGTERM: a coordinator in its own process (test/shutdown-child.ts), with a worker run that never
// returns unless aborted, is signaled as the service manager signals it on a restart or an update. It aborts the
// run, requeues the task, flushes its log, releases its lock and exits 0 well within SHUTDOWN_MS; a run that ignores
// the abort can't hold it past the limit, and the exit names what was still pending.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventLog } from '../src/events/log.js';
import { tryLock } from '../src/locks.js';
import { SHUTDOWN_MS } from '../src/service.js';

// Windows has no SIGTERM to deliver to a process: a kill there ends it outright.
const skip = process.platform === 'win32' && 'POSIX signals';
const child = fileURLToPath(new URL('./shutdown-child.js', import.meta.url));

/** Start the child, wait for its worker to be running, send SIGTERM, and time the exit (killed after capMs). */
async function signaled(mode: 'abortable' | 'stubborn', shutdownMs: number, capMs: number) {
  const base = mkdtempSync(join(tmpdir(), 'shutdown-'));
  const p = spawn(process.execPath, [child, base, mode, String(shutdownMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => p.on('exit', (code, signal) => res({ code, signal })));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`the worker never started:\n${err}`)), 60_000);
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('RUNNING')) {
        clearTimeout(t);
        res();
      }
    });
    void exited.then(() => rej(new Error(`the child exited before its worker started:\n${err}`)));
  });
  const at = Date.now();
  p.kill('SIGTERM');
  const cap = setTimeout(() => p.kill('SIGKILL'), capMs);
  const r = await exited;
  clearTimeout(cap);
  return { ...r, ms: Date.now() - at, err, stateDir: join(base, 'state') };
}

test('SIGTERM with a worker run in flight: the run is aborted, the task requeued, the log flushed, the lock released, exit 0 within the limit', { skip, timeout: 120_000 }, async () => {
  const r = await signaled('abortable', SHUTDOWN_MS, SHUTDOWN_MS + 10_000);
  assert.equal(r.signal, null, `it exited by itself, not killed after ${SHUTDOWN_MS + 10_000} ms:\n${r.err}`);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ms < SHUTDOWN_MS, `stopped in ${r.ms} ms`);
  // The state is flushed and readable afterwards.
  const log = new EventLog(join(r.stateDir, 'events.db'));
  try {
    const stopping = log.read(0, ['coordinator.stopping']);
    assert.equal(stopping.length, 1);
    assert.equal((stopping[0]!.payload as { signal: string }).signal, 'SIGTERM');
    assert.deepEqual((stopping[0]!.payload as { pending: string[] }).pending.filter((p) => p.startsWith('task')), ['task #1'], 'the task was in flight when the signal came');
    const stopped = log.read(0, ['coordinator.stopped']).map((e) => e.payload as { clean: boolean; pending: string[] });
    assert.deepEqual(stopped.map((s) => s.clean), [true]);
    const released = log.read(0, ['issue.released']).map((e) => e.payload as { issue: number; why: string });
    assert.equal(released.length, 1);
    assert.equal(released[0]!.issue, 1);
    assert.match(released[0]!.why, /^shutdown: .*requeued/);
    assert.equal(log.read(0, ['issue.blocked']).length, 0, 'never failed or blocked');
  } finally {
    log.close();
  }
  const issue = (JSON.parse(readFileSync(join(r.stateDir, 'backlog.json'), 'utf8')) as { issues: { number: number; labels: string[]; comments: { body: string }[] }[] }).issues[0]!;
  assert.ok(issue.labels.includes('ready') && !issue.labels.includes('agent:working'), `requeued: ${issue.labels.join(', ')}`);
  assert.match(issue.comments.at(-1)!.body, /requeued/);
  const lock = tryLock(join(r.stateDir, 'coordinator.lock'), 'test');
  assert.ok('lock' in lock, 'the coordinator lock is released');
  lock.lock.release();
});

test('a run that ignores the abort cannot hold the shutdown past its limit: exit 1, naming what was still pending', { skip, timeout: 120_000 }, async () => {
  const limit = 1_500;
  const r = await signaled('stubborn', limit, 15_000);
  assert.equal(r.signal, null, `it exited by itself:\n${r.err}`);
  assert.equal(r.code, 1);
  assert.ok(r.ms >= limit && r.ms < limit + 5_000, `exited after ${r.ms} ms`);
  assert.match(r.err, /shutdown: not stopped after \d+ s; exiting with still pending: .*task #1/);
  const log = new EventLog(join(r.stateDir, 'events.db'));
  try {
    const stopped = log.read(0, ['coordinator.stopped']).map((e) => e.payload as { clean: boolean; pending: string[] });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]!.clean, false);
    assert.ok(stopped[0]!.pending.includes('task #1'), stopped[0]!.pending.join(', '));
  } finally {
    log.close();
  }
  const lock = tryLock(join(r.stateDir, 'coordinator.lock'), 'test');
  assert.ok('lock' in lock, 'the coordinator lock is released');
  lock.lock.release();
});
