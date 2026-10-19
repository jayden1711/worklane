// Issue #726, principle 2 (the owner's): turning auto_merge OFF can never be blocked or undone. Root's kill switch
// (src/policy-kill.ts) against an admin's `set on` racing it, a crash part way, a full filesystem and a rename.
// Stand-ins only, as in test/policy-edit.test.ts: "root" is this test's own uid; no test runs as root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
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

test('repeated auto_merge OFFs (a coordinator looping the helper\'s set-policy) never add files to root\'s directory: one switch, moved to each new name, and the spare (#726 round 5 adversarial pass)', { skip }, () => {
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
