#!/usr/bin/env node
// CI only (the "test-run sandbox (real systemd)" job in .github/workflows/ci-slow.yml), as root, as the updater runs:
// an update whose test sandbox check passed before and fails after is rolled back, and the rollback puts every root
// helper back. The helpers are real root-owned files (each with its own group and mode) replaced by the updater's own
// syncHelpers; the two engines' copies are this checkout's scripts/machine files and a changed copy of each (the
// test-run helper speaking the next protocol). GitHub, the build, systemd and the instance's answers are stand-ins;
// the decision code, the file replacement and the helper's `version` are the real ones.
//   1. After the rollback every helper is byte for byte the old engine's, with the owner, group and mode it had,
//      back before the old engine restarts, and the helper on disk answers the old engine's protocol.
//   2. A helper that can't be put back: the engine still goes back, and the rollback's reason says so first.
//
//   sudo node updater-sandbox-root.mjs <path to worklane-update.cjs>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

assert.equal(process.getuid(), 0, 'run this as root, as the updater runs');
const updater = resolve(process.argv[2]);
const repo = resolve(dirname(updater), '..', '..');
const u = createRequire(import.meta.url)(updater);
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const show = 'User=wl-alice\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\nExecStart={ path=/usr/local/bin/worklane ; argv[]=/usr/local/bin/worklane coordinator run --instance alice ; ignore_errors=no }\n';

/** A machine dir with every helper in HELPERS installed (the old engine's copy), and both engines' trees. */
function world() {
  const root = mkdtempSync('/var/lib/wl-sandbox-');
  const libexec = join(root, 'libexec');
  mkdirSync(libexec, { mode: 0o755 });
  const helpers = u.HELPERS.map((h) => ({ ...h, dest: join(libexec, basename(h.dest)) }));
  const bytes = { [OLD]: {}, [NEW]: {} };
  let protocol = null;
  for (const h of u.HELPERS) {
    const own = readFileSync(join(repo, h.src));
    const isTestrun = /worklane-testrun\.sh$/.test(h.src);
    if (isTestrun) protocol = Number(/^PROTOCOL=(\d+)$/m.exec(own.toString('utf8'))[1]);
    const next = isTestrun ? Buffer.from(own.toString('utf8').replace(/^PROTOCOL=\d+$/m, `PROTOCOL=${protocol + 1}`)) : Buffer.concat([own, Buffer.from(h.check === 'node' ? "\n// the next engine's\n" : "\n# the next engine's\n")]);
    assert.ok(!own.equals(next), h.src);
    for (const [sha, b] of [[OLD, own], [NEW, next]]) {
      const f = join(root, 'opt', sha, h.src);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, b);
      bytes[sha][h.src] = b;
    }
  }
  // As the setup scripts leave them: root-owned, and each with a group and mode of its own to keep.
  const owners = [[0, 0, 0o755], [0, 1, 0o750], [0, 2, 0o555]];
  helpers.forEach((h, i) => {
    writeFileSync(h.dest, bytes[OLD][h.src]);
    chownSync(h.dest, owners[i % 3][0], owners[i % 3][1]);
    chmodSync(h.dest, owners[i % 3][2]);
  });
  const stat = () => helpers.map((h) => ((s) => `${basename(h.dest)} ${s.uid}:${s.gid} ${(s.mode & 0o7777).toString(8)}`)(statSync(h.dest)));
  const onDisk = (sha) => helpers.every((h) => readFileSync(h.dest).equals(bytes[sha][h.src]));
  const version = () => Number(execFileSync('bash', [helpers.find((h) => /testrun$/.test(h.dest)).dest, 'alice', 'version'], { encoding: 'utf8' }).trim());
  return { root, libexec, helpers, protocol, stat, onDisk, version };
}

