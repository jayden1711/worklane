// A private guard must not become stdin/stdout/stderr when a caller closed one of those descriptors.
// All stream mutations happen in bounded scratch subprocesses; the test runner keeps its own streams.
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLock } from '../src/locks.js';
import { processIdentity, UNKNOWN_IDENTITY } from '../src/os/index.js';

const CHILD = '--stdio-guard-child';
const DEADLINE = 10000;
type Observation = { closed: number[]; refused: boolean; initialHelperCalls: number; holesRestored: boolean; otherStdioUntouched: boolean; jsonUntouched: boolean; guardInStdio: boolean; acquiredWhileChildAlive: boolean; acquiredAfterChildExit: boolean };

async function probe(path: string, closed: number[]): Promise<Observation> {
  const originalStdio = [0, 1, 2].map((fd) => fstatSync(fd));
  let initialHelperCalls = 0;
  const originals = { spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync };
  for (const key of ['spawnSync', 'execFileSync'] as const) {
    Object.defineProperty(childProcess, key, { value: (...args: unknown[]) => { initialHelperCalls++; return Reflect.apply(originals[key], childProcess, args); } });
  }
  syncBuiltinESMExports();
  for (const fd of closed) closeSync(fd);
  let refused = false;
  let held: ReturnType<typeof tryLock> | undefined;
  try { held = tryLock(path, 'closed stdio'); }
  catch (error) { assert.match((error as Error).message, /open standard descriptors/); refused = true; }
  finally {
    for (const key of ['spawnSync', 'execFileSync'] as const) Object.defineProperty(childProcess, key, { value: originals[key] });
    syncBuiltinESMExports();
  }
  const jsonUntouched = !existsSync(path);
  const guard = statSync(join(dirname(path), '.resource.lock.flock'));
  const guardInStdio = closed.some((fd) => {
    try { const s = fstatSync(fd); return s.dev === guard.dev && s.ino === guard.ino; }
    catch { return false; }
  });
  const holesRestored = closed.every((fd) => {
    try { fstatSync(fd); return false; }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'EBADF'); return true; }
  });
  const otherStdioUntouched = [0, 1, 2].filter((fd) => !closed.includes(fd)).every((fd) => {
    const s = fstatSync(fd); return s.dev === originalStdio[fd]!.dev && s.ino === originalStdio[fd]!.ino;
  });
  // Restore the caller's holes for Node/libuv before any subprocess spawning. On the old implementation an
  // occupied guard descriptor is deliberately left alone, so the original inheritance failure remains observable.
  for (const fd of closed) {
    try { fstatSync(fd); }
    catch { assert.equal(openSync('/dev/null', 'r+'), fd); }
  }
  held ??= tryLock(path, 'restored stdio');
  assert.ok('lock' in held);
  const child = spawn(process.execPath, ['-e', 'process.on("disconnect",()=>process.exit(0)); process.send("ready"); setInterval(()=>{},1000); setTimeout(()=>process.exit(3),8000).unref();'], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  let acquiredWhileChildAlive = false;
  try {
    const [ready] = await once(child, 'message');
    assert.equal(ready, 'ready');
    assert.equal(child.exitCode, null);
    const identity = processIdentity(child.pid!);
    assert.ok(identity && identity !== UNKNOWN_IDENTITY);
    held.lock.release();
    const next = tryLock(path, 'after release');
    acquiredWhileChildAlive = 'lock' in next;
    if ('lock' in next) next.lock.release();
    assert.equal(child.exitCode, null, 'inheriting child remains alive throughout the release probe');
    assert.equal(processIdentity(child.pid!), identity, 'the same inheriting process is still alive');
  } finally {
    child.kill('SIGKILL');
    await exited;
    held.lock.release();
  }
  const recovered = tryLock(path, 'after child exit');
  const acquiredAfterChildExit = 'lock' in recovered;
  if ('lock' in recovered) recovered.lock.release();
  return { closed, refused, initialHelperCalls, holesRestored, otherStdioUntouched, jsonUntouched, guardInStdio, acquiredWhileChildAlive, acquiredAfterChildExit };
}

if (process.argv[2] === CHILD) {
  const timer = setTimeout(() => process.exit(2), DEADLINE);
  try {
    process.send!(await probe(process.argv[3]!, JSON.parse(process.argv[4]!)));
  } finally { clearTimeout(timer); process.disconnect!(); }
} else {
  const { test } = await import('node:test');
  test('regression: inherited stdio cannot retain a resource guard after release', { timeout: 60000 }, async () => {
    if (!['linux', 'darwin'].includes(process.platform)) {
      const dir = mkdtempSync(join(tmpdir(), 'guard-stdio-'));
      try { assert.throws(() => tryLock(join(dir, 'resource.lock'), 'unsupported'), /supported/); }
      finally { rmSync(dir, { recursive: true, force: true }); }
      return;
    }
    for (const closed of [[0], [1], [2], [0, 1, 2]]) {
      const dir = mkdtempSync(join(tmpdir(), 'guard-stdio-'));
      const child = spawn(process.execPath, ['--import', './dist/test/isolate.js', fileURLToPath(import.meta.url), CHILD, join(dir, 'resource.lock'), JSON.stringify(closed)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr!.on('data', (data) => { stderr += data; });
      let observed: Observation | undefined;
      child.on('message', (message) => { observed = message as Observation; });
      const timer = setTimeout(() => child.kill('SIGKILL'), DEADLINE + 2000);
      try {
        const [status] = await once(child, 'close');
        assert.equal(status, 0, stderr);
        assert.deepEqual(observed, { closed, refused: true, initialHelperCalls: 0, holesRestored: true, otherStdioUntouched: true, jsonUntouched: true, guardInStdio: false, acquiredWhileChildAlive: true, acquiredAfterChildExit: true });
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}
