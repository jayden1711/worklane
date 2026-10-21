// Issue #726, principle 2 (the owner's): turning auto_merge OFF can never be blocked or undone. Root's kill switch
// (src/policy-kill.ts) against an admin's `set on` racing it, a crash part way, a full filesystem and a rename.
// Stand-ins only, as in test/policy-edit.test.ts: "root" is this test's own uid; no test runs as root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from './script-child-process.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { processIdentity } from '../src/os/index.js';
import { policyRootChecks } from '../src/doctor-policy-root.js';
import * as osAdapter from '../src/os/index.js';
import { autoMergeKilled, idDir, instanceId, POLICY_ROOT_DIR } from '../src/policy-kill.js';
import * as killModule from '../src/policy-kill.js';
import { ownPolicy, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';
import { repoRoot } from './helpers.js';
import { onRealMachine } from './isolate.js';

const skip = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc)';
const me = process.platform === 'win32' ? 0 : process.getuid!();
const POLICY = 'version: 1\nbudget: { daily_usd: 50 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: false\n';
const lib = join(repoRoot, 'scripts', 'setup', 'lib.sh');
// Round 9's id API, read from the module so that a build without it fails each test at its own assertion.
const kill = killModule as unknown as {
  instanceId?: (n: string, d?: string) => null | { id: string } | { problem: string };
  idDir?: (id: string, d?: string) => string;
  aliasInstance?: (from: string, to: string, d?: string) => string;
  sharedWith?: (n: string, d?: string) => string[];
  sweepOrphanIds?: (d?: string) => void;
};
/** The directory an instance's switches live in (round 9: by its id), or '' when it has none. */
function switchDir(name: string, dir = POLICY_ROOT_DIR): string {
  assert.equal(typeof kill.instanceId, 'function', 'switches keyed by an instance id (src/policy-kill.ts instanceId)');
  const p = kill.instanceId!(name, dir);
  return p && 'id' in p ? kill.idDir!(p.id, dir) : '';
}

function machineInstance(name: string) {
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'policy-kill-')));
  const home = join(T, 'home', `wl-${name}`);
  const dir = join(home, '.local', 'state', BRAND.cli, 'instances', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.yaml'), POLICY, { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === `wl-${name}` ? home : null), uid: () => me, rootUid: me, rootGid: process.getgid!(), limitsPath: join(T, 'limits.json') };
  return { T, home, dir, deps };
}
const childArgs = (name: string, m: ReturnType<typeof machineInstance>, more: Record<string, unknown> = {}) =>
  JSON.stringify({ module: pathToFileURL(join(repoRoot, 'dist', 'src', 'policy-root.js')).href, name, home: m.home, uid: me, gid: process.getgid!(), markers: POLICY_ROOT_DIR, limits: join(m.T, 'limits.json'), ...more });
const depsLine = 'const d = { home: () => a.home, uid: () => a.uid, rootUid: a.uid, rootGid: a.gid, markerDir: a.markers, limitsPath: a.limits, ...(a.lockWaitMs ? { lockWaitMs: a.lockWaitMs } : {}) };';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** node:fs's renameSync and unlinkSync wrapped with `after(name, args)`, put back by the returned function. */
function hookFs(after: (fn: string, args: unknown[]) => void): () => void {
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const orig = { renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
  for (const n of ['renameSync', 'unlinkSync'] as const) {
    fs[n] = (...args: unknown[]) => {
      const r = (orig[n] as (...a: unknown[]) => unknown)(...args);
      after(n, args);
      return r;
    };
  }
  syncBuiltinESMExports();
  return () => {
    fs.renameSync = orig.renameSync;
    fs.unlinkSync = orig.unlinkSync;
    syncBuiltinESMExports();
  };
}

test("an OFF that said done while an admin's `set on` runs is never undone, not even for a moment: the engine reads off after every step ON takes (#726 round 5)", { skip }, () => {
  const name = 'window';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  setPolicy(name, 'auto_merge', 'off', null, m.deps); // an earlier OFF, which ON means to clear
  let offDone = false;
  const after: boolean[] = [];
  const unhook = hookFs((fn, args) => {
    if (offDone) after.push(autoMergeKilled(name));
    else if (fn === 'renameSync' && args[1] === 'policy.yaml') {
      // The OFF lands as ON puts its policy.yaml in place: after ON started, before it clears anything.
      setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps);
      offDone = true;
    }
  });
  try {
    setPolicy(name, 'auto_merge', 'on', null, m.deps);
  } finally {
    unhook();
  }
  assert.ok(offDone);
  assert.ok(after.length > 0, 'ON took steps after the OFF');
  assert.deepEqual(after.filter((k) => !k), [], 'never a moment the engine read auto_merge on after the OFF said done');
  assert.equal(autoMergeKilled(name), true);
});

test("an admin's `set on` killed part way through clearing (SIGKILL) never leaves an OFF that said done undone (#726 round 5)", { skip }, () => {
  const name = 'crash';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  setPolicy(name, 'auto_merge', 'off', null, m.deps); // an earlier OFF, which ON means to clear
  const child = join(m.T, 'on-crash.mjs');
  writeFileSync(child, `import { createRequire, syncBuiltinESMExports } from 'node:module';
const a = JSON.parse(process.argv[2]);
${depsLine}
const fs = createRequire(import.meta.url)('node:fs');
const { setPolicy } = await import(a.module);
const orig = { renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
let offDone = false;
// After OFF has said done: killed at ON's first step on a switch, right after it, whether it worked or not.
for (const n of ['renameSync', 'unlinkSync']) fs[n] = (...args) => {
  const clearing = offDone && String(args[0]).includes('auto-merge-off');
  try {
    const r = orig[n](...args);
    if (!offDone && n === 'renameSync' && args[1] === 'policy.yaml') { setPolicy(a.name, 'auto_merge', 'off', 'wl-' + a.name, d); offDone = true; }
    return r;
  } finally {
    if (clearing) process.kill(process.pid, 'SIGKILL');
  }
};
syncBuiltinESMExports();
setPolicy(a.name, 'auto_merge', 'on', null, d);
`);
  const r = spawnSync(process.execPath, [child, childArgs(name, m)], { encoding: 'utf8' });
  assert.equal(r.signal, 'SIGKILL', `ON was killed mid-clear: ${r.stderr}`);
  assert.equal(autoMergeKilled(name), true, 'the OFF that said done stays');
});

