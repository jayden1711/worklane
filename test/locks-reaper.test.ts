// Deterministic reaper regression: real contenders, real file operations, no production-code changes.
// Only the first claim removal and A's stale-lock removal are paused, immediately before their real rmSync.
// These are the actual read/prove/remove windows in tryLock, not a substitute implementation of the protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLock } from '../src/locks.js';
import { nativeFlockInvocation, nativeFlockSupported, processIdentity, processPlace, UNKNOWN_IDENTITY } from '../src/os/index.js';
import { linkSlotFile, removeSlotFile, renameSlotFile, writeSlotFile } from '../src/slot-file.js';
import { tidyState } from '../src/state-tidy.js';

const CHILD = '--claim-reaper-child';
const OWNER = '--exited-lock-owner';
const DEADLINE_MS = 5000;
type Record = { pid: number; owner?: string; identity?: string | null };
type Message = { phase: string; pid: number; record: Record | null; acquired?: boolean; absent?: boolean };
const read = (path: string): Record | null => fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) as Record : null;
const claimPath = (path: string, text: string) => `${path}.${createHash('sha256').update(text).digest('hex').slice(0, 16)}.claim`;

function fixture(abandonedClaim: boolean) {
  const exitedOwner = () => {
    const child = spawnSync(process.execPath, ['--import', './dist/test/isolate.js', fileURLToPath(import.meta.url), OWNER], {
      encoding: 'utf8', timeout: DEADLINE_MS, killSignal: 'SIGKILL',
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    const owner = JSON.parse(child.stdout) as { pid: number; place: ReturnType<typeof processPlace>; identity: string };
    // Automatic stale takeover is currently Linux-only. Make unavailable identity an explicit fixture failure.
    assert.ok(owner.place.host && owner.place.boot && owner.place.pidns && owner.identity && owner.identity !== UNKNOWN_IDENTITY, 'known Linux place and identity required');
    assert.deepEqual(owner.place, processPlace(), 'fixture owners and contenders share the same process place');
    assert.equal(processIdentity(owner.pid), null, 'the fixture owner exited before any contender starts');
    return owner;
  };
  const deadLock = exitedOwner();
  const deadClaim = abandonedClaim ? exitedOwner() : null;
  const dir = fs.mkdtempSync(join(tmpdir(), 'lock-reaper-'));
  const path = join(dir, 'resource.lock');
  const text = JSON.stringify({ ...deadLock, owner: 'dead', acquiredAt: 'then' });
  fs.writeFileSync(path, text);
  const claim = claimPath(path, text);
  if (deadClaim) fs.writeFileSync(claim, JSON.stringify({ ...deadClaim, at: 0 }));
  return { dir, path, claim, deadClaim };
}

function childMain(path: string, role: string): void {
  const originalRm = fs.rmSync;
  const originalLink = fs.linkSync;
  const claim = claimPath(path, fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '');
  const deadLockPid = read(path)?.pid;
  const deadClaimPid = read(claim)?.pid;
  const emit = (phase: string, record: Record | null, more: Partial<Message> = {}) =>
    fs.writeSync(1, `${JSON.stringify({ phase, pid: process.pid, record, ...more })}\n`);
  const barrier = (phase: string, record: Record | null, more: Partial<Message> = {}) => {
    emit(phase, record, more);
    const byte = Buffer.alloc(1);
    assert.equal(fs.readSync(0, byte, 0, 1, null), 1, `controller closed at ${phase}`);
    assert.equal(byte[0], 1, 'one explicit release per barrier');
  };
  let reaped = false;
  let delayed = false;
  let returned = false;
  if (role === 'unrelated') {
    barrier('unrelated-ready', { pid: process.pid, identity: processIdentity(process.pid) });
    return;
  }
  fs.linkSync = (from, to) => {
    if (typeof to === 'string' && to.endsWith('.flock') && role === 'crash-before-guard') barrier('before-guard', read(path));
    if (to === path && role === 'crash-before-publish') barrier('before-publish', read(path));
    originalLink(from, to);
    if (typeof to === 'string' && to.endsWith('.flock') && role === 'crash-after-guard') barrier('after-guard', read(path));
    if (to === path && role === 'crash-after-publish') barrier('after-publish', read(path));
  };
  fs.rmSync = (file, options) => {
    if (role !== 'control' && file === claim && !reaped) {
      reaped = true;
      // Entered only after claimAbandoned returned true. Both contenders stop here on the original dead claim.
      const inspected = read(claim);
      assert.equal(inspected?.pid, deadClaimPid);
      barrier('reap-ready', inspected);
      const removed = read(claim);
      originalRm(file, options);
      if (role === 'crash-after-reap') barrier('after-reap', removed);
      else emit('reaped', removed, { absent: !fs.existsSync(claim) });
      return;
    }
    if (file === path && role === 'crash-after-remove') {
      const removed = read(path);
      originalRm(file, options);
      barrier('after-remove', removed);
      return;
    }
    if (file === path && role === 'crash-release' && returned) {
      originalRm(file, options);
      barrier('released-record', null);
      return;
    }
    if (role === 'A' && file === path && !delayed) {
      delayed = true;
      // tryLock has already compared readFileSafe(path) with its stale snapshot before calling rmSync.
      const inspected = read(path);
      assert.equal(inspected?.pid, deadLockPid);
      barrier('stale-remove-ready', inspected);
      const removed = read(path);
      originalRm(file, options);
      emit('stale-removed', removed);
      return;
    }
    originalRm(file, options);
  };
  syncBuiltinESMExports();
  try {
    const result = tryLock(path, role, role === 'control' ? {} : {
      taking: () => barrier('claim-published', read(claim)),
    });
    returned = true;
    // A successful result stays held until the parent explicitly releases this barrier or kills this child.
    barrier('result', read(path), { acquired: 'lock' in result });
    if ('lock' in result) result.lock.release();
  } finally {
    fs.rmSync = originalRm;
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }
}

function contender(path: string, role: string) {
  const child = spawn(process.execPath, ['--import', './dist/test/isolate.js', fileURLToPath(import.meta.url), CHILD, path, role], {
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL',
  });
  const messages: Message[] = [];
  const observers = new Set<() => void>();
  let output = '';
  let stderr = '';
  let failure: Error | null = null;
  let exited = false;
  const notify = () => { for (const observer of observers) observer(); };
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    output += text;
    try {
      assert.ok(output.length < 32768 && messages.length < 32, 'bounded child trace');
      let newline: number;
      while ((newline = output.indexOf('\n')) !== -1) {
        messages.push(JSON.parse(output.slice(0, newline)) as Message);
        output = output.slice(newline + 1);
      }
    } catch (e) { failure = e as Error; }
    notify();
  });
  child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-8192); });
  child.on('error', (e) => { failure = e; notify(); });
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => {
    exited = true;
    resolve(code);
    notify();
  }));
  const wait = (...phases: string[]) => new Promise<Message>((resolve, reject) => {
    const phase = phases.join(' or ');
    const timer = setTimeout(() => finish(new Error(`${role}: timed out at ${phase}; ${JSON.stringify(messages)}; ${stderr}`)), DEADLINE_MS);
    const finish = (error?: Error, message?: Message) => {
      clearTimeout(timer);
      observers.delete(check);
      if (error) reject(error);
      else resolve(message!);
    };
    const check = () => {
      const found = messages.find((message) => phases.includes(message.phase));
      if (failure) finish(failure);
      else if (found) finish(undefined, found);
      else if (exited) finish(new Error(`${role}: exited before ${phase}; ${stderr}`));
    };
    observers.add(check);
    check();
  });
  const resume = () => child.stdin.write(Buffer.from([1]));
  child.stdin.on('error', (e) => { failure = e; notify(); });
  const stop = async () => {
    if (!exited) child.kill('SIGKILL');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${role}: child cleanup timed out`)), DEADLINE_MS);
      })]);
    } finally { clearTimeout(timer); }
  };
  return { child, messages, wait, resume, stop, closed };
}

if (process.argv[2] === OWNER) {
  fs.writeSync(1, JSON.stringify({ pid: process.pid, place: processPlace(), identity: processIdentity(process.pid) }));
} else if (process.argv[2] === CHILD) {
  childMain(process.argv[3]!, process.argv[4]!);
} else {
  test('control: one contender recovers a stale lock, then releases its own record', { timeout: 20000 }, async () => {
    const f = fixture(false);
    const actor = contender(f.path, 'control');
    try {
      const result = await actor.wait('result');
      assert.equal(result.acquired, true);
      assert.equal(result.record?.owner, 'control');
      assert.equal(result.record?.pid, actor.child.pid);
      assert.equal(processIdentity(result.pid), result.record?.identity, 'the holder is live while paused');
      assert.equal(fs.existsSync(f.claim), false, 'normal takeover cleans up its claim');
      actor.resume();
      assert.equal(await actor.closed, 0);
      assert.equal(fs.existsSync(f.path), false, 'normal release removed the holder\'s lock');
    } finally {
      try { await actor.stop(); }
      finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }
  });

  test('regression: concurrent dead-claim reapers must preserve replacement claims and exclusive ownership', { timeout: 30000 }, async (t) => {
    const f = fixture(true);
    const a = contender(f.path, 'A');
    let b: ReturnType<typeof contender> | undefined;
    try {
      const aReady = await a.wait('reap-ready');
      b = contender(f.path, 'B');
      const bReady = await b.wait('reap-ready', 'result');
      assert.equal(aReady.record?.pid, f.deadClaim?.pid);
      assert.notEqual(a.child.pid, b.child.pid, 'distinct real contender processes');

      if (bReady.phase === 'result') {
        // The repaired protocol serializes before either stale inspection. B must finish busy, not wait at a barrier
        // inside a guard held by A. The old implementation instead reaches reap-ready below, exposing the race.
        assert.equal(bReady.acquired, false, 'B cannot acquire while A holds takeover authority');
        assert.equal(read(f.claim)?.pid, f.deadClaim?.pid, 'B leaves the inspected dead claim intact');
        a.resume();
        const published = await a.wait('claim-published');
        assert.equal(published.record?.pid, a.child.pid);
        assert.equal(processIdentity(published.pid), published.record?.identity);
        a.resume();
        await a.wait('stale-remove-ready');
        a.resume();
        const removed = await a.wait('stale-removed');
        assert.equal(removed.record?.owner, 'dead', 'A removed only the inspected dead lock');
        const result = await a.wait('result');
        assert.equal(result.acquired, true);
        assert.equal(read(f.path)?.pid, a.child.pid);
        assert.equal(fs.existsSync(f.claim), false);
        const c = contender(f.path, 'C');
        try {
          const busy = await c.wait('result');
          assert.equal(busy.acquired, false, 'a third contender cannot replace the live successor');
          assert.equal(read(f.path)?.pid, a.child.pid);
        } finally { await c.stop(); }
        t.diagnostic('serialized: B stayed busy; no replacement claim or live successor was deleted; only A acquired');
        return;
      }

      assert.equal(bReady.record?.pid, f.deadClaim?.pid, 'both pre-fix reapers inspected the same dead claim');

      a.resume();
      const aClaim = await a.wait('claim-published');
      assert.equal(aClaim.record?.pid, a.child.pid);
      assert.equal(processIdentity(aClaim.pid), aClaim.record?.identity, 'A is live, with a known start identity');

      b.resume();
      const deletedClaim = await b.wait('reaped');
      assert.equal(deletedClaim.record?.pid, a.child.pid, 'B targeted A\'s replacement, not the original dead claim');
      assert.equal(deletedClaim.absent, true);
      const bClaim = await b.wait('claim-published');
      assert.equal(bClaim.record?.pid, b.child.pid, 'both calls reached taking after publishing their own claim');

      a.resume();
      await a.wait('stale-remove-ready');
      b.resume();
      const bResult = await b.wait('result');
      assert.equal(bResult.acquired, true, 'B acquired a fresh lock while A was paused after its stale read');
      assert.equal(read(f.path)?.owner, 'B');

      a.resume();
      const deletedLock = await a.wait('stale-removed');
      assert.equal(deletedLock.record?.pid, b.child.pid, 'A removed B\'s fresh lock');
      const aResult = await a.wait('result');
      assert.equal(aResult.acquired, true);
      assert.equal(read(f.path)?.owner, 'A');
      assert.equal(processIdentity(bResult.pid), bResult.record?.identity, 'B is still live and has never released');
      assert.equal(processIdentity(aResult.pid), aResult.record?.identity, 'A is also live and has never released');

      const observed = { replacementClaimDeleted: deletedClaim.record?.pid === a.child.pid,
        successorLockDeleted: deletedLock.record?.pid === b.child.pid,
        unreleasedSuccessfulOwners: [aResult.record?.owner, bResult.record?.owner], finalOwner: read(f.path)?.owner };
      t.diagnostic(JSON.stringify({ observed, A: a.messages, B: b.messages }));
      // Intentionally red on the pending implementation. All schedule/proof assertions above must first pass.
      assert.deepEqual({ replacementClaimDeleted: observed.replacementClaimDeleted,
        successorLockDeleted: observed.successorLockDeleted, overlappingOwnership: aResult.acquired && bResult.acquired },
      { replacementClaimDeleted: false, successorLockDeleted: false, overlappingOwnership: false },
      'a reaper must not delete a live replacement or create overlapping ownership');
    } finally {
      try { await Promise.all([a.stop(), ...(b ? [b.stop()] : [])]); }
      finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }
  });

  test('native guards: supported local Linux filesystems only', () => {
    for (const type of [0xef53, 0x58465342, 0x9123683e, 0x01021994]) assert.equal(nativeFlockSupported(type, 'linux'), true);
    for (const type of [0x6969, 0xff534d42, 0xfe534d42, 0x65735546, 0x794c7630, 0]) assert.equal(nativeFlockSupported(type, 'linux'), false);
    for (const platform of ['darwin', 'win32'] as const) assert.equal(nativeFlockSupported(0xef53, platform), false);
  });

  test('native guards: either OS-adapter/helper import order initializes before acquisition', () => {
    const f = fixture(false);
    try {
      for (const first of ['os/index.js', 'slot-file.js']) {
        const script = `await import(${JSON.stringify(new URL('../src/' + first, import.meta.url).href)}); const {tryLock}=await import(${JSON.stringify(new URL('../src/locks.js', import.meta.url).href)}); const r=tryLock(process.argv[1], 'order'); if(!('lock' in r)) throw Error('busy'); r.lock.release();`;
        const child = spawnSync(process.execPath, ['--import', './dist/test/isolate.js', '--input-type=module', '-e', script, f.path], { encoding: 'utf8', timeout: DEADLINE_MS });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
      }
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('native guards: normal state privacy tidy changes permissions without changing the lock domain', () => {
    const f = fixture(false);
    const guard = join(f.dir, '.resource.lock.flock');
    const held = tryLock(f.path, 'tidy');
    assert.ok('lock' in held);
    try {
      const before = fs.statSync(guard);
      tidyState(f.dir);
      assert.equal(fs.statSync(guard).mode & 0o777, 0o660, 'existing state privacy policy still applies');
      assert.deepEqual([fs.statSync(guard).dev, fs.statSync(guard).ino], [before.dev, before.ino]);
      assert.ok(!('lock' in tryLock(f.path, 'contender')));
      held.lock.release();
      const again = tryLock(f.path, 'restart');
      assert.ok('lock' in again, 'normal startup tidy cannot strand future acquisition');
      again.lock.release();
    } finally { held.lock.release(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('native guards: a FIFO, symlink, directory or nonempty guard is refused without blocking', () => {
    for (const kind of ['fifo', 'symlink', 'directory', 'nonempty']) {
      const f = fixture(false);
      const guard = join(f.dir, '.resource.lock.flock');
      try {
        if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [guard], { timeout: DEADLINE_MS }).status, 0);
        else if (kind === 'symlink') fs.symlinkSync(f.path, guard);
        else if (kind === 'directory') fs.mkdirSync(guard);
        else fs.writeFileSync(guard, 'not a guard');
        const script = `const {tryLock}=await import(${JSON.stringify(new URL('../src/locks.js', import.meta.url).href)});try { tryLock(process.argv[1], 'refused'); process.exitCode=2; } catch(e) { console.log(e.code === 'ELOOP' ? 'symlink' : e.message); }`;
        const child = spawnSync(process.execPath, ['--import', './dist/test/isolate.js', '--input-type=module', '-e', script, f.path], { encoding: 'utf8', timeout: DEADLINE_MS });
        assert.equal(child.error, undefined, kind);
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /symlink|native lock guard must be an empty regular file/, kind);
        assert.equal(read(f.path)?.owner, 'dead', 'no refused guard permits JSON mutation');
      } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }
  });

  test('native guards: stable inode survives cleanup and replacement attempts, including umask 077', () => {
    const f = fixture(false);
    const guard = join(f.dir, '.resource.lock.flock');
    const other = join(f.dir, 'other');
    const mask = process.umask(0o077);
    let first: ReturnType<typeof tryLock> | undefined;
    try {
      first = tryLock(f.path, 'first');
      assert.ok('lock' in first);
      const initial = fs.statSync(guard);
      assert.equal(initial.mode & 0o777, 0o444, 'publication ignores the creator\'s restrictive umask');
      fs.writeFileSync(other, 'other');
      for (const mutate of [() => removeSlotFile(guard), () => writeSlotFile(guard, 'replace'),
        () => removeSlotFile(guard.toUpperCase()), () => writeSlotFile(guard.replace('.flock', '.floc\u212a'), 'replace'),
        () => removeSlotFile(guard.replace('.flock', '.flo\u200dck')),
        () => renameSlotFile(guard, other), () => renameSlotFile(other, guard),
        () => linkSlotFile(guard, other), () => linkSlotFile(other, guard)]) assert.throws(mutate, /native lock guards/);
      first.lock.release();
      first.lock.release();
      const second = tryLock(f.path, 'second');
      assert.ok('lock' in second);
      try {
        first.lock.release(); // An old handle must not close a descriptor number reused by the successor.
        assert.deepEqual([fs.statSync(guard).dev, fs.statSync(guard).ino], [initial.dev, initial.ino]);
        assert.ok(!('lock' in tryLock(f.path, 'third')), 'helper exit did not release the parent\'s flock');
        const independent = tryLock(other + '.lock', 'independent');
        assert.ok('lock' in independent, 'different resources in one directory remain independent');
        independent.lock.release();
      } finally { second.lock.release(); }
    } finally {
      if (first && 'lock' in first) first.lock.release();
      process.umask(mask);
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test('native guards: helper failure after acquiring the descriptor fails closed and closes the parent copy', (t) => {
    const f = fixture(false);
    const original = childProcess.spawnSync;
    let reached = false;
    t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof original>) => {
      const result = original(...args);
      const helper = nativeFlockInvocation(process.platform);
      if (args[0] !== helper.command || JSON.stringify(args[1]) !== JSON.stringify(helper.args)) return result;
      reached = true;
      assert.equal(result.status, 0, 'the real helper acquired the shared open description before the simulated failure');
      return { ...result, status: 42 };
    });
    syncBuiltinESMExports();
    try {
      try { assert.throws(() => tryLock(f.path, 'refused'), /helper failed/); }
      finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
      assert.equal(reached, true);
      assert.equal(read(f.path)?.owner, 'dead', 'the failed helper allowed no JSON mutation');
      const recovered = tryLock(f.path, 'recovered');
      assert.ok('lock' in recovered, 'the parent closed its copy even after the helper had locked it');
      recovered.lock.release();
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('native guards: default child stdio never inherits ownership', { timeout: 20000 }, async () => {
    const f = fixture(false);
    const held = tryLock(f.path, 'parent');
    assert.ok('lock' in held);
    const unrelated = contender(f.path, 'unrelated');
    let next: ReturnType<typeof contender> | undefined;
    try {
      await unrelated.wait('unrelated-ready');
      held.lock.release();
      next = contender(f.path, 'control');
      assert.equal((await next.wait('result')).acquired, true, 'a default child must not keep its parent\'s descriptor alive');
      assert.equal(unrelated.child.exitCode, null, 'the unrelated child is still alive');
    } finally {
      held.lock.release();
      try { await Promise.all([unrelated.stop(), ...(next ? [next.stop()] : [])]); }
      finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
    }
  });

  test('native guards: crashes at publication, reaping, takeover, ownership and release boundaries recover', { timeout: 60000 }, async (t) => {
    for (const [role, phase] of [
      ['crash-before-guard', 'before-guard'], ['crash-after-guard', 'after-guard'],
      ['crash-before-publish', 'before-publish'], ['crash-after-publish', 'after-publish'],
      ['crash-after-reap', 'after-reap'], ['crash-claim', 'claim-published'],
      ['crash-after-remove', 'after-remove'], ['control', 'result'], ['crash-release', 'released-record'],
    ]) {
      const f = fixture(role === 'crash-after-reap' || role === 'crash-claim');
      if (role === 'crash-before-publish' || role === 'crash-after-publish') fs.rmSync(f.path);
      const actor = contender(f.path, role!);
      let next: ReturnType<typeof contender> | undefined;
      try {
        if (role === 'crash-after-reap' || role === 'crash-claim') { await actor.wait('reap-ready'); actor.resume(); }
        if (role === 'crash-after-remove' || role === 'crash-release') {
          await actor.wait('claim-published'); actor.resume();
          if (role === 'crash-release') { await actor.wait('result'); actor.resume(); }
        }
        await actor.wait(phase!);
        if (phase === 'after-remove' || phase === 'released-record') {
          const probe = contender(f.path, 'control');
          try { assert.equal((await probe.wait('result')).acquired, false, 'missing JSON does not release native ownership'); }
          finally { await probe.stop(); }
        }
        await actor.stop();
        next = contender(f.path, 'control');
        const recovered = await next.wait('result');
        assert.equal(recovered.acquired, true, role);
        assert.equal(recovered.record?.pid, next.child.pid, role);
        next.resume();
        assert.equal(await next.closed, 0, role);
        t.diagnostic(`recovered after ${phase}`);
      } finally {
        try { await Promise.all([actor.stop(), ...(next ? [next.stop()] : [])]); }
        finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
      }
    }
  });
}
