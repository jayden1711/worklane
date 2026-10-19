// Issue #726, principle 2 (the owner's): turning auto_merge OFF can never be blocked or undone. Root's kill switch
// (src/policy-kill.ts) against an admin's `set on` racing it, a crash part way, a full filesystem and a rename.
// Stand-ins only, as in test/policy-edit.test.ts: "root" is this test's own uid; no test runs as root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { processIdentity } from '../src/os/index.js';
import { policyRootChecks } from '../src/doctor-policy-root.js';
import * as osAdapter from '../src/os/index.js';
import { autoMergeKilled, POLICY_ROOT_DIR, renameForwardPath } from '../src/policy-kill.js';
import * as kill from '../src/policy-kill.js';
import { ownPolicy, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';
import { repoRoot } from './helpers.js';

const skip = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc)';
const me = process.platform === 'win32' ? 0 : process.getuid!();
const POLICY = 'version: 1\nbudget: { daily_usd: 50 }\nagents: { max_workers: 4 }\nland_mode: pr\nauto_merge: false\n';
const lib = join(repoRoot, 'scripts', 'setup', 'lib.sh');

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
    assert.equal(readdirSync(POLICY_ROOT_DIR).includes(`${name}.auto-merge-spare`), false, 'no spare left');
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
  const files = () => readdirSync(POLICY_ROOT_DIR).filter((f) => f.startsWith(`${name}.`)).length;
  setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps);
  const after1 = files();
  for (let i = 0; i < 50; i++) setPolicy(name, 'auto_merge', 'off', `wl-${name}`, m.deps);
  assert.equal(files(), after1, 'no new file per OFF');
  assert.equal(autoMergeKilled(name), true);
});

test('a rename never loses an OFF: one given to the old name after the home step is carried again before the new service starts and before the old name\'s removal (#726 round 5)', { skip: process.platform === 'win32' && 'bash' }, () => {
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'rename-off-')));
  const run = (script: string) => spawnSync('bash', ['-c', `source "$1"; POLICY_ROOT_DIR="$2"; ${script}`, '_', lib, T], { encoding: 'utf8' });
  // The home step carried nothing (no OFF yet); then an admin's OFF on the old name lands.
  assert.equal(run('carry_policy_root oldname newname').status, 0);
  writeFileSync(join(T, 'oldname.auto-merge-off.1700000000000-42-abcd'), '');
  assert.equal(autoMergeKilled('newname', T), false);
  // The carry right before the new name's service starts.
  assert.equal(run('carry_auto_merge_off oldname newname').status, 0);
  assert.equal(autoMergeKilled('newname', T), true);
  assert.equal(run('auto_merge_killed newname').status, 0);
  assert.notEqual(run('auto_merge_killed other').status, 0);
  // instance-rename.sh runs it right before service.sh for the new name, and right before instance-remove.sh.
  const rename = spawnSync('cat', [join(repoRoot, 'scripts', 'setup', 'instance-rename.sh')], { encoding: 'utf8' }).stdout;
  assert.match(rename, /\n {2}carry_auto_merge_off "\$old" "\$new"\n {2}bash "\$here\/service\.sh" "\$new"/);
  assert.match(rename, /\n {2}carry_auto_merge_off "\$old" "\$new"\n {2}bash "\$here\/instance-remove\.sh" "\$old" --yes/);
});

/** A full filesystem in root's directory, stood in: every create there fails `code` (rename and unlink still work). */
function fullDisk(code = 'ENOSPC'): () => void {
  const fs = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const orig = { writeFileSync: fs.writeFileSync, openSync: fs.openSync };
  const err = () => Object.assign(new Error(`${code}: no space left on device`), { code });
  fs.writeFileSync = (p: unknown, ...r: unknown[]) => {
    if (String(p).includes('/policy-root')) throw err();
    return (orig.writeFileSync as (...a: unknown[]) => unknown)(p, ...r);
  };
  fs.openSync = (p: unknown, flag?: unknown, ...r: unknown[]) => {
    if (String(p).includes('/policy-root') && (typeof flag === 'string' ? /[wa]/.test(flag) : typeof flag === 'number' && (flag & 0o100) !== 0)) throw err();
    return (orig.openSync as (...a: unknown[]) => unknown)(p, flag, ...r);
  };
  syncBuiltinESMExports();
  return () => {
    Object.assign(fs, orig);
    syncBuiltinESMExports();
  };
}