test('an OFF that said done while an admin\'s `set on` waited for root\'s lock is never cleared when ON goes on (#726 round 5)', { skip }, async () => {
  const name = 'onwait';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  // A live writer holds root's lock, so ON waits for it.
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  onRealMachine(POLICY_ROOT_DIR); // throws unless it is inside this test's system root: never the machine's own (#815)
  writeFileSync(join(POLICY_ROOT_DIR, `.${name}.lock`), `${holder.pid} ${processIdentity(holder.pid!)}\n`);
  const child = join(m.T, 'on-wait.mjs');
  const started = join(m.T, 'started');
  writeFileSync(child, `import { writeFileSync } from 'node:fs';
const a = JSON.parse(process.argv[2]);
${depsLine}
const { setPolicy } = await import(a.module);
writeFileSync(a.started, '');
setPolicy(a.name, 'auto_merge', 'on', null, d);
`);
  const on = spawn(process.execPath, [child, childArgs(name, m, { lockWaitMs: 30_000, started })], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  on.stderr.on('data', (b: Buffer) => (err += b.toString()));
  const exited = new Promise<number | null>((res) => on.on('exit', (code) => res(code)));
  try {
    for (let i = 0; i < 300 && !existsSync(started); i++) await delay(20);
    await delay(300); // ON is past its start and waiting for the lock
    assert.deepEqual(setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps), { key: 'auto_merge', from: null, to: false });
    assert.equal(autoMergeKilled(name), true, 'OFF said done');
  } finally {
    holder.kill('SIGKILL'); // the holder goes: ON gets the lock and goes on
  }
  assert.equal(await exited, 0, err);
  assert.equal(autoMergeKilled(name), true, 'ON never cleared the OFF that landed while it waited');
});

test('auto_merge off needs no new space: with every create in root\'s directory failing (ENOSPC, EDQUOT stand-ins) OFF still arms a switch, and the engine reads off (#726 round 5)', { skip }, () => {
  for (const code of ['ENOSPC', 'EDQUOT']) {
    const name = `full-${code.toLowerCase()}`;
    const m = machineInstance(name);
    ownPolicy(name, m.deps);
    setPolicy(name, 'budget.daily_usd', '40', null, m.deps);
    const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
    const orig = { writeFileSync: fs.writeFileSync, openSync: fs.openSync, mkdirSync: fs.mkdirSync };
    const full = () => Object.assign(new Error(`${code}: no space left on device`), { code });
    const creates = (flag: unknown) => typeof flag === 'string' ? /[wa]/.test(flag) : typeof flag === 'number' && (flag & 0o100) !== 0;
    fs.writeFileSync = (p: unknown, ...r: unknown[]) => {
      if (String(p).startsWith(POLICY_ROOT_DIR)) throw full();
      return (orig.writeFileSync as (...a: unknown[]) => unknown)(p, ...r);
    };
    fs.openSync = (p: unknown, flag?: unknown, ...r: unknown[]) => {
      if (String(p).startsWith(POLICY_ROOT_DIR) && creates(flag)) throw full();
      return (orig.openSync as (...a: unknown[]) => unknown)(p, flag, ...r);
    };
    syncBuiltinESMExports();
    try {
      assert.deepEqual(setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps), { key: 'auto_merge', from: null, to: false }, code);
    } finally {
      Object.assign(fs, orig);
      syncBuiltinESMExports();
    }
    assert.equal(autoMergeKilled(name), true, `${code}: the engine reads off`);
  }
});

test("`set on` on a full filesystem is refused before it changes anything (it needs room for the next OFF's spare), so auto_merge stays off; after a `set on` that went through, OFF needs no space (#726 round 5 adversarial pass)", { skip }, () => {
  const name = 'fullon';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const orig = { writeFileSync: fs.writeFileSync, openSync: fs.openSync };
  const full = (on: boolean) => {
    if (!on) return Object.assign(fs, orig), syncBuiltinESMExports();
    const err = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    fs.writeFileSync = (p: unknown, ...r: unknown[]) => {
      if (String(p).startsWith(POLICY_ROOT_DIR)) throw err();
      return (orig.writeFileSync as (...a: unknown[]) => unknown)(p, ...r);
    };
    fs.openSync = (p: unknown, flag?: unknown, ...r: unknown[]) => {
      if (String(p).startsWith(POLICY_ROOT_DIR) && (typeof flag === 'string' ? /[wa]/.test(flag) : typeof flag === 'number' && (flag & 0o100) !== 0)) throw err();
      return (orig.openSync as (...a: unknown[]) => unknown)(p, flag, ...r);
    };
    syncBuiltinESMExports();
  };
  full(true);
  try {
    // OFF on the full filesystem arms the spare, and has no room for another.
    setPolicy(name, 'auto_merge', 'off', null, m.deps);
    assert.equal(existsSync(join(switchDir(name), 'auto-merge-spare')), false, 'no spare left');
    assert.throws(() => setPolicy(name, 'auto_merge', 'on', null, m.deps), /ENOSPC/);
  } finally {
    full(false);
  }
  assert.equal(autoMergeKilled(name), true, 'refused: still off');
  setPolicy(name, 'auto_merge', 'on', null, m.deps); // room again: ON goes through, and leaves a spare
  assert.equal(autoMergeKilled(name), false);
  full(true);
  try {
    setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps);
  } finally {
    full(false);
  }
  assert.equal(autoMergeKilled(name), true, 'OFF on a full filesystem after ON');
});