/** One update from OLD to NEW on that machine: alice's sandbox check passed before and fails after the restart. */
async function update(w, afterRestart = () => {}) {
  let current = OLD;
  let restarted = null;
  let held = null;
  const logs = [];
  const order = [];
  const deps = {
    config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'] }),
    installed: () => current,
    exec: (f, args) => {
      if (f === 'git') return `${NEW}\trefs/heads/main\n`;
      if (f === 'systemctl' && args[0] === 'list-units') return 'worklane-alice.service loaded active running x\n';
      if (f === 'systemctl' && args[0] === 'show' && args[2] === 'User,Environment,ExecStart') return show;
      if (f === 'systemctl' && args[0] === 'show') return 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
      if (f === 'systemctl' && args[0] === 'restart') {
        order.push(`restart ${current.slice(0, 4)} beside ${w.onDisk(current) ? 'its own' : 'OTHER'} helpers`);
        if (current === NEW) restarted = Date.now();
        return '';
      }
      if (f === 'systemd-run' && args.includes('migrate')) return `${JSON.stringify({ ok: true, applied: [], made: [] })}\n`;
      return '';
    },
    fetchJson: async (url) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }] }),
    slots: () => [],
    alive: () => false,
    installTree: () => {},
    syncHelpers: (sha) => u.syncHelpers(join(w.root, 'opt', sha), w.helpers),
    switchTo: (s) => (current = s),
    now: () => Date.now(),
    sleep: async () => {},
    log: (e) => logs.push(e),
    held: () => held,
    hold: (e) => (held = e),
    configChangedAt: () => 0,
    note: (event, s, reason) => (logs.push({ event, to: s, reason }), event),
    sandboxStatus: () => {
      if (restarted === null) return { configured: true, last: { ok: true, detail: 'ok', at: new Date(Date.now() - 3600_000).toISOString() } };
      assert.ok(w.onDisk(NEW), "the install replaced every helper with the new engine's");
      assert.equal(w.version(), w.protocol + 1, "the helper on disk speaks the new engine's protocol");
      afterRestart();
      return { configured: true, last: { ok: false, detail: 'FAIL: the sandbox could not write its own /tmp (exit 226)', at: new Date(restarted + 1).toISOString() } };
    },
  };
  const result = await u.run(deps);
  return { result, current, held, order, rolledBack: logs.find((l) => l.event === 'rolled_back') };
}

const made = [];
try {
  // 1. The rollback puts every helper back.
  const w = world();
  made.push(w.root);
  const before = w.stat();
  assert.equal(w.version(), w.protocol);
  const r = await update(w);
  assert.equal(r.result, 'rolled_back');
  assert.equal(r.current, OLD);
  assert.equal(r.held.sha, NEW);
  assert.ok(w.onDisk(OLD), "every helper is byte for byte the old engine's copy");
  assert.deepEqual(w.stat(), before, 'owner, group and mode as before the update');
  assert.equal(w.version(), w.protocol, "the helper on disk answers the old engine's protocol");
  assert.deepEqual(r.order, ['restart bbbb beside its own helpers', 'restart aaaa beside its own helpers']);
  assert.deepEqual(r.rolledBack.helpers.map((h) => `${basename(h.path)} ${h.state}`).sort(), w.helpers.map((h) => `${basename(h.dest)} updated`).sort());
  assert.match(r.rolledBack.reason, /^rollback: the test sandbox check passed before the update and fails after it: alice: FAIL: /);
  console.log(before.join('\n'));
  console.log(JSON.stringify({ reason: r.rolledBack.reason, helpers: r.rolledBack.helpers.map((h) => basename(h.path)), order: r.order }));

  // 2. A helper that can't be put back (root isn't stopped by a mode: its temp file's name is taken by a directory).
  const w2 = world();
  made.push(w2.root);
  const first = w2.helpers[0];
  const r2 = await update(w2, () => mkdirSync(join(w2.libexec, `.${basename(first.dest)}.update${first.check === 'node' ? '.cjs' : ''}`), { recursive: true }));
  assert.equal(r2.result, 'rolled_back');
  assert.equal(r2.current, OLD, 'the engine still goes back');
  assert.ok(!w2.onDisk(OLD), "not every helper is the old engine's");
  assert.match(r2.rolledBack.reason, /^rollback: the old engine's root helpers could NOT be put back \(/);
  assert.match(r2.held.failed[0], /could NOT be put back/);
  assert.ok(r2.rolledBack.helpers_error);
  console.log(JSON.stringify({ reason: r2.rolledBack.reason.slice(0, 300) }));
  console.log(`OK: as root, the sandbox rollback put all ${w.helpers.length} helpers back (bytes, owner, group, mode, protocol ${w.protocol}); one that couldn't go back is the first thing its reason says`);
} finally {
  for (const d of made) rmSync(d, { recursive: true, force: true });
}