test("while a rename runs, an OFF given to the old name at any step (before or after each carry, and inside the old name's removal after the last carry) turns the new name off too, with no new space (#726 round 6)", { skip }, () => {
  const steps = ['park', 'export', 'users', 'home', 'checkout', 'import', 'records', 'services', 'keep', 'remove: after the carry, inside instance-remove, its users there', 'remove: inside instance-remove, its users and then its switches gone'];
  for (const [i, step] of steps.entries()) {
    const T = join(realpathSync(mkdtempSync(join(tmpdir(), 'rename-fwd-'))), 'policy-root');
    mkdirSync(T, { mode: 0o755 });
    const [oldName, newName] = [`old${i}`, `new${i}`];
    // Round 7: inside the old name's removal its user goes before its switches (the registry's order, below).
    const usersGone = step.includes('users and then');
    const deps: PolicyRootDeps = { uid: (u) => (usersGone && u === `wl-${oldName}` ? null : me), markerDir: T };
    const run = (script: string) => spawnSync('bash', ['-c', `source "$1"; POLICY_ROOT_DIR="$2"; own_policy() { :; }; ${script}`, '_', lib, T], { encoding: 'utf8' });
    // The old name, taken over: its spare. The rename's start: root's forward record, and a spare for the new name.
    writeFileSync(join(T, `${oldName}.auto-merge-spare`), '');
    const fwd = run(`rename_forward ${oldName} ${newName}`);
    assert.equal(fwd.status, 0, `${step}: ${fwd.stderr}`);
    if (i >= steps.indexOf('home')) run(`carry_policy_root ${oldName} ${newName}`);
    if (i >= steps.indexOf('services')) run(`carry_auto_merge_off ${oldName} ${newName}`);
    if (step.startsWith('remove')) run(`carry_auto_merge_off ${oldName} ${newName}`);
    // instance-remove.sh: the registry's glob takes the old name's switches once its users are gone.
    if (usersGone) run(`rm -f "$POLICY_ROOT_DIR/${oldName}".auto-merge-*`);
    assert.equal(autoMergeKilled(newName, T), false, `${step}: on before the OFF`);
    // With every create in root's directory failing: each name's OFF uses its spare.
    const restore = fullDisk();
    try {
      setPolicy(oldName, 'auto_merge', 'off', `wl-${oldName}`, deps);
    } finally {
      restore();
    }
    // The old name too, while it can still start (its user there); once its user and switches are gone, nothing runs as it.
    if (!usersGone) assert.equal(autoMergeKilled(oldName, T), true, step);
    assert.equal(autoMergeKilled(newName, T), true, `${step}: the instance that runs is off`);
    // The rename done (or aborted): the forward goes.
    assert.equal(run(`rename_forward_done ${oldName}`).status, 0);
    assert.equal(existsSync(join(T, `${oldName}.rename-to`)), false);
  }
  // instance-rename.sh writes it before its first step, and removes it after the last (the old name's removal) and on --abort.
  const rename = spawnSync('cat', [join(repoRoot, 'scripts', 'setup', 'instance-rename.sh')], { encoding: 'utf8' }).stdout;
  // (Round 8: a rerun once the old name's removal is done doesn't write it again.)
  assert.match(rename, /\ndone_step remove \|\| rename_forward "\$old" "\$new"\n[\s\S]*?\nfor s in "\$\{STEPS\[@\]\}"; do run_step "\$s"; done\n[^\n]*\nrename_forward_done "\$old"\n/);
  // Round 7: --abort ends the forward FIRST, then moves the new name's switches back (no new space), then the new name
  // goes. (Through ae00a348 it carried back first and ended the forward last: an OFF in between said done while the
  // old name came back on.)
  assert.match(rename, /say "abort: [^\n]*\n(?: {2}#[^\n]*\n)* {2}rename_forward_done "\$old"\n {2}move_auto_merge_off "\$new" "\$old"\n[\s\S]*?instance-remove\.sh" "\$new"/, '--abort ends the forward, then moves the OFF back to the old name, before the new one goes');
  const abortAt = rename.indexOf('if [ -n "$abort" ]; then');
  const abortBlock = rename.slice(abortAt, rename.indexOf('\nfi\n', abortAt));
  assert.equal(abortBlock.match(/rename_forward_done/g)?.length, 1, '--abort ends the forward once, first');
});