// Sequential only; many at once: "many OFFs at once (12 processes)" below. (Through 10ca8a1d this title claimed
// "never add files" for any repetition; concurrent OFFs did add files then.)
test('auto_merge OFFs one after another (a coordinator looping the helper\'s set-policy) add no files to root\'s directory: one switch, moved to each new name, and the spare (#726 round 5 adversarial pass)', { skip }, () => {
  const name = 'loop';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  const files = () => readdirSync(POLICY_ROOT_DIR).filter((f) => f.startsWith(`${name}.`)).length + readdirSync(switchDir(name)).length;
  setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps);
  const after1 = files();
  for (let i = 0; i < 50; i++) setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps);
  assert.equal(files(), after1, 'no new file per OFF');
  assert.equal(autoMergeKilled(name), true);
});

/** A full filesystem in root's directory, stood in: every create there fails `code` (rename and unlink still work). */
function fullDisk(code = 'ENOSPC'): () => void {
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const orig = { writeFileSync: fs.writeFileSync, openSync: fs.openSync, mkdirSync: fs.mkdirSync, linkSync: fs.linkSync };
  const err = () => Object.assign(new Error(`${code}: no space left on device`), { code });
  fs.writeFileSync = (p: unknown, ...r: unknown[]) => {
    if (String(p).includes('/policy-root')) throw err();
    return (orig.writeFileSync as (...a: unknown[]) => unknown)(p, ...r);
  };
  fs.openSync = (p: unknown, flag?: unknown, ...r: unknown[]) => {
    if (String(p).includes('/policy-root') && (typeof flag === 'string' ? /[wa]/.test(flag) : typeof flag === 'number' && (flag & 0o100) !== 0)) throw err();
    return (orig.openSync as (...a: unknown[]) => unknown)(p, flag, ...r);
  };
  fs.mkdirSync = (p: unknown, ...r: unknown[]) => {
    if (String(p).includes('/policy-root/') && !existsSync(String(p))) throw err();
    return (orig.mkdirSync as (...a: unknown[]) => unknown)(p, ...r);
  };
  syncBuiltinESMExports();
  return () => {
    Object.assign(fs, orig);
    syncBuiltinESMExports();
  };
}

test('many OFFs at once (12 processes) never add files, never report a failure, and leave auto_merge off (#726 round 6)', { skip }, async () => {
  const name = 'many';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  setPolicy(name, 'auto_merge', 'off', null, m.deps);
  const files = () => readdirSync(POLICY_ROOT_DIR).filter((f) => f.startsWith(`${name}.`)).length + readdirSync(switchDir(name)).length;
  const before = files();
  const child = join(m.T, 'off-loop.mjs');
  writeFileSync(child, `const a = JSON.parse(process.argv[2]);
${depsLine}
const { setPolicy } = await import(a.module);
let failed = 0; const why = [];
for (let i = 0; i < a.n; i++) { try { setPolicy(a.name, 'auto_merge', 'off', 'wl-' + a.name, d); } catch (e) { failed++; if (why.length < 3) why.push(e.message); } }
console.log(JSON.stringify({ failed, why }));
`);
  const runs = Array.from({ length: 12 }, () => new Promise<{ code: number | null; out: string }>((res) => {
    const c = spawn(process.execPath, [child, childArgs(name, m, { n: 300 })], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (b: Buffer) => (out += b.toString()));
    c.on('exit', (code) => res({ code, out }));
  }));
  const results = await Promise.all(runs);
  const failures = results.map((r) => JSON.parse(r.out.trim().split('\n').pop() || '{"failed":-1}') as { failed: number; why: string[] });
  assert.deepEqual(results.map((r) => r.code), Array(12).fill(0));
  assert.deepEqual(failures.filter((f) => f.failed !== 0), [], 'no OFF reported a failure');
  assert.equal(files(), before, 'no file added');
  assert.equal(autoMergeKilled(name), true);
});

test('an OFF that loses a race to another OFF is done, not failed: its switch moved on before its fsync, or the spare taken on a full filesystem (#726 round 6)', { skip }, () => {
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const rename = fs.renameSync as (a: string, b: string) => void;
  // (1) Another OFF moves this OFF's switch on, between its rename and its fsync.
  {
    const name = 'race-fsync';
    const m = machineInstance(name);
    ownPolicy(name, m.deps);
    const d = switchDir(name);
    let nested = false;
    fs.renameSync = (a: string, b: string) => {
      rename(a, b);
      if (!nested && String(b).startsWith(join(d, 'auto-merge-off.'))) {
        nested = true;
        setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps);
      }
    };
    syncBuiltinESMExports();
    try {
      assert.deepEqual(setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps), { key: 'auto_merge', from: null, to: false });
    } finally {
      fs.renameSync = rename;
      syncBuiltinESMExports();
    }
    assert.ok(nested);
    assert.equal(autoMergeKilled(name), true);
  }
  // (2) Full filesystem, no switch, one spare: another OFF takes the spare first.
  {
    const name = 'race-spare';
    const m = machineInstance(name);
    ownPolicy(name, m.deps);
    const d = switchDir(name);
    let nested = false;
    fs.renameSync = (a: string, b: string) => {
      if (!nested && String(a) === join(d, 'auto-merge-spare')) {
        nested = true;
        setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps); // takes the spare
      }
      rename(a, b);
    };
    syncBuiltinESMExports();
    const restore = fullDisk();
    try {
      assert.deepEqual(setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps), { key: 'auto_merge', from: null, to: false });
    } finally {
      restore();
      fs.renameSync = rename;
      syncBuiltinESMExports();
    }
    assert.ok(nested);
    assert.equal(autoMergeKilled(name), true);
  }
});

