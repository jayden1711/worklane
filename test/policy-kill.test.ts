// Issue #726, principle 2 (the owner's): turning auto_merge OFF can never be blocked or undone. Root's kill switch
// (src/policy-kill.ts) against an admin's `set on` racing it, a crash part way, a full filesystem and a rename.
// Stand-ins only, as in test/policy-edit.test.ts: "root" is this test's own uid; no test runs as root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { processIdentity } from '../src/os/index.js';
import { autoMergeKilled, POLICY_ROOT_DIR } from '../src/policy-kill.js';
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
  const steps = ['park', 'export', 'users', 'home', 'checkout', 'import', 'records', 'services', 'keep', 'remove: after the carry, inside instance-remove'];
  for (const [i, step] of steps.entries()) {
    const T = join(realpathSync(mkdtempSync(join(tmpdir(), 'rename-fwd-'))), 'policy-root');
    mkdirSync(T, { mode: 0o755 });
    const [oldName, newName] = [`old${i}`, `new${i}`];
    const deps: PolicyRootDeps = { uid: () => me, markerDir: T };
    const run = (script: string) => spawnSync('bash', ['-c', `source "$1"; POLICY_ROOT_DIR="$2"; own_policy() { :; }; ${script}`, '_', lib, T], { encoding: 'utf8' });
    // The old name, taken over: its spare. The rename's start: root's forward record, and a spare for the new name.
    writeFileSync(join(T, `${oldName}.auto-merge-spare`), '');
    const fwd = run(`rename_forward ${oldName} ${newName}`);
    assert.equal(fwd.status, 0, `${step}: ${fwd.stderr}`);
    if (i >= steps.indexOf('home')) run(`carry_policy_root ${oldName} ${newName}`);
    if (i >= steps.indexOf('services')) run(`carry_auto_merge_off ${oldName} ${newName}`);
    if (step.startsWith('remove')) {
      run(`carry_auto_merge_off ${oldName} ${newName}`);
      // instance-remove.sh: the registry's glob takes the old name's switches before its user goes.
      run(`rm -f "$POLICY_ROOT_DIR/${oldName}".auto-merge-*`);
    }
    assert.equal(autoMergeKilled(newName, T), false, `${step}: on before the OFF`);
    // With every create in root's directory failing: the new name's OFF uses its spare.
    const restore = fullDisk();
    try {
      setPolicy(oldName, 'auto_merge', 'off', `wl-${oldName}`, deps);
    } finally {
      restore();
    }
    // The old name too, where it still can be (inside its removal, with its spare gone and no room, it can't: parked).
    if (!step.startsWith('remove')) assert.equal(autoMergeKilled(oldName, T), true, step);
    assert.equal(autoMergeKilled(newName, T), true, `${step}: the instance that runs is off`);
    // The rename done (or aborted): the forward goes.
    assert.equal(run(`rename_forward_done ${oldName}`).status, 0);
    assert.equal(existsSync(join(T, `${oldName}.rename-to`)), false);
  }
  // instance-rename.sh writes it before its first step, and removes it after the last (the old name's removal) and on --abort.
  const rename = spawnSync('cat', [join(repoRoot, 'scripts', 'setup', 'instance-rename.sh')], { encoding: 'utf8' }).stdout;
  assert.match(rename, /\nrename_forward "\$old" "\$new"\n[\s\S]*?\nfor s in "\$\{STEPS\[@\]\}"; do run_step "\$s"; done\n[^\n]*\nrename_forward_done "\$old"\n/);
  assert.match(rename, /say "abort: [^\n]*\n[^\n]*\n {2}carry_auto_merge_off "\$new" "\$old"\n[\s\S]*?instance-remove\.sh" "\$new"[\s\S]*?rm -f "\$progress"\n {2}rename_forward_done "\$old"\n/, '--abort carries the OFF back to the old name before the new one goes, and ends the forward');
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

test("a temp file a root writer left (killed before its rename) is swept on root's next write there (#726 round 6)", { skip }, () => {
  const name = 'sweep';
  const m = machineInstance(name);
  ownPolicy(name, m.deps);
  const tmp = join(POLICY_ROOT_DIR, '.0123456789ab.auto-merge.tmp');
  writeFileSync(tmp, 'auto_merge off since then\n');
  const old = new Date(Date.now() - 600_000);
  utimesSync(tmp, old, old);
  const fresh = join(POLICY_ROOT_DIR, '.ba9876543210.auto-merge.tmp');
  writeFileSync(fresh, ''); // another writer's, in flight: kept
  setPolicy(name, 'auto_merge', 'off', null, m.deps);
  assert.equal(existsSync(tmp), false, 'the stale one is gone');
  assert.equal(existsSync(fresh), true, 'an in-flight one is kept');
});