test('many OFFs at once (12 processes) never add files, never report a failure, and leave auto_merge off (#726 round 6)', { skip }, async () => {
  const name = 'many';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  setPolicy(name, 'auto_merge', 'off', null, m.deps);
  const files = () => readdirSync(POLICY_ROOT_DIR).filter((f) => f.startsWith(`${name}.auto-merge`)).length;
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
    let nested = false;
    fs.renameSync = (a: string, b: string) => {
      rename(a, b);
      if (!nested && String(b).includes(`${name}.auto-merge-off.`)) {
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
    let nested = false;
    fs.renameSync = (a: string, b: string) => {
      if (!nested && String(a).endsWith(`${name}.auto-merge-spare`)) {
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
  // A file's mtime set to a wall time some while ago (not a duration).
  const tenMinutesAgo = new Date(Date.now() - 600_000);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
  const age = (p: string, t: Date) => utimesSync(p, t, t);
  // A writer that is gone (a process that ran and exited): its temp file goes at once.
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout.trim());
  assert.ok(deadPid > 0);
  const killed = join(POLICY_ROOT_DIR, `.${deadPid}-0123456789ab.auto-merge.tmp`);
  writeFileSync(killed, 'auto_merge off since then\n');
  // A writer still alive (this process), stalled ten minutes between its write and its rename: kept.
  const stalled = join(POLICY_ROOT_DIR, `.${process.pid}-ba9876543210.auto-merge.tmp`);
  writeFileSync(stalled, '');
  age(stalled, tenMinutesAgo);
  // A name with no pid (round 6's), ten minutes old: kept (its writer can't be told gone); two days old: gone.
  const noPid = join(POLICY_ROOT_DIR, '.00112233aabb.auto-merge.tmp');
  writeFileSync(noPid, '');
  age(noPid, tenMinutesAgo);
  const ancient = join(POLICY_ROOT_DIR, `.${process.pid}-ccddeeff0011.auto-merge.tmp`);
  writeFileSync(ancient, '');
  age(ancient, twoDaysAgo);
  setPolicy(name, 'auto_merge', 'off', null, m.deps);
  assert.equal(existsSync(killed), false, "a gone writer's is swept");
  assert.equal(existsSync(stalled), true, "a live writer's, stalled, is kept (through ae00a348 a minute old was swept)");
  assert.equal(existsSync(noPid), true, 'one with no pid is kept until a day old');
  assert.equal(existsSync(ancient), false, 'anything a day old is swept');
});

/** A rename's stand-in directory for root's records, with lib.sh's own functions to run against it. */
function renameDir(tag: string) {
  const T = join(realpathSync(mkdtempSync(join(tmpdir(), `rename-${tag}-`))), 'policy-root');
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

test('OFF says done only when every name it reached that can still start is armed, and tries every name before it reports (#726 round 7)', { skip }, () => {
  // A rename of an old name root never took over, its spare gone (or a rename started before rename_forward made
  // one): on a full filesystem the old name can't be armed. It can still start (its user is there), so OFF fails,
  // naming it, and the new name is armed all the same. (Through ae00a348 this said done, the old name left on.)
  const { T, run } = renameDir('strict');
  assert.equal(run('rename_forward olds news').status, 0);
  run('rm -f "$POLICY_ROOT_DIR/olds.auto-merge-spare"');
  const r = offOnFullDisk('olds', { uid: () => me, markerDir: T });
  assert.ok(r instanceof Error, 'never done while olds can start with auto_merge on');
  assert.match(r.message, /olds's auto_merge switch couldn't be armed .*so olds can still merge on its own.*policy set olds auto_merge off/);
  assert.doesNotMatch(r.message, /news's/, 'only the name still on is named');
  assert.equal(autoMergeKilled('news', T), true, 'every name tried before it reports: the new one is armed');
  // The same OFF with room: done, both armed.
  const { T: T2, run: run2 } = renameDir('strict-room');
  assert.equal(run2('rename_forward olds news').status, 0);
  setPolicy('olds', 'auto_merge', 'off', null, { uid: () => me, markerDir: T2 });
  assert.equal(autoMergeKilled('olds', T2), true);
  assert.equal(autoMergeKilled('news', T2), true);
  // rename_forward gives the old name a spare too (root took it over or not), so on a full disk both are done.
  const { T: T3, run: run3 } = renameDir('strict-spare');
  assert.equal(run3('rename_forward olds news').status, 0);
  assert.equal(existsSync(join(T3, 'olds.auto-merge-spare')), true);
  assert.equal(offOnFullDisk('olds', { uid: () => me, markerDir: T3 }), 'done');
  assert.equal(autoMergeKilled('olds', T3), true);
  assert.equal(autoMergeKilled('news', T3), true);
});

test('--abort on a full filesystem: an OFF on the old name at each point either leaves it off at the end or fails visibly, never done with it on (#726 round 7)', { skip }, () => {
  // The abort, as instance-rename.sh runs it (its order is held below): the forward ends; the new name's switches move
  // back to the old name; the new name goes (instance-remove.sh's glob).
  const points = ['before the abort', 'after the forward ends', 'after the move back', 'after the new name goes'];
  for (const spare of [true, false]) {
    for (const [i, point] of points.entries()) {
      const { T, run } = renameDir(`abort${i}`);
      assert.equal(run('rename_forward olda newa').status, 0);
      // 1a: an old name with no spare (one root never took over, in a rename begun without one); 1b: with its spare.
      if (!spare) run('rm -f "$POLICY_ROOT_DIR/olda.auto-merge-spare"');
      const deps: PolicyRootDeps = { uid: (u) => (i >= 3 && u === 'wl-newa' ? null : me), markerDir: T };
      const steps = ['rename_forward_done olda', 'move_auto_merge_off newa olda', 'rm -f "$POLICY_ROOT_DIR/newa".auto-merge-*'];
      for (const s of steps.slice(0, i)) assert.equal(run(s).status, 0, s);
      const r = offOnFullDisk('olda', deps);
      for (const s of steps.slice(i)) assert.equal(run(s).status, 0, s);
      const off = autoMergeKilled('olda', T);
      assert.ok(off || r instanceof Error, `${spare ? '1b' : '1a'} ${point}: said done (${r}) and olda came back with auto_merge on`);
      if (spare) {
        assert.equal(r, 'done', `1b ${point}`);
        assert.equal(off, true, `1b ${point}: olda is off`);
      } else assert.match(String(r), /olda's auto_merge switch couldn't be armed/, `1a ${point}: fails visibly, naming olda`);
    }
  }
  // An OFF during the rename, then the abort: the move back needs no space, and the old name ends off.
  const { T, run } = renameDir('abort-after');
  assert.equal(run('rename_forward oldb newb').status, 0);
  assert.equal(offOnFullDisk('oldb', { uid: () => me, markerDir: T }), 'done');
  run('rm -f "$POLICY_ROOT_DIR/oldb".auto-merge-off*'); // even with the old name's own switch lost: the new name's comes back
  for (const s of ['rename_forward_done oldb', 'move_auto_merge_off newb oldb', 'rm -f "$POLICY_ROOT_DIR/newb".auto-merge-*']) {
    const restore = fullDisk();
    try {
      assert.equal(run(s).status, 0, s);
    } finally {
      restore();
    }
  }
  assert.equal(autoMergeKilled('oldb', T), true);
  assert.equal(readdirSync(T).filter((f) => f.startsWith('newb.')).length, 0);
});

test("a forward record left behind (a stopped or killed rename, or naming no instance) never makes OFF refuse; inside the old name's removal, with its user gone, OFF reaches the new name (#726 round 7)", { skip }, () => {
  // A stale record, the old name running again (its user there, its spare), the new name gone (no user, no spare).
  {
    const { T, run } = renameDir('stale');
    assert.equal(run('rename_forward oldc newc').status, 0);
    run('rm -f "$POLICY_ROOT_DIR/newc".auto-merge-*');
    assert.equal(offOnFullDisk('oldc', { uid: (u) => (u === 'wl-newc' ? null : me), markerDir: T }), 'done');
    assert.equal(autoMergeKilled('oldc', T), true);
  }
  // A record naming no instance there ever was.
  {
    const { T } = renameDir('ghost');
    writeFileSync(join(T, 'oldd.auto-merge-spare'), '');
    writeFileSync(join(T, 'oldd.rename-to'), 'nosuch\n');
    assert.equal(offOnFullDisk('oldd', { uid: (u) => (u === 'wl-nosuch' ? null : me), markerDir: T }), 'done');
    assert.equal(autoMergeKilled('oldd', T), true);
  }
  // Inside instance-remove.sh <old>: its user gone, then its switches (the glob), the record still there.
  {
    const { T, run } = renameDir('inremove');
    assert.equal(run('rename_forward olde newe').status, 0);
    run('rm -f "$POLICY_ROOT_DIR/olde".auto-merge-*');
    const deps: PolicyRootDeps = { uid: (u) => (u === 'wl-olde' ? null : me), markerDir: T };
    assert.equal(offOnFullDisk('olde', deps), 'done', 'not "no instance olde" (through ae00a348 it was)');
    assert.equal(autoMergeKilled('newe', T), true, 'the new name, which runs, is off');
    // Once the removal took the record too: nothing names olde, and saying so is the truth.
    run('rm -f "$POLICY_ROOT_DIR/olde.rename-to"');
    assert.throws(() => setPolicy('olde', 'auto_merge', 'off', null, deps), /no instance olde/);
  }
  // instance-remove.sh <name> removes root's forward records that name it, either way, and none other.
  {
    const { T, run } = renameDir('records');
    writeFileSync(join(T, 'aaa.rename-to'), 'bbb\n');
    writeFileSync(join(T, 'ccc.rename-to'), 'aaa\n');
    writeFileSync(join(T, 'ddd.rename-to'), 'eee\n');
    writeFileSync(join(T, 'fff.rename-to'), 'aaab\n');
    const got = run('forward_records_of aaa');
    assert.equal(got.status, 0);
    assert.deepEqual(got.stdout.trim().split('\n').sort(), [join(T, 'aaa.rename-to'), join(T, 'ccc.rename-to')]);
  }
  const remove = spawnSync('cat', [join(repoRoot, 'scripts', 'setup', 'instance-remove.sh')], { encoding: 'utf8' }).stdout;
  const items = remove.indexOf('for line in "${ITEMS[@]}"; do\n  IFS=$\'\\t\' read -r k w when _');
  const records = remove.indexOf('done < <(forward_records_of "$name")');
  const sweep = remove.indexOf('rm -f -- "$POLICY_ROOT_DIR/$name".auto-merge-*');
  assert.ok(items > 0 && records > items && sweep > records, "instance-remove.sh: after its items (its users), the forward records, then any switch an OFF left inside the removal");
  // The registry: the kill switches' glob goes after the instance's coordinator user, so while that user is there
  // (the name can still start) an OFF still finds its switch or its spare.
  const items2 = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'setup', 'instance-records.cjs'), 'items', 'zed'], { encoding: 'utf8' }).stdout.split('\n');
  const user = items2.findIndex((l) => l.startsWith('user\twl-zed\t') || l === 'user\twl-zed');
  const glob = items2.findIndex((l) => l.startsWith('glob\t') &&l.includes('policy-root/zed.auto-merge-'));
  assert.ok(user >= 0 && glob > user, `the switches' glob comes after wl-zed (${user}, ${glob})`);
});

test("doctor reports root's forward record of an instance (a rename stopped, or one a crash left) (#726 round 7)", { skip }, () => {
  const name = 'fwddoc';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  writeFileSync(join(m.dir, 'instance.yaml'), `version: 1\nname: ${name}\nrepos:\n  - path: "x"\n    repo: example/${name}\n`);
  const instances = join(m.home, '.local', 'state', BRAND.cli, 'instances');
  assert.deepEqual(policyRootChecks(instances, { machine: true }).filter((c) => c.name.startsWith('rename record')), []);
  writeFileSync(renameForwardPath(name), 'fwdnew\n');
  const c = policyRootChecks(instances, { machine: true }).find((x) => x.name === `rename record ${name}`);
  assert.equal(c?.level, 'warn');
  assert.match(c!.detail, /fwddoc is being renamed to fwdnew, so auto_merge off for fwddoc turns fwdnew's off too.*--abort/);
});

test('--abort changes nothing while anything of the new name can run: its units are read from systemd, and a systemctl or registry that can\'t answer counts as "can run" (#726 round 8)', { skip }, () => {
  const { run } = renameDir('canrun');
  // systemd stand-ins: which of zed's units it knows, and the template instance's state.
  const sd = (load: string, mcp: string) => `systemctl() { case "$*" in *LoadState*" worklane-zed.service") echo ${load} ;; *LoadState*) echo not-found ;; *ActiveState*) echo ${mcp} ;; esac; }; instance_in_flight() { :; };`;
  const lines = (script: string) => {
    const r = run(script);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(lines(`${sd('not-found', 'inactive')} instance_can_run zed`), '', 'nothing installed, nothing running: nothing');
  assert.match(lines(`${sd('loaded', 'inactive')} instance_can_run zed`), /^unit worklane-zed\.service is installed \(loaded\)$/, "service.sh's coordinator unit (a services step that failed after it): can run");
  assert.match(lines(`${sd('not-found', 'active')} instance_can_run zed`), /^unit worklane-mcp@zed\.service: active$/);
  assert.equal(lines(`${sd('not-found', 'failed')} instance_can_run zed`), '');
  assert.equal(lines('systemctl() { return 1; }; instance_in_flight() { :; }; instance_can_run zed').split('\n').length, 4, 'a systemctl that fails: every unit counts');
  assert.match(lines('node() { return 1; }; instance_in_flight() { :; }; instance_can_run zed'), /registry of zed's units can't be read/);
  assert.match(lines(`${sd('not-found', 'inactive')} instance_in_flight() { echo "process 42 (node) as wl-zed"; }; instance_can_run zed`), /process 42/, 'anything of it in flight');
  // instance-rename.sh: --abort refuses on it before anything changes (before the forward ends), and a failed step
  // offers --abort only when nothing of the new name can run. (Through b9d89224 it ran, and took a running new
  // name's switches.)
  const rename = spawnSync('cat', [join(repoRoot, 'scripts', 'setup', 'instance-rename.sh')], { encoding: 'utf8' }).stdout;
  const abortAt = rename.indexOf('if [ -n "$abort" ]; then');
  const abortBlock = rename.slice(abortAt, rename.indexOf('\nfi\n', abortAt));
  const gate = abortBlock.indexOf('running="$(instance_can_run "$new")"');
  assert.ok(gate > 0 && gate < abortBlock.indexOf('rename_forward_done') && gate < abortBlock.indexOf('move_auto_merge_off'), 'the gate comes before the forward ends and the switches move');
  assert.match(abortBlock.slice(gate), /^running="\$\(instance_can_run "\$new"\)"\n {2}if \[ -n "\$running" \]; then\n[\s\S]*?\n {4}exit 1\n {2}fi\n/);
  assert.match(rename, /if ! done_step services && \[ -z "\$\(instance_can_run "\$new"\)" \]; then echo "Or undo it all/);
});

test('"can still start" counts only a definite "no such user" as absent: a lookup that fails or times out is "can start", so a failed arm there is a visible failure (#726 round 8)', { skip }, () => {
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
  // setPolicy: a name whose lookup can't tell, no spare, a full filesystem: a visible failure, never done.
  const { T } = renameDir('presence');
  const unknown: PolicyRootDeps = { presence: () => 'unknown', markerDir: T };
  const r = offOnFullDisk('pres', unknown);
  assert.ok(r instanceof Error && /pres's auto_merge switch couldn't be armed/.test(r.message), `got ${String(r)}`);
  // During a rename, the new name's spare gone and its lookup failing: fails naming it (the old name is armed).
  const { T: T2, run: run2 } = renameDir('presence-fwd');
  assert.equal(run2('rename_forward presa presb').status, 0);
  run2('rm -f "$POLICY_ROOT_DIR/presb".auto-merge-*');
  const r2 = offOnFullDisk('presa', { presence: (u) => (u === 'wl-presb' ? 'unknown' : 'exists'), markerDir: T2 });
  assert.ok(r2 instanceof Error && /presb's auto_merge switch couldn't be armed/.test(r2.message), `got ${String(r2)}`);
  assert.equal(autoMergeKilled('presa', T2), true);
  // Only a definite "absent" lets it say done there (the new name gone).
  assert.equal(offOnFullDisk('presa', { presence: (u) => (u === 'wl-presb' ? 'absent' : 'exists'), markerDir: T2 }), 'done');
});

test("a forward record that can't be read, or names no other instance, is never read as \"no rename\": OFF arms the name given and fails visibly, and doctor fails (#726 round 8)", { skip }, () => {
  for (const [what, make] of [
    ['garbled', (p: string) => writeFileSync(p, '../x\n')],
    ['its own name', (p: string) => writeFileSync(p, 'recg\n')],
    ['unreadable (a directory)', (p: string) => mkdirSync(p)],
  ] as const) {
    const { T } = renameDir('badrec');
    writeFileSync(join(T, 'recg.auto-merge-spare'), '');
    make(join(T, 'recg.rename-to'));
    const r = offOnFullDisk('recg', { uid: () => me, presence: () => 'exists', markerDir: T });
    assert.ok(r instanceof Error && /recg\.rename-to can't be used/.test(r.message), `${what}: got ${String(r)}`);
    assert.equal(autoMergeKilled('recg', T), true, `${what}: the name given is armed all the same`);
  }
  const k = kill as Record<string, unknown>;
  assert.equal(typeof k.forwardRecord, 'function');
  // doctor: a failure, not "no record".
  const name = 'baddoc';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  writeFileSync(join(m.dir, 'instance.yaml'), `version: 1\nname: ${name}\nrepos:\n  - path: "x"\n    repo: example/${name}\n`);
  writeFileSync(renameForwardPath(name), 'BAD NAME\n');
  const c = policyRootChecks(join(m.home, '.local', 'state', BRAND.cli, 'instances'), { machine: true }).find((x) => x.name === `rename record ${name}`);
  assert.equal(c?.level, 'fail');
  assert.match(c!.detail, /can't be used .*auto_merge off for baddoc reports a failure/);
});

test("a carry or move of root's switches fails, stopping its step, when root's directory is there but can't be listed (#726 round 8)", { skip: (skip || me === 0) && 'needs a non-root user (mode 000 binds root nothing)' }, () => {
  const { T, run } = renameDir('unlistable');
  writeFileSync(join(T, 'cara.auto-merge-off.1'), '');
  chmodSync(T, 0o000);
  try {
    assert.notEqual(run('carry_auto_merge_off cara carb').status, 0, 'carry: never "nothing to carry"');
    assert.notEqual(run('move_auto_merge_off cara carb').status, 0, 'move: the same');
  } finally {
    chmodSync(T, 0o755);
  }
  assert.equal(run('carry_auto_merge_off cara carb').status, 0);
  assert.equal(autoMergeKilled('carb', T), true);
});