test("a temp file a root writer left (killed before its rename) is swept on root's next write there; a stalled writer's never is (#726 rounds 6 and 7)", { skip }, () => {
  const name = 'sweep';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  const p = instanceId(name);
  assert.ok(p && 'id' in p);
  const d = idDir(p.id);
  onRealMachine(d); // throws unless it is inside this test's system root (#815)
  // A file's mtime set to a wall time some while ago (not a duration).
  const tenMinutesAgo = new Date(Date.now() - 600_000);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
  const age = (p: string, t: Date) => utimesSync(p, t, t);
  // A writer that is gone (a process that ran and exited): its temp file goes at once.
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout.trim());
  assert.ok(deadPid > 0);
  const killed = join(d, `.${deadPid}-0123456789ab.auto-merge.tmp`);
  writeFileSync(killed, 'auto_merge off since then\n');
  // A writer still alive (this process), stalled ten minutes between its write and its rename: kept.
  const stalled = join(d, `.${process.pid}-ba9876543210.auto-merge.tmp`);
  writeFileSync(stalled, '');
  age(stalled, tenMinutesAgo);
  // A name with no pid (round 6's), ten minutes old: kept (its writer can't be told gone); two days old: gone.
  const noPid = join(d, '.00112233aabb.auto-merge.tmp');
  writeFileSync(noPid, '');
  age(noPid, tenMinutesAgo);
  const ancient = join(d, `.${process.pid}-ccddeeff0011.auto-merge.tmp`);
  writeFileSync(ancient, '');
  age(ancient, twoDaysAgo);
  setPolicy(name, 'auto_merge', 'off', null, m.deps);
  assert.equal(existsSync(killed), false, "a gone writer's is swept");
  assert.equal(existsSync(stalled), true, "a live writer's, stalled, is kept (through ae00a348 a minute old was swept)");
  assert.equal(existsSync(noPid), true, 'one with no pid is kept until a day old');
  assert.equal(existsSync(ancient), false, 'anything a day old is swept');
});

/** A stand-in directory for root's records, with lib.sh's own functions to run against it. */
function recordsDir(tag: string) {
  const T = join(realpathSync(mkdtempSync(join(tmpdir(), `kill-${tag}-`))), 'policy-root');
  mkdirSync(T, { mode: 0o755 });
  const run = (script: string) => spawnSync('bash', ['-c', `source "$1"; POLICY_ROOT_DIR="$2"; own_policy() { :; }; ${script}`, '_', lib, T], { encoding: 'utf8' });
  return { T, run };
}
/** setPolicy's OFF on a full filesystem (every create in root's directory failing): 'done', or the error. */
function offOnFullDisk(name: string, deps: PolicyRootDeps): 'done' | Error {
  const restore = fullDisk();
  try {
    setPolicy(name, 'auto_merge', 'off', null, deps);
    return 'done';
  } catch (e) {
    return e as Error;
  } finally {
    restore();
  }
}
const scriptText = (name: string) => readFileSync(join(repoRoot, 'scripts', 'setup', name), 'utf8');

test("a rename shares the instance's id from its start, so an OFF given to either name at any step, inside the old name's removal included, turns both off with no new space, and nothing is ever carried, forwarded or moved (#726 round 9, the owner's id design)", { skip }, () => {
  assert.equal(typeof kill.aliasInstance, 'function', 'aliasInstance');
  const steps = ['park', 'export', 'users', 'home', 'checkout', 'import', 'records', 'services', 'keep', 'remove: users there', 'remove: users gone, pointer there'];
  for (const [i, step] of steps.entries()) {
    for (const given of ['old', 'new'] as const) {
      const { T } = recordsDir(`alias${i}${given}`);
      const [o, n] = [`ao${i}`, `an${i}`];
      const usersGone = step.includes('users gone');
      const deps: PolicyRootDeps = { presence: (u) => (usersGone && u === `wl-${o}` ? 'absent' : 'exists'), markerDir: T };
      // The rename's start (instance_alias): the old name's id (made, with its spare, here), the new name pointing at it.
      kill.aliasInstance!(o, n, T);
      assert.equal(switchDir(o, T), switchDir(n, T), `${step}: one id`);
      assert.equal(autoMergeKilled(n, T), false, `${step}: on before the OFF`);
      assert.equal(offOnFullDisk(given === 'old' ? o : n, deps), 'done', `${step}, OFF on the ${given} name`);
      assert.equal(autoMergeKilled(o, T), true, `${step}: the old name off`);
      assert.equal(autoMergeKilled(n, T), true, `${step}: the new name off`);
    }
  }
  // Once the old name's removal took its pointer (after its users): nothing names it, and saying so is the truth.
  const { T } = recordsDir('alias-gone');
  kill.aliasInstance!('ago', 'agn', T);
  unlinkSync(join(T, 'ago.id'));
  assert.throws(() => setPolicy('ago', 'auto_merge', 'off', null, { presence: () => 'absent', markerDir: T }), /no instance ago/);
  assert.equal(offOnFullDisk('agn', { presence: () => 'exists', markerDir: T }), 'done');
  // The scripts: the alias at the rename's start (not again once its remove step is done), and no carry, forward or
  // move anywhere; --abort drops the new name's pointer with the new name, or itself when it has no user yet.
  const rename = scriptText('instance-rename.sh');
  assert.match(rename, /\ndone_step remove \|\| instance_alias "\$old" "\$new"\nstep_failed\(\)/);
  for (const gone of ['rename_forward', 'carry_auto_merge_off', 'move_auto_merge_off', 'instance_can_run', 'forward_records_of', '.rename-to']) {
    assert.equal(rename.includes(gone) || scriptText('lib.sh').includes(gone) || scriptText('instance-remove.sh').includes(gone), false, `${gone} is gone`);
  }
  assert.match(rename, /instance-remove\.sh" "\$new" --yes[^\n]*\n {2}# [^\n]*\n {2}else rm -f -- "\$POLICY_ROOT_DIR\/\$new\.id"; fi\n/);
});

test("--abort, and a removal of either name: the old name keeps every OFF given during the rename; a new name still running keeps its pointer (its removal refused), and a taken-over name without one reads off (#726 round 9)", { skip }, () => {
  const { T, run } = recordsDir('abort');
  kill.aliasInstance!('abo', 'abn', T);
  assert.equal(setPolicy('abn', 'auto_merge', 'off', null, { presence: () => 'exists', markerDir: T }).to, false);
  // The new name's removal refused (it runs): its pointer stays, so it reads the shared switches.
  assert.equal(autoMergeKilled('abn', T), true);
  // A taken-over new name (its record carried at home) whose pointer went: off, fail closed.
  writeFileSync(join(T, 'abn'), '{}\n');
  unlinkSync(join(T, 'abn.id'));
  assert.equal(autoMergeKilled('abn', T), true, 'recorded, no pointer: off');
  // The abort done: the old name has the OFF, and its id's switches stay while it points at them.
  assert.equal(autoMergeKilled('abo', T), true);
  const id = (kill.instanceId!('abo', T) as { id: string }).id;
  assert.equal(run(`id_in_use ${id}`).status, 0);
  assert.equal(run(`instance_id_of abo`).stdout.trim(), id);
  unlinkSync(join(T, 'abo.id'));
  assert.notEqual(run(`id_in_use ${id}`).status, 0, 'no name points at it once the last pointer goes');
  // instance-remove.sh: its id read before its items, its switches gone at the end only when no name points at them.
  const remove = scriptText('instance-remove.sh');
  const readAt = remove.indexOf('rm_id="$(instance_id_of "$name")"');
  const loopAt = remove.indexOf('for line in "${ITEMS[@]}"; do\n  IFS=$\'\\t\' read -r k w when _');
  const dropAt = remove.indexOf('if [ -n "$rm_id" ] && ! id_in_use "$rm_id"');
  assert.ok(readAt > 0 && loopAt > readAt && dropAt > loopAt, `order: read ${readAt}, items ${loopAt}, drop ${dropAt}`);
  // The registry: the pointer after the instance's coordinator user, so while that user is there an OFF finds it.
  const items = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'setup', 'instance-records.cjs'), 'items', 'zed'], { encoding: 'utf8' }).stdout.split('\n');
  const user = items.findIndex((l) => l.startsWith('user\twl-zed\t'));
  const ptr = items.findIndex((l) => l.startsWith('path\t') && l.includes('policy-root/zed.id'));
  assert.ok(user >= 0 && ptr > user, `the pointer comes after wl-zed (${user}, ${ptr})`);
});

test("root's id pointer can't be turned against OFF: one that is no plain file, holds no id, can't be read or names a missing directory reads off; OFF there fails visibly; `set on` refuses while another name shares the id; doctor says each (#726 round 9)", { skip }, () => {
  assert.equal(typeof kill.instanceId, 'function');
  const bad: [string, (T: string) => void][] = [
    ['garbled', (T) => writeFileSync(join(T, 'pt.id'), '../etc\n')],
    ['a link', (T) => symlinkSync(join(T, 'elsewhere'), join(T, 'pt.id'))],
    ['a directory', (T) => mkdirSync(join(T, 'pt.id'))],
    ['an id whose directory is missing', (T) => writeFileSync(join(T, 'pt.id'), 'ffffffffffffffffffffffffffffffff\n')],
  ];
  for (const [what, make] of bad) {
    const { T } = recordsDir('ptr');
    make(T);
    assert.equal(autoMergeKilled('pt', T), true, `${what}: off`);
    if (what !== 'an id whose directory is missing') {
      // Round 11: the message says what is true there: it reads off already, and --retake is the fix (it was
      // "couldn't be armed ... can still merge on its own", which was false for a pointer that reads off).
      const r = offOnFullDisk('pt', { presence: () => 'exists', markerDir: T });
      assert.ok(r instanceof Error && /pt\.id can't be used .*pt's auto_merge reads off already.*policy own pt --retake/.test(r.message), `${what}: got ${String(r)}`);
      assert.equal(autoMergeKilled('pt', T), true, `${what}: still off`);
    }
  }
  // A shared id: OFF on either name turns both off; root's ON on one is refused (it would clear the other's OFF).
  const name = 'shon';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  kill.aliasInstance!(name, 'shother');
  setPolicy('shother', 'auto_merge', 'off', null, { ...m.deps, presence: () => 'exists' });
  assert.equal(autoMergeKilled(name), true);
  assert.throws(() => setPolicy(name, 'auto_merge', 'on', null, m.deps), /shother shares shon's id/);
  assert.equal(autoMergeKilled(name), true, 'refused: still off');
  // doctor: the shared id warns; a broken pointer, or a taken-over policy with none, fails.
  writeFileSync(join(m.dir, 'instance.yaml'), `version: 1\nname: ${name}\nrepos:\n  - path: "x"\n    repo: example/${name}\n`);
  const instances = join(m.home, '.local', 'state', BRAND.cli, 'instances');
  const idCheck = () => policyRootChecks(instances, { machine: true }).find((c) => c.name === `auto_merge id ${name}`);
  assert.equal(idCheck()?.level, 'warn');
  assert.match(idCheck()!.detail, /shother shares shon's id/);
  onRealMachine(POLICY_ROOT_DIR); // throws unless it is inside this test's system root (#815)
  unlinkSync(join(POLICY_ROOT_DIR, 'shother.id'));
  assert.equal(idCheck(), undefined);
  unlinkSync(join(POLICY_ROOT_DIR, `${name}.id`));
  assert.equal(idCheck()?.level, 'fail');
  assert.equal(autoMergeKilled(name), true, 'taken over, no pointer: off');
  // The coordinator's route (add-project's rerun: `policy own`, no flag) can't make a new id there; an admin's --retake can.
  assert.throws(() => ownPolicy(name, m.deps), /auto_merge reads off until an admin runs/);
  assert.equal(autoMergeKilled(name), true);
  ownPolicy(name, m.deps, { retake: true });
  assert.equal(idCheck(), undefined);
});

test('an id is never shared by accident: two first OFFs at once get one id, a re-added name gets a new one, and a rename A→B→A keeps every OFF (#726 round 9)', { skip }, () => {
  // Two OFFs on an instance with no pointer yet: the second links its pointer while the first is between its directory
  // and its pointer. One pointer wins (an atomic link), and both OFFs are in its id.
  const { T } = recordsDir('mint');
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const link = fs.linkSync as (a: string, b: string) => void;
  let nested = false;
  fs.linkSync = (a: string, b: string) => {
    if (!nested && String(b).endsWith('/mi.id')) {
      nested = true;
      setPolicy('mi', 'auto_merge', 'off', null, { presence: () => 'exists', markerDir: T });
    }
    link(a, b);
  };
  syncBuiltinESMExports();
  try {
    setPolicy('mi', 'auto_merge', 'off', null, { presence: () => 'exists', markerDir: T });
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
  assert.ok(nested);
  assert.equal(readdirSync(join(T, 'by_id')).length, 1, "the loser's empty directory is gone");
  assert.equal(readdirSync(switchDir('mi', T)).filter((f) => f.startsWith('auto-merge-off')).length >= 1, true);
  // Removed (its pointer and, with no name pointing at it, its id's directory), then added again: a new id, so an
  // earlier instance's OFF never applies to it, and its own starts clean.
  const first = switchDir('mi', T);
  unlinkSync(join(T, 'mi.id'));
  setPolicy('mi', 'auto_merge', 'off', null, { presence: () => 'exists', markerDir: T });
  assert.notEqual(switchDir('mi', T), first, 'a fresh random id');
  // A→B then B→A: the same id throughout, so every OFF stays.
  const { T: T2 } = recordsDir('aba');
  kill.aliasInstance!('ra', 'rb', T2);
  setPolicy('ra', 'auto_merge', 'off', null, { presence: () => 'exists', markerDir: T2 });
  unlinkSync(join(T2, 'ra.id')); // A's removal
  kill.aliasInstance!('rb', 'ra', T2);
  unlinkSync(join(T2, 'rb.id')); // B's removal
  assert.equal(autoMergeKilled('ra', T2), true, 'A again, with the OFF it was given before both renames');
});

test('"can still start" counts only a definite "no such user" as absent: a lookup that fails or times out is "can start", so an OFF there is never refused as "no instance" (#726 round 8)', { skip }, () => {
  const os = osAdapter as Record<string, unknown>;
  const presence = os.userPresence as ((u: string, t?: number) => string) | undefined;
  assert.equal(typeof presence, 'function', 'userPresence (through b9d89224 only userUid, which reads any error as no user)');
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'getent-')));
  const stub = (body: string) => {
    writeFileSync(join(bin, 'getent'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, 'getent'), 0o755);
  };
  const path = process.env.PATH;
  try {
    process.env.PATH = bin;
    stub('echo "wl-x:x:1001:1001::/srv/example:/bin/sh"');
    assert.equal(presence!('wl-x'), 'exists');
    stub('exit 2');
    assert.equal(presence!('wl-x'), 'absent', 'getent: not found');
    stub('exit 1');
    assert.equal(presence!('wl-x'), 'unknown', 'a lookup error');
    stub('exec sleep 5');
    assert.equal(presence!('wl-x', 200), 'unknown', 'a timeout');
    stub('echo "someone-else:x:1:1::/:/bin/sh"');
    assert.equal(presence!('wl-x'), 'unknown');
    process.env.PATH = join(bin, 'none');
    assert.equal(presence!('wl-x'), 'unknown', 'no getent at all');
  } finally {
    process.env.PATH = path;
  }
  // setPolicy: a name whose lookup can't tell is armed (or fails visibly on a full disk with no spare), never "no instance".
  const { T } = recordsDir('presence');
  assert.equal(setPolicy('pres', 'auto_merge', 'off', null, { presence: () => 'unknown', markerDir: T }).to, false);
  assert.equal(autoMergeKilled('pres', T), true);
  const { T: T2 } = recordsDir('presence-full');
  const r = offOnFullDisk('pres', { presence: () => 'unknown', markerDir: T2 });
  assert.ok(r instanceof Error && /pres's auto_merge switch couldn't be armed/.test(r.message), `got ${String(r)}`);
  assert.throws(() => setPolicy('pres', 'auto_merge', 'off', null, { presence: () => 'absent', markerDir: T2 }), /no instance pres/);
});

test("lib.sh auto_merge_killed (add-project's text) reads root's switches as the engine does: by id, and off on anything it can't read (#726 round 9)", { skip: (skip || me === 0) && 'needs a non-root user (mode 000 binds root nothing)' }, () => {
  const { T, run } = recordsDir('libread');
  const killed = (n: string) => run(`auto_merge_killed ${n}`).status === 0;
  assert.equal(killed('nobody'), false, 'no record, no pointer: as policy.yaml says');
  writeFileSync(join(T, 'recd'), '{}\n');
  assert.equal(killed('recd'), true, 'taken over, no pointer: off');
  kill.aliasInstance!('la', 'lb', T);
  assert.equal(killed('la'), false);
  setPolicy('lb', 'auto_merge', 'off', null, { presence: () => 'exists', markerDir: T });
  assert.equal(killed('la'), true, 'an OFF on the other name of the same id');
  writeFileSync(join(T, 'lg.id'), 'garbled\n');
  assert.equal(killed('lg'), true, 'a garbled pointer: off');
  // The id directory under this test's own temporary root T (not root's directory, so no onRealMachine: #815).
  const la = kill.instanceId!('la', T);
  assert.ok(la && 'id' in la);
  const d = join(T, 'by_id', la.id);
  assert.equal(d, switchDir('la', T));
  chmodSync(d, 0o000);
  try {
    assert.equal(killed('la'), true, "an id directory it can't list: off");
  } finally {
    chmodSync(d, 0o755);
  }
  chmodSync(T, 0o000);
  try {
    assert.equal(killed('nobody'), true, "root's directory it can't list: off");
  } finally {
    chmodSync(T, 0o755);
  }
});

/** A taken-over instance that said OFF (an admin's `set on`, then an OFF), then lost its id pointer: it reads off. */
function lostPointer(name: string) {
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  setPolicy(name, 'auto_merge', 'on', null, m.deps);
  setPolicy(name, 'auto_merge', 'off', null, m.deps);
  onRealMachine(POLICY_ROOT_DIR); // throws unless it is inside this test's system root (#815)
  unlinkSync(join(POLICY_ROOT_DIR, `${name}.id`));
  assert.equal(autoMergeKilled(name), true, 'taken over, no pointer: off');
  return m;
}

test("a taken-over instance whose pointer is gone: `policy alias` (a rename's start) refuses it, naming the admin's --retake, and it stays off (#726 round 10)", { skip }, () => {
  lostPointer('lpa');
  assert.throws(() => kill.aliasInstance!('lpa', 'lpb'), /lpa was taken over .* no .*lpa\.id.*policy own lpa --retake/);
  assert.equal(existsSync(join(POLICY_ROOT_DIR, 'lpb.id')), false);
  assert.equal(existsSync(join(POLICY_ROOT_DIR, 'lpa.id')), false);
  assert.equal(autoMergeKilled('lpa'), true);
});

test('a taken-over instance whose pointer is gone: an OFF with room for a directory and a pointer but not for the switch fails visibly and links no pointer, so it stays off (#726 round 10)', { skip }, () => {
  // Through 2597efc5 the pointer was linked first, naming an empty id, and auto_merge read on.
  const m = lostPointer('lpc');
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const orig = { writeFileSync: fs.writeFileSync };
  fs.writeFileSync = (p: unknown, ...r: unknown[]) => {
    if (String(p).includes('/by_id/')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return (orig.writeFileSync as (...a: unknown[]) => unknown)(p, ...r);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => setPolicy('lpc', 'auto_merge', 'off', null, m.deps), /couldn't be armed .*ENOSPC/);
  } finally {
    Object.assign(fs, orig);
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(join(POLICY_ROOT_DIR, 'lpc.id')), false, 'no pointer linked');
  assert.equal(autoMergeKilled('lpc'), true, 'still off');
});

test('a taken-over instance whose pointer is gone: an OFF SIGKILLed right after linking its new pointer, or right before, leaves it off (#726 round 10)', { skip }, () => {
  for (const when of ['after the link', 'before the link']) {
    const name = when.startsWith('after') ? 'lpk' : 'lpj';
    const mk = lostPointer(name);
    const child = join(mk.T, 'off-kill.mjs');
    writeFileSync(child, `import { createRequire, syncBuiltinESMExports } from 'node:module';
const a = JSON.parse(process.argv[2]);
${depsLine}
const fs = createRequire(import.meta.url)('node:fs');
const { setPolicy } = await import(a.module);
const link = fs.linkSync;
fs.linkSync = (from, to) => {
  if (a.when === 'before' && String(to).endsWith('/' + a.name + '.id')) process.kill(process.pid, 'SIGKILL');
  link(from, to);
  if (String(to).endsWith('/' + a.name + '.id')) process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
setPolicy(a.name, 'auto_merge', 'off', null, d);
`);
    const r = spawnSync(process.execPath, [child, childArgs(name, mk, { when: when.split(' ')[0] })], { encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', `${when}: ${r.stderr}`);
    assert.equal(autoMergeKilled(name), true, `SIGKILL ${when}: still off`);
  }
});

test("a taken-over instance whose pointer is gone: an admin's --retake makes its new id with a switch armed, so it stays off until root's own `set on` (#726 round 10)", { skip }, () => {
  const mr = lostPointer('lpr');
  ownPolicy('lpr', mr.deps, { retake: true });
  assert.equal(autoMergeKilled('lpr'), true, 'retake keeps it off');
  setPolicy('lpr', 'auto_merge', 'on', null, mr.deps);
  assert.equal(autoMergeKilled('lpr'), false, "root's `set on` turns it on");
});

/** A taken-over instance that said OFF, then lost its id directory (the pointer still names it): it reads off. */
function lostDir(name: string) {
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  setPolicy(name, 'auto_merge', 'on', null, m.deps);
  setPolicy(name, 'auto_merge', 'off', null, m.deps);
  const p = instanceId(name);
  assert.ok(p && 'id' in p);
  const d = idDir(p.id);
  onRealMachine(d); // throws unless it is inside this test's system root (#815)
  rmSync(d, { recursive: true });
  assert.equal(autoMergeKilled(name), true, 'its id directory gone: off');
  return { m, d };
}

test("a taken-over instance whose id directory is gone is never made ON again by a writer re-creating it empty: the helper's set-policy of any key, `own` without a flag, an admin's `policy set`, `alias` and `set on` leave it off, and doctor says so (#726 round 11)", { skip }, () => {
  const { m, d } = lostDir('ldir');
  // Through 56b37300 each of these made `by_id/<id>` again with only a spare, and auto_merge read on.
  setPolicy('ldir', 'budget.daily_usd', '40', 'wl-ldir', m.deps);
  assert.equal(autoMergeKilled('ldir'), true, "the helper's set-policy budget");
  setPolicy('ldir', 'settings.workers', '1', 'wl-ldir', m.deps);
  assert.equal(autoMergeKilled('ldir'), true, "the helper's set-policy settings.workers");
  setPolicy('ldir', 'budget.daily_usd', '45', null, m.deps);
  assert.equal(autoMergeKilled('ldir'), true, "an admin's policy set");
  assert.throws(() => ownPolicy('ldir', m.deps), /by_id\/[0-9a-f]{32} is gone.*policy own ldir --retake/, 'add-project\'s rerun: own, no flag');
  assert.throws(() => kill.aliasInstance!('ldir', 'ldirn'), /is gone.*--retake/, "a rename's start");
  assert.throws(() => setPolicy('ldir', 'auto_merge', 'on', null, m.deps), /is gone.*--retake/, "root's set on");
  assert.equal(existsSync(d), false, 'never made again empty');
  assert.equal(autoMergeKilled('ldir'), true);
  // doctor: a failure, naming the fix.
  writeFileSync(join(m.dir, 'instance.yaml'), `version: 1\nname: ldir\nrepos:\n  - path: "x"\n    repo: example/ldir\n`);
  const c = policyRootChecks(join(m.home, '.local', 'state', BRAND.cli, 'instances'), { machine: true }).find((x) => x.name === 'auto_merge id ldir');
  assert.equal(c?.level, 'fail');
  assert.match(c!.detail, /is gone: auto_merge reads off.*policy own ldir --retake/);
});

test('a taken-over instance whose id directory is gone: an OFF puts it back with a switch armed, never empty (a full disk fails visibly, still off); an admin\'s --retake puts it back armed, and a garbled pointer\'s --retake gives a new armed id (#726 round 11)', { skip }, () => {
  const { m, d } = lostDir('ldo');
  // A full disk: no room for the spare in the temp directory: visible, nothing put in place, still off.
  const r = offOnFullDisk('ldo', m.deps);
  assert.ok(r instanceof Error && /couldn't be armed/.test(r.message), `got ${String(r)}`);
  assert.equal(existsSync(d), false);
  assert.equal(autoMergeKilled('ldo'), true);
  // With room: done, the directory back with a switch armed (through 56b37300: ENOENT, "free space").
  assert.equal(setPolicy('ldo', 'auto_merge', 'off', 'wl-ldo', m.deps).to, false);
  assert.ok(readdirSync(d).some((f) => f.startsWith('auto-merge-off')), 'armed');
  assert.equal(autoMergeKilled('ldo'), true);
  // --retake over a missing directory: back, armed; then root's set on turns it on.
  const { m: m2, d: d2 } = lostDir('ldr');
  ownPolicy('ldr', m2.deps, { retake: true });
  assert.ok(readdirSync(d2).some((f) => f.startsWith('auto-merge-off')), 'armed');
  assert.equal(autoMergeKilled('ldr'), true);
  setPolicy('ldr', 'auto_merge', 'on', null, m2.deps);
  assert.equal(autoMergeKilled('ldr'), false);
  // A garbled pointer: --retake (named by doctor) now works: a new id, armed, off.
  const m3 = machineInstance('ldg');
  ownPolicy('ldg', m3.deps);
  onRealMachine(POLICY_ROOT_DIR); // throws unless it is inside this test's system root (#815)
  writeFileSync(join(POLICY_ROOT_DIR, 'ldg.id'), 'garbled\n');
  assert.equal(autoMergeKilled('ldg'), true);
  ownPolicy('ldg', m3.deps, { retake: true });
  assert.ok(kill.instanceId!('ldg') && 'id' in kill.instanceId!('ldg')!, 'a usable pointer');
  assert.equal(autoMergeKilled('ldg'), true, 'kept off');
});

test("an OFF's mint that failed or was killed before its link leaves an id directory no pointer names: the next `own` sweeps it once an hour old, never a fresh one (#726 round 11)", { skip }, () => {
  const m = machineInstance('swo');
  ownPolicy('swo', m.deps);
  const byId = join(POLICY_ROOT_DIR, 'by_id');
  onRealMachine(byId); // throws unless it is inside this test's system root (#815)
  const [old, fresh] = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02'];
  for (const n of [old, fresh]) {
    mkdirSync(join(byId, n));
    writeFileSync(join(byId, n, 'auto-merge-spare'), '');
  }
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  utimesSync(join(byId, old), twoHoursAgo, twoHoursAgo);
  ownPolicy('swo', m.deps);
  assert.equal(existsSync(join(byId, old)), false, 'an hour-old orphan goes');
  assert.equal(existsSync(join(byId, fresh)), true, "a fresh one stays (another OFF's, between its directory and its link)");
  assert.equal(existsSync(switchDir('swo')), true, "a pointer's own directory stays");
});

test("a rename landing inside the orphan sweep (after it listed root's pointers, before it read the old name's) never drops the live id: the renamed instance stays on and its writers go on (#726 round 12)", { skip }, () => {
  // Through 28c54dc9 the sweep read the old name's pointer gone, took the id for an orphan and dropped its directory.
  const m = machineInstance('swr');
  ownPolicy('swr', m.deps);
  setPolicy('swr', 'auto_merge', 'on', null, m.deps);
  assert.equal(autoMergeKilled('swr'), false, 'on before the rename');
  const p = instanceId('swr');
  assert.ok(p && 'id' in p);
  const live = idDir(p.id);
  onRealMachine(live); // throws unless it is inside this test's system root (#815)
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  utimesSync(live, twoHoursAgo, twoHoursAgo);
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const orig = { readdirSync: fs.readdirSync };
  let renamed = false;
  fs.readdirSync = (p: unknown, ...r: unknown[]) => {
    const got = (orig.readdirSync as (...a: unknown[]) => unknown)(p, ...r);
    if (!renamed && String(p) === POLICY_ROOT_DIR) {
      renamed = true; // instance-rename.sh: the new name aliased to the id, then the old pointer removed
      kill.aliasInstance!('swr', 'swr2');
      onRealMachine(POLICY_ROOT_DIR); // throws unless it is inside this test's system root (#815)
      unlinkSync(join(POLICY_ROOT_DIR, 'swr.id'));
    }
    return got;
  };
  syncBuiltinESMExports();
  try {
    kill.sweepOrphanIds!();
  } finally {
    Object.assign(fs, orig);
    syncBuiltinESMExports();
  }
  assert.ok(renamed, 'the rename ran inside the sweep');
  assert.equal(existsSync(live), true, 'the live id directory stays');
  assert.equal(switchDir('swr2'), live);
  assert.equal(autoMergeKilled('swr2'), false, 'the renamed instance is still on');
  setPolicy('swr2', 'auto_merge', 'off', null, m.deps);
  assert.equal(autoMergeKilled('swr2'), true, 'and its OFF goes on');
});
